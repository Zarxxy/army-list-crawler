# Listhammer Army Lists Crawler & Meta Report

Headless browser crawler for [listhammer.info](https://listhammer.info) that extracts Warhammer 40k and Age of Sigmar tournament army lists, saves them to JSON, and generates extensive meta analysis reports.

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

```bash
# Crawl all sections (40k + AoS)
npm run crawl

# Crawl only Warhammer 40k lists
npm run crawl:40k

# Crawl only Age of Sigmar lists
npm run crawl:aos
```

### CLI Options

| Option | Description | Default |
|---|---|---|
| `--game 40k\|aos` | Filter to a single game system | both |
| `--faction NAME` | Only keep lists matching a faction (case-insensitive substring) | all |
| `--max-pages N` | Limit number of pages to crawl per section (0 = unlimited) | `0` |
| `--delay N` | Milliseconds to wait between requests | `1500` |
| `--no-headless` | Show the browser window (useful for debugging) | headless |

**Examples:**

```bash
# Crawl 40k lists, max 3 pages, with visible browser
node crawler.js --game 40k --max-pages 3 --no-headless

# Crawl AoS lists with a longer delay between requests
node crawler.js --game aos --delay 3000

# Only grab Tyranids lists
node crawler.js --faction Tyranids

# Combine filters: 40k Space Marines lists only
node crawler.js --game 40k --faction "Space Marines"

# AoS Stormcast lists
node crawler.js --game aos --faction Stormcast
```

### Using a Custom Chrome/Chromium

If you want to use an existing browser installation instead of the Playwright-managed one:

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run crawl
```

## Output

Results are saved to the `output/` directory:

- `army-lists-latest.json` — always points to the most recent crawl
- `army-lists-<timestamp>.json` — timestamped archive of each run

### JSON Structure

```json
{
  "crawledAt": "2026-03-22T12:00:00.000Z",
  "source": "https://listhammer.info",
  "totalLists": 42,
  "sections": {
    "40k Lists": [
      {
        "playerName": "John Doe",
        "faction": "Tyranids",
        "event": "Grand Tournament 2026",
        "record": "5-0",
        "date": "2026-03-15",
        "detailUrl": "https://listhammer.info/list/123",
        "armyListText": "++ Army Roster (Warhammer 40,000) [2000pts] ++\n..."
      }
    ],
    "AoS Lists": [
      ...
    ]
  }
}
```

## Meta Report

After crawling, generate an extensive meta analysis report from the JSON data.

```bash
# Generate all formats (text + JSON + HTML)
npm run report

# Single format
npm run report:json
npm run report:html
npm run report:text
```

### Report CLI Options

| Option | Description | Default |
|---|---|---|
| `--input PATH` | Path to the crawler JSON file | `output/army-lists-latest.json` |
| `--output DIR` | Directory to write reports to | `reports/` |
| `--format FORMAT` | Output format: `json`, `html`, `text`, or `all` | `all` |
| `--top N` | Number of top players to include | `20` |

**Examples:**

```bash
# Report from a specific crawl file
node report.js --input output/army-lists-2026-03-22T12-00-00-000Z.json

# Only HTML report, top 50 players
node report.js --format html --top 50
```

### What the Report Includes

- **Faction Representation** — list counts, percentage share per faction
- **Faction Win Rates** — wins, losses, draws, total games, win% sorted by performance
- **Undefeated Lists** — every X-0 list with player, faction, event, and record
- **Record Distribution** — histogram of all W-L-D records with visual bars
- **Top Players** — ranked by win rate with their factions and events
- **Detachment Popularity** — which detachments are most played and by which factions
- **Event Breakdown** — per-event faction distribution and top faction
- **Points Analysis** — min/max/median/mean points with a distribution histogram

### Report Output

Reports are saved to the `reports/` directory:

- `meta-report-latest.json` — structured data for programmatic use
- `meta-report-latest.html` — styled dashboard you can open in a browser
- `meta-report-latest.txt` — terminal-friendly text tables
- Timestamped copies of each are also saved as archives

The HTML report is a self-contained dark-themed dashboard with bar charts, sortable tables, and summary cards — no external dependencies needed, just open it in any browser.

## Troubleshooting

If the crawler fails, check the `output/` directory for:

- `error-screenshot.png` — screenshot of the page at the time of failure
- `error-page.html` — raw HTML dump for inspecting the DOM

If the site's layout has changed, you may need to update the CSS selectors in these functions inside `crawler.js`:

- `extractListEntries()` — selectors for list pages
- `crawlListDetail()` — selectors for individual army list detail pages

## Disclaimer & robots.txt Compliance

Listhammer.info's `robots.txt` (Cloudflare-managed) states:

- **`Allow: /`** for general user agents — crawling the site is permitted
- **`Content-Signal: search=yes, ai-train=no`** — content may be indexed for search, but **must not be used for AI training or fine-tuning**
- Specific AI crawlers (GPTBot, ClaudeBot, CCBot, etc.) are blocked by user agent

This tool uses a standard Chrome browser user agent and is **not** one of the blocked AI bots. However, please respect the following:

1. **Do not use scraped data for AI training** — The site explicitly disallows this via `ai-train=no`. Do not feed the output into model training or fine-tuning pipelines.
2. **Personal analysis only** — The army list content belongs to the players and/or listhammer.info. This tool is meant for personal meta analysis, not republishing.
3. **Be polite** — Use the `--delay` option to avoid overwhelming the server. The default 1500ms delay is a reasonable starting point.
4. **Respect terms of service** — If the site updates its ToS or `robots.txt` to restrict scraping, stop using this tool against it.

The authors of this tool are not responsible for misuse.

## License

[ISC](LICENSE)
