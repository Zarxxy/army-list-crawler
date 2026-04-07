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
4. **AI Analysis** — Sends the tournament data to Claude (`claude-opus-4-6`) via the Anthropic API and generates a natural-language meta summary, detachment tier list, best list breakdown, strategic advice, and meta trends
5. **Site Builder** — Inlines all report JSON into a self-contained HTML dashboard for GitHub Pages

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- npm
- An [Anthropic API key](https://console.anthropic.com/) (for the AI analysis step)

## Setup

```bash
git clone https://github.com/Zarxxy/Claude.git
cd Claude
npm install
npx playwright install chromium
```

### API Key

The AI analysis step requires `ANTHROPIC_API_KEY`. For local runs:

```bash
ANTHROPIC_API_KEY=sk-ant-... node ai-analysis.js
```

For GitHub Actions, add `ANTHROPIC_API_KEY` as a repository secret (Settings → Secrets → Actions).

If the key is not set the step is skipped gracefully and the rest of the pipeline continues normally.

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
node ai-analysis.js --model claude-opus-4-6 --max-tokens 8192
```

| Option | Description | Default |
|---|---|---|
| `--lists PATH` | Crawler JSON file | `output/army-lists-latest.json` |
| `--report PATH` | Meta report JSON | `reports/meta-report-latest.json` |
| `--optimizer PATH` | Optimizer JSON | `reports/optimizer-latest.json` |
| `--output DIR` | Output directory | `reports/` |
| `--model NAME` | Claude model to use | `claude-opus-4-6` |
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

The workflow (`.github/workflows/main.yml`) runs on push to the main branch and can be triggered manually from the Actions tab (no automatic schedule).

**Jobs:**

1. **Test** — runs on every push to every branch; executes all 46 tests via `node:test`
2. **Crawl & Deploy** — runs on push to the deploy branch or manual trigger:
   - Crawl listhammer.info for Death Guard lists
   - Generate meta report
   - Run army optimizer
   - Generate AI analysis (requires `ANTHROPIC_API_KEY` secret)
   - Build and deploy to GitHub Pages

Debug artifacts (raw crawl output) are uploaded on every run.

## Running Tests

```bash
npm test
```

46 tests across 4 suites (`test-report`, `test-optimizer`, `test-ai-analysis`, `test-build-site`) using the built-in `node:test` runner — no extra dependencies required.

## Troubleshooting

Check `output/` for debug files if the crawler fails:
- `error-screenshot.png` — page state at failure
- `error-page.html` — raw HTML dump

If the AI Analysis tab shows "could not be parsed correctly", check the GitHub Actions log for the `Generate AI meta analysis` step — it will show the `stop_reason` and the first/last characters of Claude's raw response.

## Disclaimer

Listhammer.info's `robots.txt` allows general crawling (`Allow: /`) but disallows AI training (`ai-train=no`). This tool:
- Uses a standard Chrome user agent
- Is for **personal meta analysis only**, not AI training or republishing
- Respects rate limits via the `--delay` option

## License

[ISC](LICENSE)
