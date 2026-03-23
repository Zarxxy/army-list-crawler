# Listhammer — Death Guard Meta Analyser & Army Optimizer

Automated pipeline that crawls [listhammer.info](https://listhammer.info) for Death Guard tournament army lists, analyses the meta, and generates a recommended competitive army list — all deployed to a GitHub Pages dashboard.

## How It Works

```
Crawl listhammer.info  →  Generate meta report  →  Run army optimizer  →  Build & deploy site
     (crawler.js)            (report.js)             (optimizer.js)        (build-site.js)
```

1. **Crawler** — Playwright-based headless browser scrapes tournament results, extracting player names, detachments, records, events, and full army list text
2. **Meta Report** — Analyses detachment popularity, win rates, undefeated lists, player rankings, and record distributions
3. **Army Optimizer** — Finds the most meta-representative winning army list and recommends it as a concrete ~2000pt build, with unit synergy analysis
4. **Site Builder** — Inlines report JSON into a self-contained HTML dashboard for GitHub Pages

The pipeline runs daily via GitHub Actions.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- npm

## Setup

```bash
git clone https://github.com/Zarxxy/Claude.git
cd Claude
npm install
npx playwright install chromium
```

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
  *.txt                           # Text versions of each report

docs/
  index.html                      # GitHub Pages dashboard (self-contained)
  template.html                   # Source template
  data/                           # Raw JSON copies for direct access
```

## What the Dashboard Shows

- **Overview** — Detachment popularity/win rate bars, summary cards, record distribution
- **Detachments** — Full W/L/D breakdown table, undefeated lists
- **Optimizer** — Concrete recommended army list (~2000pts) based on the best-performing tournament list, unit synergy pairings, enhancement usage
- **Players** — Top players ranked by win rate with detachment and event info
- **Events** — Per-event detachment breakdown with W/L stats

## How the Optimizer Works

The optimizer analyses all parsed army lists from winning players and:

1. **Scores every list** by how well it represents the current meta (sum of unit appearance frequencies)
2. **Picks the best template** — preferring undefeated lists, then top-performing lists with the highest meta-alignment score
3. **Categorises units** into Core (40%+ appearance), Common (20-39%), and Flex (<20%) tiers
4. **Analyses unit synergies** — which units most frequently appear together in winning lists
5. **Tracks enhancement usage** — most popular enhancements across winning lists

If no parseable army list text is available, it falls back to synthesising a list from the most popular units.

## GitHub Actions

The workflow (`.github/workflows/main.yml`) runs daily at 06:00 UTC and on push:

1. Install dependencies + Playwright
2. Crawl listhammer.info for Death Guard lists
3. Generate meta report
4. Run army optimizer
5. Build and deploy site to GitHub Pages

Debug artifacts (raw crawl output) are uploaded on every run.

## Troubleshooting

Check `output/` for debug files if the crawler fails:
- `error-screenshot.png` — page state at failure
- `error-page.html` — raw HTML dump

## Disclaimer

Listhammer.info's `robots.txt` allows general crawling (`Allow: /`) but disallows AI training (`ai-train=no`). This tool:
- Uses a standard Chrome user agent
- Is for **personal meta analysis only**, not AI training or republishing
- Respects rate limits via the `--delay` option

## License

[ISC](LICENSE)
