# Listhammer — Death Guard Meta Analyser

Automated pipeline that crawls [listhammer.info](https://listhammer.info) for Death Guard tournament army lists, runs statistical meta analysis, generates AI-powered per-list and per-detachment characterizations using Claude, and deploys a GitHub Pages dashboard.

## How It Works

```
Crawl listhammer.info  →  Meta report  →  Army optimizer  →  AI analysis  →  Build & deploy site
     (crawler.js)         (report.js)      (optimizer.js)   (ai-analysis.js)   (build-site.js)
```

1. **Crawler** — Playwright-based headless browser scrapes tournament results, extracting player names, detachments, records, events, and full army list text. Stamps every entry with `firstSeen`/`lastSeen` timestamps and saves a previous-crawl copy for diff tracking.
2. **Meta Report** — Analyses detachment popularity, record distributions, and event breakdowns. Computes a `crawlDiff` (new lists, dropped lists, new tech choices) when a previous crawl file is present. Groups lists by detachment for downstream use.
3. **Army Optimizer** — Produces per-detachment unit/enhancement frequency tables, variance analysis (contested choices, 20–79% inclusion), novelty flags (tech not seen in the previous crawl), unit co-occurrence pairs, and overall unit/enhancement frequency across all lists.
4. **AI Analysis** — Sends the tournament data to Claude via the Anthropic API and generates: per-list characterizations (archetype, game plan, tech diffs), per-detachment summaries (archetypes, core units, contested picks), cross-detachment patterns, and a crawl diff summary. The model and word limits are configured in `config.json`.
5. **Site Builder** — Inlines all four report JSON payloads into a self-contained HTML dashboard for GitHub Pages. Also copies raw JSON to `docs/data/` and generates `llms.txt` / `llms-full.txt` for LLM-readable access.

## Dataset Context

> **Important:** This pipeline analyses **top-finishing tournament lists only** (1st and 2nd place results).
> This dataset does **not** represent the general player field and must **not** be used to infer win rates,
> comparative skill, or matchup probabilities. All frequency figures compare lists *within* this dataset only.

## Dashboard

The GitHub Pages site has three tabs:

- **Lists** — All lists, sortable by date or event size. Expandable cards show the full army list text, an AI archetype label and game-plan summary, novelty badges for tech not seen in the previous crawl, and a checkbox for side-by-side comparison of two lists.
- **By Detachment** — Lists grouped by detachment. Each group shows the AI detachment summary, a unit/enhancement frequency table, a variance section (contested picks), a novelty section (new tech), and collapsible list cards.
- **Patterns** — AI cross-detachment analysis prose and a crawl-diff summary (what is new or dropped since the last crawl).

A diff banner at the top shows new/dropped list counts and new tech choices whenever a crawl diff is available.

## Configuration

Key settings live in `config.json` at the repo root:

- `crawler.baseUrl` — target site URL
- `crawler.knownFactionPatterns` — strings used to identify faction names
- `crawler.knownDetachments` — known detachment names for field disambiguation
- `aiAnalysis.defaultModel` — Claude model for AI analysis (overridable via `--model`)
- `aiAnalysis.maxTokens` — max tokens for the AI response
- `aiAnalysis.outputLimits` — per-section word limits injected into the AI prompt:
  - `wordsPerList` — game plan word cap per list (default: 80)
  - `wordsPerDetachmentSummary` — word cap per detachment summary (default: 150)
  - `wordsCrossDetachment` — word cap for cross-detachment patterns (default: 200)
  - `wordsCrawlDiff` — word cap for crawl diff prose (default: 100)

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- npm
- An [Anthropic API key](https://console.anthropic.com/) (for the AI analysis step)

## Setup

```bash
git clone https://github.com/Zarxxy/army-list-crawler.git
cd army-list-crawler
npm install
npx playwright install chromium
```

### API Key

The AI analysis step requires `ANTHROPIC_API_KEY`. For local runs:

```bash
ANTHROPIC_API_KEY=sk-ant-... node ai-analysis.js
```

For GitHub Actions, add `ANTHROPIC_API_KEY` as a repository secret (Settings → Secrets → Actions).

If the key is not set the step is skipped gracefully and the rest of the pipeline continues. The dashboard will show an "AI analysis not available" message where AI content would appear.

## Usage

### Crawl

```bash
# Crawl Death Guard lists (default config)
npm run crawl:dg

# Crawl with custom options
node crawler.js --game 40k --faction "Death Guard" --delay 2000

# Show browser window for debugging
node crawler.js --game 40k --faction "Death Guard" --no-headless
```

| Option | Description | Default |
|---|---|---|
| `--game 40k\|aos` | Game system filter | both |
| `--faction NAME` | Faction filter (case-insensitive) | all |
| `--max-pages N` | Max pages per section (0 = unlimited) | `0` |
| `--delay N` | Milliseconds between requests | `1500` |
| `--no-headless` | Show browser window | headless |

> **Note:** The crawler exits with code 1 if it finds 0 army lists, which will fail the CI pipeline. Check debug artifacts in `output/` if this happens.

### Meta Report

```bash
npm run report          # JSON + text output
npm run report:json     # JSON only
npm run report:text     # Text only
```

| Option | Description | Default |
|---|---|---|
| `--input PATH` | Crawler JSON file | `output/army-lists-latest.json` |
| `--previous PATH` | Previous crawl file (for crawl diff) | `output/army-lists-previous.json` |
| `--output DIR` | Output directory | `reports/` |
| `--format FORMAT` | `json`, `text`, or `all` | `all` |

> **Note:** `report.js` exits with code 1 if the input file does not exist. Run `npm run crawl:dg` first.

### Army Optimizer

```bash
npm run optimize        # JSON + text output
npm run optimize:json   # JSON only
```

| Option | Description | Default |
|---|---|---|
| `--lists PATH` | Crawler JSON file | `output/army-lists-latest.json` |
| `--previous PATH` | Previous crawl file (for novelty flags) | `output/army-lists-previous.json` |
| `--output DIR` | Output directory | `reports/` |
| `--format FORMAT` | `json`, `text`, or `all` | `all` |

### AI Analysis

```bash
npm run ai-analysis
# or with options:
node ai-analysis.js --model claude-opus-4-6 --max-tokens 8192
```

| Option | Description | Default |
|---|---|---|
| `--lists PATH` | Crawler JSON file | `output/army-lists-latest.json` |
| `--report PATH` | Meta report JSON | `reports/meta-report-latest.json` |
| `--optimizer PATH` | Optimizer JSON | `reports/optimizer-latest.json` |
| `--output DIR` | Output directory | `reports/` |
| `--model NAME` | Claude model to use | from `config.json` |
| `--max-tokens N` | Max output tokens | from `config.json` |

### Build Site

```bash
npm run build-site      # Build docs/index.html
npm run build-all       # Report + optimizer + site in one step
```

## Output Structure

```
output/
  army-lists-latest.json          # Most recent crawl data (with firstSeen/lastSeen)
  army-lists-previous.json        # Previous crawl (copied before each new crawl)
  army-lists-<timestamp>.json     # Archived crawls

reports/
  meta-report-latest.json         # Detachment stats, record distribution, crawl diff
  optimizer-latest.json           # Unit/enhancement frequency, variance, novelty flags
  ai-analysis-latest.json         # Per-list characterizations, detachment summaries, patterns
  *.txt                           # Text versions of each report

docs/
  index.html                      # GitHub Pages dashboard (self-contained)
  template.html                   # Source template
  data/
    meta-report.json              # Copy of latest meta report (for direct access)
    optimizer.json                # Copy of latest optimizer report
    ai-analysis.json              # Copy of latest AI analysis
    army-lists.json               # Copy of latest army lists
  llms.txt                        # LLM-readable site overview and data links
  llms-full.txt                   # Full concatenated plain-text reports for LLMs
```

## GitHub Actions

The workflow (`.github/workflows/main.yml`) runs automatically on push to `main`, on a weekly schedule (Sundays at 06:00 UTC), and can be triggered manually from the Actions tab.

**Jobs:**

1. **Test** — runs on every push to every branch; lints with ESLint and executes all tests via `node:test`
2. **Crawl & Deploy** — runs on push to `main`, weekly schedule, or manual trigger:
   - Crawl listhammer.info for Death Guard lists (exits with error if 0 lists found)
   - Generate meta report (with crawl diff against previous crawl)
   - Run army optimizer (with novelty flags against previous crawl)
   - Generate AI analysis (requires `ANTHROPIC_API_KEY` secret; skipped gracefully if missing)
   - Build and deploy to GitHub Pages

Debug artifacts (raw crawl output) are uploaded on every run and retained for 7 days.

## Running Tests

```bash
npm test
```

Tests across 5 suites (`test-crawler`, `test-report`, `test-optimizer`, `test-ai-analysis`, `test-build-site`) using the built-in `node:test` runner — no extra dependencies required.

## Linting

```bash
npm run lint
```

Uses ESLint with Node.js/ES2022 rules. Configuration is in `.eslintrc.json`.

## Troubleshooting

**Crawler finds 0 lists:**
- Check `output/error-screenshot.png` and `output/error-page.html` for the page state at failure
- The crawler exits with code 1 when 0 lists are found, which will fail the CI pipeline — this is intentional so the deploy doesn't silently overwrite the dashboard with empty data
- Try running with `--no-headless` locally to observe the browser behaviour

**Report fails with "Input file not found":**
- Run `npm run crawl:dg` first to generate `output/army-lists-latest.json`

**AI content not showing in dashboard:**
- Ensure `ANTHROPIC_API_KEY` is set (locally or as a GitHub Actions secret)
- Check the Actions log for the `Generate AI meta analysis` step — it logs the `stop_reason` and start of the raw response if parsing fails

**AI response parsing error:**
- The script retries once automatically on parse failure
- Check the Actions log — it shows `stop_reason` and the first 500 chars of the raw response

## Disclaimer

Listhammer.info's `robots.txt` allows general crawling (`Allow: /`) but disallows AI training (`ai-train=no`). This tool:
- Uses a standard Chrome user agent
- Is for **personal meta analysis only**, not AI training or republishing
- Respects rate limits via the `--delay` option

## License

[ISC](LICENSE)
