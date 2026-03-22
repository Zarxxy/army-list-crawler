# Listhammer Army Lists Crawler

Headless browser crawler for [listhammer.info](https://listhammer.info) that extracts Warhammer 40k and Age of Sigmar tournament army lists and saves them to JSON.

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
| `--max-pages N` | Limit number of pages to crawl per section (0 = unlimited) | `0` |
| `--delay N` | Milliseconds to wait between requests | `1500` |
| `--no-headless` | Show the browser window (useful for debugging) | headless |

**Examples:**

```bash
# Crawl 40k lists, max 3 pages, with visible browser
node crawler.js --game 40k --max-pages 3 --no-headless

# Crawl AoS lists with a longer delay between requests
node crawler.js --game aos --delay 3000
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

## Troubleshooting

If the crawler fails, check the `output/` directory for:

- `error-screenshot.png` — screenshot of the page at the time of failure
- `error-page.html` — raw HTML dump for inspecting the DOM

If the site's layout has changed, you may need to update the CSS selectors in these functions inside `crawler.js`:

- `extractListEntries()` — selectors for list pages
- `crawlListDetail()` — selectors for individual army list detail pages
