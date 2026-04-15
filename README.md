# Listhammer — Death Guard Meta Analyser

Automated pipeline that crawls [listhammer.info](https://listhammer.info) for Death Guard tournament army lists, runs statistical meta analysis, generates AI-powered characterizations using Claude, and deploys a GitHub Pages dashboard.

## How It Works

```
Rules Fetcher  →  Rules Parser ─────────────────────────────────────┐
(rules-fetcher.js) (parse-rules.js)                                 │ rules context
                                                                     ▼
Crawl  →  Meta Report  →  Army Optimizer  →  Enrich Rules  →  AI Analysis  →  Build & Deploy
(crawler.js) (report.js)  (optimizer.js)  (enrich-rules.js) (ai-analysis.js) (build-site.js)
```

1. **Rules Fetcher** — Scrapes Death Guard datasheets, detachment rules, stratagems, and enhancements from wahapedia.ru and caches them in `rules/`. Runs on its own weekly schedule (Saturdays) so fresh rules are always available for the Sunday crawl. Skipped automatically if the cached copy is less than 7 days old.

2. **Rules Parser** — Post-processes the raw JSON from the Rules Fetcher. Applies deterministic filtering (Forge World units, summoned daemon allies), deduplicates units/detachments/stratagems/enhancements by name, validates required fields, and regenerates the plain-text file consumed by AI Analysis. Runs immediately after the fetcher in the same workflow so the two steps are cleanly separated: the fetcher gets the data, the parser makes it correct.

3. **Crawler** — Playwright-based headless browser scrapes tournament results from listhammer.info, extracting player names, detachments, records, events, and full army list text. Before each crawl it copies the existing `army-lists-latest.json` to `army-lists-previous.json` and preserves `firstSeen` timestamps for entries that persist across crawls.

4. **Meta Report** — Analyses detachment popularity, record distributions, and event breakdowns. Computes a `crawlDiff` (new lists, dropped lists, new tech choices) when a previous crawl file is present. Groups lists by detachment for downstream use.

5. **Army Optimizer** — Produces per-detachment unit/enhancement frequency tables, variance analysis (contested choices at 20–79% inclusion), novelty flags (tech not seen in the previous crawl), unit co-occurrence pairs, and overall unit/enhancement frequency across all lists.

6. **Enrich Rules** — Cross-references the parsed rules JSON with optimizer output to produce a unified enriched dataset. Merges unit keywords, stats, and points from rules with tournament frequency and co-occurrence data from the optimizer. Structures detachments with parsed stratagems (including target keywords) and enhancements. Identifies "unseen" units that exist in the rules but never appeared in tournament data. The enriched output powers the Build Advisor tab in the dashboard.

7. **AI Analysis** — Sends tournament data to Claude via the Anthropic API and generates: per-list characterizations (archetype, game plan, tech diffs), per-detachment summaries (archetypes, core units, contested picks), cross-detachment patterns, and a crawl diff summary. If a rules document is present in `rules/`, it is included in the system prompt via prompt caching for game-context accuracy.

8. **Site Builder** — Inlines all report JSON payloads into a self-contained HTML dashboard for GitHub Pages. Also copies raw JSON to `docs/data/` and generates `llms.txt` / `llms-full.txt` for LLM-readable access.

## Dataset Context

> **Important:** This pipeline analyses **top-finishing tournament lists only** (1st and 2nd place results).
> This dataset does **not** represent the general player field and must **not** be used to infer win rates,
> comparative skill, or matchup probabilities. All frequency figures compare lists *within* this dataset only.

## Dashboard

The GitHub Pages site has four tabs:

- **Lists** — All lists, sortable by date or event size. Expandable cards show the full army list text, an AI archetype label and game-plan summary, novelty badges for tech not seen in the previous crawl, and a checkbox for side-by-side comparison of two lists.
- **By Detachment** — Lists grouped by detachment. Each group shows the AI detachment summary, a unit/enhancement frequency table, a variance section (contested picks), a novelty section (new tech), and collapsible list cards.
- **Patterns** — AI cross-detachment analysis prose and a crawl-diff summary (what is new or dropped since the last crawl).
- **Build Advisor** — Interactive tool for exploring the meta by detachment. Shows per-detachment unit frequency, stratagem relevance (which stratagems apply to which units based on target keywords), enhancement options, and units that exist in the rules but have never appeared in tournament data ("unseen units"). Powered by enriched rules data.

A diff banner at the top shows new/dropped list counts and new tech choices whenever a crawl diff is available.

## Configuration

All key settings live in `config.json` at the repo root:

**`crawler`**
- `baseUrl` — target site URL
- `knownFactionPatterns` — strings used to identify faction names in list text
- `knownDetachments` — known detachment names for field disambiguation
- `timeouts` — Playwright/navigation timeouts (all in ms):
  - `NAV_TIMEOUT_MS` — max time to wait for page navigation (default: `60000`)
  - `JS_RENDER_WAIT_MS` — wait for SPA framework to render (default: `3000`)
  - `CF_CHALLENGE_WAIT_MS` — wait for Cloudflare challenge to resolve (default: `10000`)
  - `SELECTOR_TIMEOUT_MS` — wait for content selector to appear (default: `10000`)
  - `SCROLL_SETTLE_MS` — pause between scroll steps (default: `500`)
  - `DEFAULT_DELAY_MS` — default delay between requests (default: `1500`)

**`aiAnalysis`**
- `defaultModel` — Claude model (default: `claude-opus-4-6`, overridable via `--model`)
- `maxTokens` — max tokens for the AI response (default: `8192`)
- `outputLimits` — per-section word limits injected into the AI prompt:
  - `wordsPerList` — game plan word cap per list (default: `80`)
  - `wordsPerDetachmentSummary` — word cap per detachment summary (default: `150`)
  - `wordsCrossDetachment` — word cap for cross-detachment patterns (default: `200`)
  - `wordsCrawlDiff` — word cap for crawl diff prose (default: `100`)

**`rulesFetcher`**
- `wahapediaBase` — base URL for wahapedia.ru (default: `https://wahapedia.ru`)
- `defaultFaction` — faction slug to fetch (default: `death-guard`)
- `defaultEdition` — edition string (default: `10ed`)
- `freshnessDays` — how many days before a cached rules file is considered stale (default: `7`)
- `maxTxtChars` — max characters written to the `.txt` rules file (default: `180000`)
- `forgeWorldSlugs` — list of wahapedia URL slugs to exclude from the rules output (Forge World, Horus Heresy legacy, Kill Team units). Add new entries here when wahapedia lists new non-competitive units on a faction page. Used by both `rules-fetcher.js` (skip scraping) and `parse-rules.js` (post-processing filter).

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

### Rules Fetcher

```bash
npm run fetch-rules           # Fetch if stale (>7 days old)
npm run fetch-rules:force     # Force re-fetch regardless of age
```

| Option | Description | Default |
|---|---|---|
| `--faction NAME` | Faction slug | `death-guard` |
| `--edition EDITION` | Rules edition | `10ed` |
| `--output DIR` | Output directory | `rules/` |
| `--delay N` | Milliseconds between page fetches | `2000` |
| `--max-units N` | Limit units scraped (0 = all) | `0` |
| `--force` | Re-fetch even if fresh | off |
| `--no-headless` | Show browser window | headless |
| `--dump-html` | Save HTML debug dumps to `rules/` | off |

> **Note:** Rules are automatically fetched by the `fetch-rules.yml` workflow every Saturday at 05:00 UTC — the day before the Sunday army-list crawl — so fresh rules are always available for AI analysis.

### Rules Parser

```bash
npm run parse-rules           # Post-process rules/death-guard-latest.json in place
npm run parse-rules:dry       # Log filtering stats without writing any files
```

| Option | Description | Default |
|---|---|---|
| `--input PATH` | JSON file to read | `rules/<faction>-latest.json` |
| `--output PATH` | JSON file to write (also regenerates `.txt` sidecar) | same as `--input` |
| `--faction NAME` | Faction slug | `death-guard` |
| `--edition EDITION` | Edition label | `10ed` |
| `--dry-run` | Parse and log stats, skip all file writes | off |

The parser reads the Forge World blocklist from `config.json` (`rulesFetcher.forgeWorldSlugs`), filters summoned daemon allies by the `SUMMONED` keyword, deduplicates all arrays by name, and regenerates the `.txt` file. Both the edition-stamped copy (`death-guard-10ed.*`) and the `-latest` copy are kept in sync.

Run `npm run parse-rules:dry` after a manual `fetch-rules` to check what would be filtered before committing.

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
npm run optimize:text   # Text only
```

| Option | Description | Default |
|---|---|---|
| `--lists PATH` | Crawler JSON file | `output/army-lists-latest.json` |
| `--report PATH` | Meta report JSON | `reports/meta-report-latest.json` |
| `--previous PATH` | Previous crawl file (for novelty flags) | `output/army-lists-previous.json` |
| `--output DIR` | Output directory | `reports/` |
| `--format FORMAT` | `json`, `text`, or `all` | `all` |

### Enrich Rules

```bash
npm run enrich
```

| Option | Description | Default |
|---|---|---|
| `--rules PATH` | Parsed rules JSON | `rules/death-guard-latest.json` |
| `--optimizer PATH` | Optimizer JSON | `reports/optimizer-latest.json` |
| `--output DIR` | Output directory | `reports/` |
| `--dry-run` | Parse and log stats, skip all file writes | off |

Requires both a parsed rules file and an optimizer report. Produces `enriched-rules-latest.json` which is consumed by the Build Advisor tab and optionally passed to AI Analysis for game-context enrichment.

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
| `--rules-dir PATH` | Directory containing rules `.txt` files | `rules/` |
| `--output DIR` | Output directory | `reports/` |
| `--model NAME` | Claude model to use | from `config.json` |
| `--enriched PATH` | Enriched rules JSON | `reports/enriched-rules-latest.json` |
| `--max-tokens N` | Max output tokens | from `config.json` |

If a rules document is found in `--rules-dir` (e.g. `death-guard-latest.txt`), it is included as a cached system block in the API request to give Claude game-rule context without re-sending it on every retry.

### Build Site

```bash
npm run build-site      # Build docs/index.html
npm run build-all       # Report + optimizer + ai-analysis + site in one step
```

## Output Structure

```
rules/
  death-guard-latest.json       # Current rules data (JSON)
  death-guard-latest.txt        # Current rules (plain text for AI prompt)
  death-guard-10ed.json         # Edition-stamped copy
  death-guard-10ed.txt

output/
  army-lists-latest.json        # Most recent crawl data (with firstSeen/lastSeen)
  army-lists-previous.json      # Previous crawl (copied before each new crawl)
  army-lists-<timestamp>.json   # Archived crawls
  debug-screenshot.png          # Page screenshot at time of crawl (debug)
  debug-page.html               # Page source at time of crawl (debug)

reports/
  meta-report-latest.json       # Detachment stats, record distribution, crawl diff
  optimizer-latest.json         # Unit/enhancement frequency, variance, novelty flags
  enriched-rules-latest.json    # Rules + optimizer data merged for Build Advisor
  ai-analysis-latest.json       # Per-list characterizations, detachment summaries, patterns
  *.txt                         # Text versions of each report

docs/
  index.html                    # GitHub Pages dashboard (self-contained)
  template.html                 # Source template
  data/
    meta-report.json            # Copy of latest meta report (for direct access)
    optimizer.json              # Copy of latest optimizer report
    ai-analysis.json            # Copy of latest AI analysis
    army-lists.json             # Copy of latest army lists
  llms.txt                      # LLM-readable site overview and data links
  llms-full.txt                 # Full concatenated plain-text reports for LLMs
```

## GitHub Actions

Three workflows handle the automation:

**`.github/workflows/test.yml`** — runs on every push and pull request:
- Lints with ESLint
- Runs all tests via `node:test`

**`.github/workflows/fetch-rules.yml`** — runs every **Saturday at 05:00 UTC** or manually:
- Scrapes Death Guard rules from wahapedia.ru (skipped if already fresh)
- Runs `parse-rules.js` to filter, deduplicate, and regenerate the rules text
- Commits updated rules to `rules/` with `[skip ci]` to avoid triggering a deploy
- Manual trigger accepts a `force` boolean to bypass the freshness check
- Runs the day before the Sunday army-list crawl so AI analysis always has current rules

**`.github/workflows/crawl-deploy.yml`** — runs every **Sunday at 06:00 UTC** or manually:
- Crawl listhammer.info for Death Guard lists (exits with error if fewer than 5 lists found)
- Generate meta report (with crawl diff against previous crawl)
- Run army optimizer (with novelty flags against previous crawl)
- Enrich rules data (merge rules with optimizer output for Build Advisor)
- Generate AI analysis (requires `ANTHROPIC_API_KEY` secret; skipped gracefully if missing)
- Build and deploy to GitHub Pages
- Manual trigger accepts a `game` input (`40k`, `aos`, or both)

> **Note:** Pushing code to `main` only triggers the test workflow — it never triggers a crawl or deploy.

Debug artifacts (raw crawl output) are uploaded on every crawl run and retained for 30 days on failure, 7 days on success.

## Running Tests

```bash
npm test
```

9 test suites (114 tests) using the built-in `node:test` runner — no extra test dependencies required:

| Suite | What it covers |
|---|---|
| `test-utils` | Shared utilities: `getArg`, `parseRecord`, `extractDetachment`, `flattenLists` |
| `test-crawler` | Pure crawler functions: faction filtering, section discovery, text parsing |
| `test-report` | Meta report generation, detachment breakdown, crawl diff |
| `test-optimizer` | Unit/enhancement frequency, variance, novelty flags, co-occurrence |
| `test-enrich-rules` | Rules enrichment: detachment parsing, unit matching, keyword extraction |
| `test-ai-analysis` | API key handling, graceful degradation, placeholder generation |
| `test-build-site` | HTML generation, JSON inlining, LLM file generation |
| `test-rules-fetcher` | Rules parsing, caching, URL building, text conversion, FW blocklist |
| `test-parse-rules` | Post-processing pipeline: FW filtering, daemon filtering, deduplication, validation |

## Linting

```bash
npm run lint
```

Uses ESLint v9 with Node.js/ES2022 rules. Configuration is in `eslint.config.js`.

## Troubleshooting

**Crawler finds 0 lists:**
- Check `output/debug-screenshot.png` and `output/debug-page.html` for the page state at failure
- The crawler exits with code 1 when 0 lists are found, which will fail the CI pipeline — this is intentional so the deploy doesn't silently overwrite the dashboard with empty data
- Try running with `--no-headless` locally to observe the browser behaviour

**Report fails with "Input file not found":**
- Run `npm run crawl:dg` first to generate `output/army-lists-latest.json`

**AI content not showing in dashboard:**
- Ensure `ANTHROPIC_API_KEY` is set (locally or as a GitHub Actions secret)
- Check the Actions log for the `Generate AI meta analysis` step

**AI response parsing error:**
- If the response was cut off (`stop_reason: max_tokens`), the script automatically retries once with 1.5× the token limit
- For other parse failures, the script retries once with the same parameters
- Check the Actions log — it shows `stop_reason` and the first 500 chars of the raw response

**Rules are stale or missing:**
- Run `npm run fetch-rules:force` to force a fresh fetch regardless of age
- Or trigger the `fetch-rules.yml` workflow manually from the Actions tab with `force: true`

**Rules contain unexpected units (Forge World, daemon allies):**
- Run `npm run parse-rules:dry` to see what would be filtered without changing any files
- Run `npm run parse-rules` to apply filtering and regenerate the `.txt` file in place
- To permanently exclude a new unit, add its wahapedia URL slug to `forgeWorldSlugs` in `config.json`

## Disclaimer

Listhammer.info's `robots.txt` allows general crawling (`Allow: /`) but disallows AI training (`ai-train=no`). This tool:
- Uses a standard Chrome user agent
- Is for **personal meta analysis only**, not AI training or republishing
- Respects rate limits via the `--delay` option

## License

[ISC](LICENSE)
