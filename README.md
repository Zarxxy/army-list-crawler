# Listhammer — Death Guard Meta Analyser & Army Optimizer

Automated pipeline that crawls [listhammer.info](https://listhammer.info) for Death Guard tournament army lists, analyses the meta, generates an AI-powered meta report using Claude, and deploys a GitHub Pages dashboard.

## How It Works

```
Crawl listhammer.info  →  Meta report  →  Army optimizer  →  AI analysis  →  Build & deploy site
     (crawler.js)         (report.js)      (optimizer.js)   (ai-analysis.js)   (build-site.js)
```

1. **Crawler** — Playwright-based headless browser scrapes tournament results, extracting player names, detachments, records, events, and full army list text
2. **Meta Report** — Analyses detachment popularity, win rates, undefeated lists, player rankings, and record distributions
3. **Army Optimizer** — Finds the most meta-representative winning list and recommends a concrete ~2000pt build, with unit synergy analysis
4. **AI Analysis** — Sends the tournament data to Claude via the Anthropic API and generates a natural-language meta summary, detachment tier list, best list breakdown, strategic advice, and meta trends. The model is configured in `config.json` (default: `claude-opus-4-5`)
5. **Site Builder** — Inlines all report JSON into a self-contained HTML dashboard for GitHub Pages

## Configuration

Key settings live in `config.json` at the repo root:

- `crawler.baseUrl` — target site URL
- `crawler.knownFactionPatterns` — regex strings used to identify faction names
- `crawler.knownDetachments` — list of known detachment names for field disambiguation
- `aiAnalysis.defaultModel` — Claude model used for AI analysis (overridable via `--model`)
- `aiAnalysis.maxTokens` — max tokens for the AI response

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

If the key is not set the step is skipped gracefully and the rest of the pipeline continues normally. The dashboard will show an "AI analysis not available" message in the AI tab.

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
| `--output DIR` | Output directory | `reports/` |
| `--format FORMAT` | `json`, `text`, or `all` | `all` |
| `--top N` | Number of top players | `20` |

> **Note:** `report.js` exits with code 1 if the input file does not exist. Run `npm run crawl:dg` first.

### Army Optimizer

```bash
npm run optimize        # JSON + text output
npm run optimize:json   # JSON only
```

| Option | Description | Default |
|---|---|---|
| `--lists PATH` | Crawler JSON file | `output/army-lists-latest.json` |
| `--report PATH` | Meta report JSON | `reports/meta-report-latest.json` |
| `--output DIR` | Output directory | `reports/` |
| `--format FORMAT` | `json`, `text`, or `all` | `all` |
| `--points N` | Target army points | `2000` |

### AI Analysis

```bash
npm run ai-analysis
# or with options:
node ai-analysis.js --model claude-opus-4-5 --max-tokens 8192
```

| Option | Description | Default |
|---|---|---|
| `--lists PATH` | Crawler JSON file | `output/army-lists-latest.json` |
| `--report PATH` | Meta report JSON | `reports/meta-report-latest.json` |
| `--optimizer PATH` | Optimizer JSON | `reports/optimizer-latest.json` |
| `--output DIR` | Output directory | `reports/` |
| `--model NAME` | Claude model to use | `claude-opus-4-5` (from `config.json`) |
| `--max-tokens N` | Max output tokens | `8192` |

### Build Site

```bash
npm run build-site      # Build docs/index.html
npm run build-all       # Report + optimizer + site in one step
```

## Output Structure

```
output/
  army-lists-latest.json          # Most recent crawl data
  army-lists-<timestamp>.json     # Archived crawls

reports/
  meta-report-latest.json         # Detachment stats, player rankings, etc.
  optimizer-latest.json           # Recommended army list + analysis
  ai-analysis-latest.json         # Claude AI meta analysis
  *.txt                           # Text versions of each report

docs/
  index.html                      # GitHub Pages dashboard (self-contained)
  template.html                   # Source template
```

## What the Dashboard Shows

- **Overview** — Detachment popularity/win rate bars, summary cards, record distribution
- **AI Analysis** — Claude-generated meta summary, detachment tier list (S/A/B/C), best list breakdown, strategic tips, and meta trends
- **Detachments** — Full W/L/D breakdown table, undefeated lists
- **Optimizer** — Concrete recommended army list (~2000pts), unit synergy pairings, enhancement usage
- **Players** — Top players ranked by win rate with detachment and event info
- **Events** — Per-event detachment breakdown with W/L stats

## GitHub Actions

The workflow (`.github/workflows/main.yml`) runs automatically on push to `main`, on a weekly schedule (Sundays at 06:00 UTC), and can be triggered manually from the Actions tab.

**Jobs:**

1. **Test** — runs on every push to every branch; lints with ESLint and executes all tests via `node:test`
2. **Crawl & Deploy** — runs on push to `main`, weekly schedule, or manual trigger:
   - Crawl listhammer.info for Death Guard lists (exits with error if 0 lists found)
   - Generate meta report
   - Run army optimizer
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

**AI Analysis tab is empty or shows "not available":**
- Ensure `ANTHROPIC_API_KEY` is set (locally or as a GitHub Actions secret)
- Check the Actions log for the `Generate AI meta analysis` step — it logs the `stop_reason` and start/end of Claude's raw response if parsing fails

**AI response parsing error ("could not be parsed correctly"):**
- Check the GitHub Actions log for the `Generate AI meta analysis` step — it will show the `stop_reason` and the first/last characters of Claude's raw response

## Disclaimer

Listhammer.info's `robots.txt` allows general crawling (`Allow: /`) but disallows AI training (`ai-train=no`). This tool:
- Uses a standard Chrome user agent
- Is for **personal meta analysis only**, not AI training or republishing
- Respects rate limits via the `--delay` option

## License

[ISC](LICENSE)
