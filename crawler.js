const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://listhammer.info';
const OUTPUT_DIR = path.join(__dirname, 'output');

// Parse CLI args
const args = process.argv.slice(2);
const gameFilter = getArg(args, '--game'); // "40k", "aos", or null for both
const factionFilter = getArg(args, '--faction'); // e.g. "Tyranids", "Stormcast", case-insensitive substring match
const maxPages = parseInt(getArg(args, '--max-pages') || '0', 10); // 0 = unlimited
const headless = !args.includes('--no-headless');
const delay = parseInt(getArg(args, '--delay') || '1500', 10);

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Listhammer.info Army Lists Crawler ===');
  console.log(`Game filter: ${gameFilter || 'all'}`);
  console.log(`Faction filter: ${factionFilter || 'all'}`);
  console.log(`Max pages per section: ${maxPages || 'unlimited'}`);
  console.log(`Headless: ${headless}`);
  console.log(`Delay between requests: ${delay}ms`);
  console.log('');

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({
    headless,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--window-size=1920,1080',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  // Hide webdriver flag (anti-bot detection evasion)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Override plugins to look like a real browser
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    // Remove chrome.runtime to avoid detection
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    const allResults = {};

    // Build direct URLs using query params (how listhammer.info actually works)
    const directSections = buildDirectSections(gameFilter, factionFilter);
    console.log(`Will crawl ${directSections.length} section(s): ${directSections.map((s) => s.name).join(', ')}`);

    for (const section of directSections) {
      console.log(`\n--- Crawling: ${section.name} (${section.url}) ---`);
      const lists = await crawlListSection(page, section, delay, maxPages);
      console.log(`  Collected ${lists.length} army lists from ${section.name}`);
      allResults[section.name] = lists;
    }

    // If direct URLs found nothing, also try nav-based discovery as fallback
    const totalDirect = Object.values(allResults).reduce((sum, arr) => sum + arr.length, 0);
    if (totalDirect === 0) {
      console.log('\nDirect URLs returned no results. Trying nav-based discovery...');
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
      await sleep(2000);

      const navLinks = await page.evaluate(() => {
        const links = [];
        document.querySelectorAll('a[href]').forEach((a) => {
          const href = a.getAttribute('href');
          const text = a.textContent.trim();
          if (href && text) {
            links.push({ text, href });
          }
        });
        return links;
      });

      console.log(`Found ${navLinks.length} navigation links`);
      const listSections = identifyListSections(navLinks);
      console.log(`Identified list sections: ${listSections.map((s) => s.name).join(', ')}`);

      for (const section of listSections) {
        if (gameFilter) {
          const is40k = section.name.toLowerCase().includes('40k');
          const isAos = section.name.toLowerCase().includes('aos') || section.name.toLowerCase().includes('sigmar');
          if (gameFilter === '40k' && !is40k) continue;
          if (gameFilter === 'aos' && !isAos) continue;
        }

        console.log(`\n--- Crawling section: ${section.name} ---`);
        const lists = await crawlListSection(page, section, delay, maxPages);
        const filtered = filterByFaction(lists, factionFilter);
        if (factionFilter && filtered.length !== lists.length) {
          console.log(`  Collected ${lists.length} army lists, ${filtered.length} match faction "${factionFilter}"`);
        } else {
          console.log(`  Collected ${filtered.length} army lists from ${section.name}`);
        }
        allResults[section.name] = filtered;
      }
    }

    // ALWAYS save debug info so we can inspect what the crawler saw
    const totalLists = Object.values(allResults).reduce((sum, arr) => sum + arr.length, 0);

    console.log(`\n=== Debug: found ${totalLists} total entries ===`);

    // Save screenshot of the last page visited
    const debugScreenshot = path.join(OUTPUT_DIR, 'debug-screenshot.png');
    await page.screenshot({ path: debugScreenshot, fullPage: true }).catch(() => {});
    console.log(`Debug screenshot: ${debugScreenshot}`);

    // Save page HTML
    const html = await page.content().catch(() => '');
    if (html) {
      const debugHtml = path.join(OUTPUT_DIR, 'debug-page.html');
      fs.writeFileSync(debugHtml, html, 'utf-8');
      console.log(`Debug HTML (${html.length} chars): ${debugHtml}`);
      console.log('Page title:', html.match(/<title>(.*?)<\/title>/)?.[1] || 'N/A');
      console.log('Page URL:', page.url());
    }

    // Log the first 3 entries from each section for inspection
    for (const [sectionName, entries] of Object.entries(allResults)) {
      console.log(`\n--- Section "${sectionName}" has ${entries.length} entries ---`);
      for (let i = 0; i < Math.min(entries.length, 3); i++) {
        const e = entries[i];
        console.log(`  Entry ${i + 1}:`);
        console.log(`    playerName: ${JSON.stringify(e.playerName)}`);
        console.log(`    faction:    ${JSON.stringify(e.faction)}`);
        console.log(`    event:      ${JSON.stringify(e.event)}`);
        console.log(`    record:     ${JSON.stringify(e.record)}`);
        console.log(`    detailUrl:  ${JSON.stringify(e.detailUrl)}`);
        if (e.rawText) console.log(`    rawText:    ${JSON.stringify(e.rawText.substring(0, 200))}`);
        if (e.rawCells) console.log(`    rawCells:   ${JSON.stringify(e.rawCells.slice(0, 6))}`);
      }
    }

    if (totalLists === 0) {
      console.warn('\n*** WARNING: No army lists found! ***');
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || '').catch(() => '');
      console.log('Page body text:\n' + (bodyText || '(empty)'));
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    const outputFile = path.join(OUTPUT_DIR, `army-lists-${timestamp}.json`);
    const output = {
      crawledAt: new Date().toISOString(),
      source: BASE_URL,
      totalLists,
      sections: allResults,
    };

    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n=== Done! Saved ${totalLists} army lists to ${outputFile} ===`);

    // Also write a latest symlink-style file
    const latestFile = path.join(OUTPUT_DIR, 'army-lists-latest.json');
    fs.writeFileSync(latestFile, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`Also saved to ${latestFile}`);
  } catch (err) {
    console.error('Crawler error:', err.message);

    // Save a screenshot for debugging
    const screenshotPath = path.join(OUTPUT_DIR, 'error-screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error(`Screenshot saved to ${screenshotPath}`);

    // Dump page HTML for debugging
    const html = await page.content().catch(() => '');
    if (html) {
      const htmlPath = path.join(OUTPUT_DIR, 'error-page.html');
      fs.writeFileSync(htmlPath, html, 'utf-8');
      console.error(`Page HTML saved to ${htmlPath}`);
    }

    // Write empty output so downstream steps don't fail
    const latestFile = path.join(OUTPUT_DIR, 'army-lists-latest.json');
    if (!fs.existsSync(latestFile)) {
      const empty = { crawledAt: new Date().toISOString(), source: BASE_URL, totalLists: 0, sections: {} };
      fs.writeFileSync(latestFile, JSON.stringify(empty, null, 2), 'utf-8');
      console.log(`Wrote empty output to ${latestFile}`);
    }
  } finally {
    await browser.close();
  }
}

/**
 * Filter army list entries by faction name (case-insensitive substring match).
 * Checks faction, title, armyListText, and rawText/rawCells fields.
 */
function filterByFaction(lists, faction) {
  if (!faction) return lists;
  const needle = faction.toLowerCase();
  return lists.filter((entry) => {
    const haystack = [
      entry.faction,
      entry.title,
      entry.armyListText,
      entry.rawText,
      entry.detachment,
      ...(entry.rawCells || []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * Identify which nav links point to army list pages.
 */
function identifyListSections(navLinks) {
  const sections = [];
  const seen = new Set();

  for (const link of navLinks) {
    const text = link.text.toLowerCase();
    const href = link.href;

    // Match links that look like list sections
    if (
      (text.includes('list') || text.includes('army')) &&
      !text.includes('breakdown') &&
      !text.includes('meta') &&
      !text.includes('stat')
    ) {
      const fullUrl = href.startsWith('http') ? href : new URL(href, BASE_URL).href;
      if (!seen.has(fullUrl)) {
        seen.add(fullUrl);
        sections.push({ name: link.text.trim(), url: fullUrl });
      }
    }
  }

  // If nothing matched, try broader patterns
  if (sections.length === 0) {
    for (const link of navLinks) {
      const href = link.href;
      if (
        href.includes('/list') ||
        href.includes('/40k') ||
        href.includes('/aos') ||
        href.includes('/army')
      ) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, BASE_URL).href;
        if (!seen.has(fullUrl)) {
          seen.add(fullUrl);
          sections.push({ name: link.text.trim(), url: fullUrl });
        }
      }
    }
  }

  return sections;
}

/**
 * Build direct URLs using listhammer.info query-parameter based filtering.
 * The site uses ?faction=Death+Guard&wins=X-0 style params.
 */
function buildDirectSections(gameFilter, factionFilter) {
  const sections = [];
  const params = new URLSearchParams();

  if (factionFilter) {
    params.set('faction', factionFilter);
  }

  // All lists for the faction (includes X-0 and X-1)
  const allListsUrl = `${BASE_URL}/?${params.toString()}`;
  const label = factionFilter || (gameFilter ? `${gameFilter} Lists` : 'All Lists');
  sections.push({ name: `${label} (All)`, url: allListsUrl });

  // Also try undefeated specifically
  if (factionFilter) {
    const undefeatedParams = new URLSearchParams(params);
    undefeatedParams.set('wins', 'X-0');
    sections.push({ name: `${label} (Undefeated)`, url: `${BASE_URL}/?${undefeatedParams.toString()}` });
  }

  return sections;
}

/**
 * Fallback URLs if nav discovery fails.
 */
function getFallbackSections(gameFilter) {
  const sections = [];
  if (!gameFilter || gameFilter === '40k') {
    sections.push(
      { name: '40k Lists', url: `${BASE_URL}/40k-lists` },
      { name: '40k Lists Alt', url: `${BASE_URL}/lists` },
      { name: '40k Lists Alt2', url: `${BASE_URL}/40k` }
    );
  }
  if (!gameFilter || gameFilter === 'aos') {
    sections.push(
      { name: 'AoS Lists', url: `${BASE_URL}/aos-lists` },
      { name: 'AoS Lists Alt', url: `${BASE_URL}/aos` }
    );
  }
  return sections;
}

/**
 * Crawl a list section, handling pagination and expanding individual lists.
 */
async function crawlListSection(page, section, delayMs, maxPages) {
  const allLists = [];

  try {
    await page.goto(section.url, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(delayMs);

    // Human-like behavior: scroll down to trigger lazy-loaded content
    await page.evaluate(() => window.scrollTo(0, 300));
    await sleep(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    // Wait for any JavaScript-rendered content (SPA frameworks)
    await page.waitForTimeout(3000);

    // Log page info for debugging
    const pageTitle = await page.title();
    const pageUrl = page.url();
    console.log(`  Page loaded: "${pageTitle}" (${pageUrl})`);

    // Check if we were redirected (e.g. Cloudflare challenge)
    const expectedHost = new URL(section.url).hostname;
    const actualHost = new URL(pageUrl).hostname;
    if (expectedHost !== actualHost) {
      console.warn(`  WARNING: Redirected from ${expectedHost} to ${actualHost} — possible bot protection`);
    }

    // Check for Cloudflare challenge indicators
    const hasCfChallenge = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      return bodyText.includes('Checking your browser') ||
             bodyText.includes('challenge-platform') ||
             bodyText.includes('Just a moment') ||
             bodyText.includes('Verify you are human') ||
             bodyText.includes('Enable JavaScript') ||
             !!document.querySelector('#challenge-form, #cf-challenge-running, .cf-browser-verification');
    });
    if (hasCfChallenge) {
      console.warn('  WARNING: Cloudflare/bot challenge detected! Waiting 10s for it to resolve...');
      await sleep(10000);
      const stillChallenge = await page.evaluate(() => {
        return document.body?.innerText?.includes('Checking your browser') ||
               document.body?.innerText?.includes('Just a moment') ||
               !!document.querySelector('#challenge-form');
      });
      if (stillChallenge) {
        console.warn('  Challenge still present after waiting. Page may be blocked.');
      } else {
        console.log('  Challenge appears to have resolved. Continuing...');
      }
    }
  } catch (err) {
    console.warn(`  Failed to load ${section.url}: ${err.message}`);
    return allLists;
  }

  let pageNum = 0;

  while (true) {
    pageNum++;
    if (maxPages > 0 && pageNum > maxPages) {
      console.log(`  Reached max pages (${maxPages}), stopping.`);
      break;
    }

    console.log(`  Page ${pageNum}...`);

    // Wait for content to load - try common selectors
    await page
      .waitForSelector(
        'table, .list-item, .army-list, .card, article, [class*="list"], [class*="army"]',
        { timeout: 10000 }
      )
      .catch(() => {});

    // Extract army list entries from the current page
    const entries = await extractListEntries(page);
    console.log(`  Found ${entries.length} entries on page ${pageNum}`);

    if (entries.length === 0) break;

    // For each entry, try to get the full list details
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      console.log(`  [${i + 1}/${entries.length}] ${entry.playerName || entry.faction || 'Unknown'}`);

      if (entry.detailUrl) {
        const details = await crawlListDetail(page, entry.detailUrl, delayMs);
        allLists.push({ ...entry, ...details });
      } else {
        allLists.push(entry);
      }
    }

    // Try to find and click a "next page" / "load more" button
    const hasNext = await goToNextPage(page);
    if (!hasNext) break;

    await sleep(delayMs);
  }

  return allLists;
}

/**
 * Extract army list entries from the current page.
 * Tries multiple strategies since we can't test the exact DOM structure.
 */
async function extractListEntries(page) {
  const rawEntries = await page.evaluate((baseUrl) => {
    const entries = [];

    // Helper: extract semantic fields from an element
    function _extractSemanticFields(el) {
      const playerSelectors = [
        '.player', '[class*="player"]', '[class*="name"]:not([class*="army-name"])',
        '[class*="author"]', '[data-field="player"]', '[data-col="player"]',
      ];
      const factionSelectors = [
        '.faction', '[class*="faction"]', '[class*="army-name"]',
        '[data-field="faction"]', '[data-col="faction"]',
      ];
      const detachmentSelectors = [
        '.detachment', '[class*="detachment"]',
        '[data-field="detachment"]', '[data-col="detachment"]',
      ];
      const eventSelectors = [
        '.event', '[class*="event"]', '[class*="tournament"]',
        '[data-field="event"]', '[data-col="event"]',
      ];
      const recordSelectors = [
        '.record', '[class*="record"]', '[class*="score"]', '[class*="result"]',
        '[data-field="record"]', '[data-col="record"]',
      ];
      const dateSelectors = [
        '.date', '[class*="date"]', 'time',
        '[data-field="date"]', '[data-col="date"]',
      ];

      function queryText(parent, selectors) {
        for (const sel of selectors) {
          try {
            const found = parent.querySelector(sel);
            if (found) {
              const t = found.textContent.trim();
              if (t) return t;
            }
          } catch (_) { /* ignore invalid selectors */ }
        }
        return null;
      }

      const player = queryText(el, playerSelectors);
      const faction = queryText(el, factionSelectors);
      const detachment = queryText(el, detachmentSelectors);
      const event = queryText(el, eventSelectors);
      const record = queryText(el, recordSelectors);
      const date = queryText(el, dateSelectors);

      if (player || faction || detachment || event || record || date) {
        return { playerName: player, faction, detachment, event, record, date };
      }
      return null;
    }

    // Helper: extract child element texts from a cell
    function _extractChildTexts(cell) {
      const children = cell.children;
      if (children.length <= 1) return null;
      const texts = [];
      for (const child of children) {
        const t = child.textContent.trim();
        if (t) texts.push(t);
      }
      return texts.length >= 2 ? texts : null;
    }

    // Strategy 0: Extract from Nuxt SSR payload (__NUXT_DATA__ script tag)
    // Listhammer.info is a Nuxt.js app that embeds data in a JSON script tag
    const nuxtScript = document.querySelector('script#__NUXT_DATA__[type="application/json"]');
    if (nuxtScript) {
      try {
        const nuxtRaw = JSON.parse(nuxtScript.textContent);
        // Nuxt 3 payload is an array of values with references
        if (Array.isArray(nuxtRaw)) {
          for (const item of nuxtRaw) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              const keys = Object.keys(item);
              const hasPlayerField = keys.some(k => /player|name|author/i.test(k));
              const hasFactionField = keys.some(k => /faction|army/i.test(k));
              if (hasPlayerField && hasFactionField) {
                const playerKey = keys.find(k => /^player/i.test(k)) || keys.find(k => /name/i.test(k));
                const factionKey = keys.find(k => /faction/i.test(k)) || keys.find(k => /army/i.test(k));
                const detachmentKey = keys.find(k => /detachment/i.test(k));
                const eventKey = keys.find(k => /event|tournament/i.test(k));
                const recordKey = keys.find(k => /record|result|score/i.test(k));
                const dateKey = keys.find(k => /date/i.test(k));
                entries.push({
                  playerName: playerKey ? String(item[playerKey]) : null,
                  faction: factionKey ? String(item[factionKey]) : null,
                  detachment: detachmentKey ? String(item[detachmentKey]) : null,
                  event: eventKey ? String(item[eventKey]) : null,
                  record: recordKey ? String(item[recordKey]) : null,
                  date: dateKey ? String(item[dateKey]) : null,
                  _source: 'nuxt-payload',
                });
              }
            }
          }
        }
      } catch (_) { /* Nuxt payload parsing failed, fall through */ }
    }
    if (entries.length > 0) return entries;

    // Strategy 1: Table rows with header-based column mapping
    // Reads <th> text to determine which column holds which field
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      // Build column mapping from header row
      const headerCells = table.querySelectorAll('thead th, thead td, tr:first-child th');
      const colMap = {};
      headerCells.forEach((th, i) => {
        const text = th.textContent.trim().toLowerCase();
        if (/^name|player/.test(text)) colMap.playerName = i;
        else if (/faction|army/.test(text)) colMap.faction = i;
        else if (/detachment/.test(text)) colMap.detachment = i;
        else if (/event|tournament/.test(text)) colMap.event = i;
        else if (/result|record|score/.test(text)) colMap.record = i;
        else if (/date/.test(text)) colMap.date = i;
      });

      const hasHeaderMap = Object.keys(colMap).length >= 2;

      const rows = table.querySelectorAll('tbody tr, tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td, th');
        if (cells.length < 2) continue;

        // Skip header rows
        if (row.querySelector('th') && row.closest('thead')) continue;
        if (row.querySelectorAll('th').length === cells.length) continue;

        const link = row.querySelector('a[href]');
        const detailUrl = link ? new URL(link.href, baseUrl).href : null;
        const rawText = row.textContent.trim().substring(0, 500);

        // First, try semantic class extraction from the row
        const semantic = _extractSemanticFields(row);
        if (semantic && (semantic.playerName || semantic.faction)) {
          entries.push({ ...semantic, detailUrl, rawText });
          continue;
        }

        const cellTexts = [...cells].map((c) => c.textContent.trim());

        // Use header-based mapping if we detected column names
        if (hasHeaderMap) {
          entries.push({
            playerName: colMap.playerName != null ? (cellTexts[colMap.playerName] || null) : null,
            faction: colMap.faction != null ? (cellTexts[colMap.faction] || null) : null,
            detachment: colMap.detachment != null ? (cellTexts[colMap.detachment] || null) : null,
            event: colMap.event != null ? (cellTexts[colMap.event] || null) : null,
            record: colMap.record != null ? (cellTexts[colMap.record] || null) : null,
            date: colMap.date != null ? (cellTexts[colMap.date] || null) : null,
            rawCells: cellTexts,
            detailUrl,
            rawText,
          });
          continue;
        }

        // Fallback: auto-detect columns from cell content patterns
        let dateIdx = -1, recordIdx = -1;
        for (let ci = 0; ci < cellTexts.length; ci++) {
          if (/\d{4}-\d{2}-\d{2}/.test(cellTexts[ci]) && dateIdx === -1) dateIdx = ci;
          if (/^\d+\s*[-–]\s*\d+(\s*[-–]\s*\d+)?$/.test(cellTexts[ci].trim()) && recordIdx === -1) recordIdx = ci;
        }

        if (recordIdx >= 4) {
          // Work backwards from record column
          const di = dateIdx >= 0 ? dateIdx : recordIdx - 1;
          const eventIdx = di - 1;
          const detIdx = eventIdx >= 2 ? eventIdx - 1 : -1;
          const facIdx = detIdx >= 1 ? detIdx - 1 : eventIdx - 1;
          const nameIdx = facIdx >= 1 ? facIdx - 1 : 0;

          entries.push({
            playerName: nameIdx >= 0 ? (cellTexts[nameIdx] || null) : null,
            faction: facIdx >= 0 ? (cellTexts[facIdx] || null) : null,
            detachment: detIdx >= 0 ? (cellTexts[detIdx] || null) : null,
            event: eventIdx >= 0 ? (cellTexts[eventIdx] || null) : null,
            record: cellTexts[recordIdx] || null,
            date: di >= 0 ? (cellTexts[di] || null) : null,
            rawCells: cellTexts,
            detailUrl,
            rawText,
          });
          continue;
        }

        // Last resort: positional mapping
        entries.push({
          playerName: cellTexts[0] || null,
          faction: cellTexts[1] || null,
          event: cellTexts[2] || null,
          record: cellTexts[3] || null,
          date: cellTexts[4] || null,
          rawCells: cellTexts,
          detailUrl,
          rawText,
        });
      }
    }

    if (entries.length > 0) return entries;

    // Strategy 2: Card/article-based layout
    const cards = document.querySelectorAll(
      '.card, .list-item, .army-list, article, [class*="list-entry"], [class*="army-card"]'
    );
    for (const card of cards) {
      const link = card.querySelector('a[href]');
      const detailUrl = link ? new URL(link.href, baseUrl).href : null;
      const rawText = card.textContent.trim().substring(0, 500);

      // Try semantic extraction first
      const semantic = _extractSemanticFields(card);
      if (semantic && (semantic.playerName || semantic.faction)) {
        entries.push({
          ...semantic,
          detailUrl,
          rawText,
        });
        continue;
      }

      const title = card.querySelector('h1, h2, h3, h4, h5, .title, [class*="title"]');
      const faction = card.querySelector(
        '.faction, [class*="faction"], [class*="army"], .subtitle, [class*="subtitle"]'
      );
      const event = card.querySelector(
        '.event, [class*="event"], [class*="tournament"]'
      );
      const record = card.querySelector(
        '.record, [class*="record"], [class*="score"], [class*="result"]'
      );

      entries.push({
        playerName: title ? title.textContent.trim() : null,
        faction: faction ? faction.textContent.trim() : null,
        event: event ? event.textContent.trim() : null,
        record: record ? record.textContent.trim() : null,
        detailUrl,
        rawText,
      });
    }

    if (entries.length > 0) return entries;

    // Strategy 3: Any clickable links that look like list entries
    const allLinks = document.querySelectorAll('a[href]');
    for (const link of allLinks) {
      const href = link.getAttribute('href');
      const text = link.textContent.trim();
      if (
        text.length > 5 &&
        (href.includes('list') || href.includes('army') || href.includes('player'))
      ) {
        // Try semantic extraction from the link's inner elements
        const semantic = _extractSemanticFields(link);
        const childEls = link.children;
        const childTexts = [];
        for (const child of childEls) {
          const t = child.textContent.trim();
          if (t) childTexts.push(t);
        }

        entries.push({
          ...(semantic || {}),
          rawText: text.substring(0, 500),
          childTexts: childTexts.length >= 2 ? childTexts : undefined,
          detailUrl: new URL(href, baseUrl).href,
        });
      }
    }

    if (entries.length > 0) return entries;

    // Strategy 4: Look for any div/section with structured repeated children
    // (common in React/Vue rendered sites)
    const containers = document.querySelectorAll('div, section, main');
    for (const container of containers) {
      const children = container.children;
      if (children.length >= 3) {
        // Check if children look similar (repeated structure = list items)
        const firstChildTags = [...children[0].querySelectorAll('*')].map((e) => e.tagName).join(',');
        let similar = 0;
        for (let i = 1; i < Math.min(children.length, 5); i++) {
          const tags = [...children[i].querySelectorAll('*')].map((e) => e.tagName).join(',');
          if (tags === firstChildTags) similar++;
        }
        if (similar >= 2) {
          for (const child of children) {
            const text = child.textContent.trim();
            if (text.length < 10) continue;
            const link = child.querySelector('a[href]');
            const detailUrl = link ? new URL(link.href, baseUrl).href : null;

            // Try semantic extraction
            const semantic = _extractSemanticFields(child);
            const innerChildren = child.children;
            const childTexts = [];
            for (const ic of innerChildren) {
              const t = ic.textContent.trim();
              if (t) childTexts.push(t);
            }

            entries.push({
              ...(semantic || {}),
              rawText: text.substring(0, 500),
              childTexts: childTexts.length >= 2 ? childTexts : undefined,
              detailUrl,
            });
          }
          if (entries.length > 0) return entries;
        }
      }
    }

    return entries;
  }, BASE_URL);

  // Post-process: normalize entries using smart text parsing
  return rawEntries.map((entry) => normalizeEntry(entry));
}

/**
 * Post-process an extracted entry to fix field mapping issues.
 * Uses pattern matching to split concatenated text blobs into proper fields.
 */
function normalizeEntry(entry) {
  // If semantic extraction already provided good data, skip
  if (entry.faction && entry.playerName && entry.event &&
      entry.faction !== entry.playerName) {
    return entry;
  }

  // Detect if the "faction" field actually contains a player name
  // (player names don't match known faction patterns)
  const knownFactionPatterns = [
    /death guard/i, /space marine/i, /tyranid/i, /ork/i, /eldar/i, /aeldari/i,
    /necron/i, /tau/i, /t'au/i, /chaos/i, /imperial/i, /adeptus/i, /astra/i,
    /drukhari/i, /harlequin/i, /genestealer/i, /knight/i, /custodes/i,
    /sister/i, /adepta sororitas/i, /world eater/i, /thousand son/i,
    /dark angel/i, /blood angel/i, /space wolv/i, /black templar/i,
    /grey knight/i, /deathwatch/i, /votann/i, /agent/i, /daemon/i,
    /nurgle/i, /khorne/i, /slaanesh/i, /tzeentch/i,
    /stormcast/i, /lumineth/i, /seraphon/i, /sylvaneth/i, /idoneth/i,
    /ossiarch/i, /soulblight/i, /skaven/i, /maggotkin/i, /ironjawz/i,
    /flesh.eater/i, /cities of sigmar/i, /slaves to darkness/i,
    /blades of khorne/i, /hedonites/i, /disciples of tzeentch/i,
    /ogor mawtribes/i, /sons of behemat/i, /fyreslayer/i, /kharadron/i,
    /nighthaunt/i, /gloomspite/i, /bonesplitterz/i, /big waaagh/i,
  ];

  // Known Death Guard detachments
  const knownDetachments = [
    'Virulent Vectorium', "Mortarion's Hammer", 'Champions of Contagion',
    'Flyblown Host', 'Tallyband Summoners', 'Unclean Horde', 'Plague Company',
    'Black Legion', 'Creations of Bile', 'Pactbound Zealots',
    'Soulforged Warpack', 'Fellhammer Siege-Host',
  ];

  // Check if the faction field looks wrong (contains a player name instead of a faction)
  const factionLooksWrong = entry.faction &&
    !knownFactionPatterns.some((p) => p.test(entry.faction));

  // Try to parse from childTexts (separate child element texts)
  if (entry.childTexts && entry.childTexts.length >= 2) {
    const parsed = parseFieldsFromTexts(entry.childTexts, knownFactionPatterns, knownDetachments);
    if (parsed.faction) {
      return { ...entry, ...parsed };
    }
  }

  // Try to parse from rawCells if the field mapping seems wrong
  if (factionLooksWrong && entry.rawCells && entry.rawCells.length >= 2) {
    // Expand cells: split any cell that contains concatenated data
    const expandedTexts = [];
    for (const cell of entry.rawCells) {
      const subTexts = splitConcatenatedText(cell, knownFactionPatterns, knownDetachments);
      expandedTexts.push(...subTexts);
    }
    const parsed = parseFieldsFromTexts(expandedTexts, knownFactionPatterns, knownDetachments);
    if (parsed.faction) {
      return { ...entry, ...parsed };
    }
  }

  // Try to parse from rawText as last resort
  if (factionLooksWrong && entry.rawText) {
    const subTexts = splitConcatenatedText(entry.rawText, knownFactionPatterns, knownDetachments);
    if (subTexts.length >= 2) {
      const parsed = parseFieldsFromTexts(subTexts, knownFactionPatterns, knownDetachments);
      if (parsed.faction) {
        return { ...entry, ...parsed };
      }
    }
  }

  return entry;
}

/**
 * Given a list of text segments, identify which is player, faction, detachment, event, record, date.
 */
function parseFieldsFromTexts(texts, factionPatterns, detachmentNames) {
  const result = {};
  const used = new Set();

  // 1. Find date (YYYY-MM-DD pattern)
  for (let i = 0; i < texts.length; i++) {
    const dateMatch = texts[i].match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      result.date = dateMatch[1];
      used.add(i);
      break;
    }
  }

  // 2. Find record (W-L or W-L-D pattern, e.g. "5-0", "4-1-0")
  for (let i = 0; i < texts.length; i++) {
    if (used.has(i)) continue;
    if (/^\d+\s*[-–]\s*\d+(\s*[-–]\s*\d+)?$/.test(texts[i].trim())) {
      result.record = texts[i].trim();
      used.add(i);
      break;
    }
  }

  // 3. Find faction (matches known faction patterns)
  for (let i = 0; i < texts.length; i++) {
    if (used.has(i)) continue;
    if (factionPatterns.some((p) => p.test(texts[i]))) {
      result.faction = texts[i].trim();
      used.add(i);
      break;
    }
  }

  // 4. Find detachment (matches known detachment names)
  for (let i = 0; i < texts.length; i++) {
    if (used.has(i)) continue;
    const lower = texts[i].toLowerCase().trim();
    const match = detachmentNames.find((d) => lower === d.toLowerCase());
    if (match) {
      result.detachment = match;
      used.add(i);
      break;
    }
  }

  // 5. Remaining fields: player name is typically first, event is the rest
  // Deduplicate remaining texts to handle cases where the same text appears
  // in multiple cells (e.g., player name in its own cell AND in a concatenated cell)
  const remaining = [];
  const seenRemaining = new Set();
  for (let i = 0; i < texts.length; i++) {
    if (used.has(i)) continue;
    const t = texts[i].trim();
    if (!t || seenRemaining.has(t)) continue;
    seenRemaining.add(t);
    remaining.push(t);
  }
  if (remaining.length >= 2) {
    result.playerName = remaining[0];
    result.event = remaining[1];
  } else if (remaining.length === 1) {
    // If we already have a faction, remaining is likely the player name
    if (result.faction) {
      result.playerName = remaining[0];
    } else {
      result.event = remaining[0];
    }
  }

  return result;
}

/**
 * Split a concatenated text blob into segments using known patterns.
 * E.g., "John DoeDeath GuardVirulent VectoriumSome GT2026-03-21"
 * becomes ["John Doe", "Death Guard", "Virulent Vectorium", "Some GT", "2026-03-21"]
 */
function splitConcatenatedText(text, factionPatterns, detachmentNames) {
  if (!text || text.length < 5) return [text];

  let remaining = text;
  const parts = [];

  // Extract date from the end
  const dateMatch = remaining.match(/(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) {
    remaining = remaining.substring(0, remaining.length - dateMatch[1].length);
    parts.push(dateMatch[1]);
  }

  // Extract record pattern (W-L-D at the end of remaining)
  const recordMatch = remaining.match(/(\d+\s*[-–]\s*\d+(?:\s*[-–]\s*\d+)?)\s*$/);
  if (recordMatch) {
    remaining = remaining.substring(0, remaining.length - recordMatch[1].length);
    parts.push(recordMatch[1].trim());
  }

  // Find and extract known detachment names
  for (const det of detachmentNames) {
    const idx = remaining.indexOf(det);
    if (idx !== -1) {
      const before = remaining.substring(0, idx);
      const after = remaining.substring(idx + det.length);
      remaining = before + '\x00' + after;
      parts.push(det);
      break;
    }
  }

  // Find and extract known faction names
  for (const pattern of factionPatterns) {
    const match = remaining.match(pattern);
    if (match) {
      const idx = remaining.search(pattern);
      const before = remaining.substring(0, idx);
      const after = remaining.substring(idx + match[0].length);
      remaining = before + '\x00' + after;
      parts.push(match[0]);
      break;
    }
  }

  // Split remaining by null markers and add non-empty parts
  const leftover = remaining.split('\x00').map((s) => s.trim()).filter(Boolean);
  parts.push(...leftover);

  // Return all found parts (ordered: leftovers first, then structured fields)
  // Reorder: player name (leftover before faction), faction, detachment, event (leftover after), record, date
  return reorderParsedParts(parts, factionPatterns, detachmentNames);
}

/**
 * Reorder parsed parts into [playerName, faction, detachment, event, record, date] order.
 */
function reorderParsedParts(parts, factionPatterns, detachmentNames) {
  const result = [];
  const categorized = parts.map((p) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return { type: 'date', text: p };
    if (/^\d+\s*[-–]\s*\d+(\s*[-–]\s*\d+)?$/.test(p)) return { type: 'record', text: p };
    if (factionPatterns.some((pat) => pat.test(p))) return { type: 'faction', text: p };
    if (detachmentNames.some((d) => d.toLowerCase() === p.toLowerCase())) return { type: 'detachment', text: p };
    return { type: 'unknown', text: p };
  });

  const unknowns = categorized.filter((c) => c.type === 'unknown');
  const faction = categorized.find((c) => c.type === 'faction');
  const detachment = categorized.find((c) => c.type === 'detachment');
  const record = categorized.find((c) => c.type === 'record');
  const date = categorized.find((c) => c.type === 'date');

  // Player name is typically the first unknown, event is the second
  if (unknowns.length >= 1) result.push(unknowns[0].text); // player
  if (faction) result.push(faction.text);
  if (detachment) result.push(detachment.text);
  if (unknowns.length >= 2) result.push(unknowns[1].text); // event
  if (record) result.push(record.text);
  if (date) result.push(date.text);

  // Add any remaining unknowns
  for (let i = 2; i < unknowns.length; i++) {
    result.push(unknowns[i].text);
  }

  return result;
}

/**
 * Crawl a single army list detail page to get the full list content.
 */
async function crawlListDetail(page, url, delayMs) {
  const currentUrl = page.url();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(delayMs);

    // Try to expand/reveal the army list if it's behind a toggle
    await page
      .click(
        'button:has-text("Show"), button:has-text("Expand"), button:has-text("View"), [class*="toggle"], [class*="expand"], details summary'
      )
      .catch(() => {});
    await sleep(500);

    const detail = await page.evaluate(() => {
      const result = {};

      // Get the page title / heading
      const heading = document.querySelector('h1, h2, .title, [class*="title"]');
      if (heading) result.title = heading.textContent.trim();

      // Look for the army list text block (usually in a pre, code, or specific container)
      const listBlock = document.querySelector(
        'pre, code, .army-list-text, [class*="list-text"], [class*="list-content"], [class*="army-content"], .list-body, [class*="roster"]'
      );
      if (listBlock) {
        result.armyListText = listBlock.textContent.trim();
      }

      // Broader search: look for large text blocks that contain typical army list keywords
      if (!result.armyListText) {
        const allElements = document.querySelectorAll('div, section, article, p, span');
        for (const el of allElements) {
          const text = el.textContent.trim();
          if (
            text.length > 100 &&
            (text.includes('pts') || text.includes('points') || text.includes('Enhancement') ||
             text.includes('Detachment') || text.includes('Warlord') || text.includes('Battalion'))
          ) {
            // Make sure it's the most specific element (no child also matches)
            const children = el.querySelectorAll('div, section, article');
            let childMatches = false;
            for (const child of children) {
              const childText = child.textContent.trim();
              if (childText.length > 100 && childText.includes('pts')) {
                childMatches = true;
                break;
              }
            }
            if (!childMatches) {
              result.armyListText = text;
              break;
            }
          }
        }
      }

      // Extract metadata fields
      const metaSelectors = {
        player: '.player, [class*="player"], [class*="author"]',
        faction: '.faction, [class*="faction"], [class*="army-name"]',
        detachment: '.detachment, [class*="detachment"]',
        event: '.event, [class*="event"], [class*="tournament"]',
        record: '.record, [class*="record"], [class*="score"]',
        date: '.date, [class*="date"], time',
        points: '.points, [class*="points"], [class*="pts"]',
      };

      for (const [key, selector] of Object.entries(metaSelectors)) {
        const el = document.querySelector(selector);
        if (el) result[key] = el.textContent.trim();
      }

      // Grab all visible text as fallback context
      const bodyText = document.body.innerText;
      if (!result.armyListText && bodyText.length > 0) {
        result.fullPageText = bodyText.substring(0, 5000);
      }

      return result;
    });

    // Try to extract detachment from army list text if not found via selectors
    if (!detail.detachment && detail.armyListText) {
      const detMatch = detail.armyListText.match(/Detachment:\s*(.+?)(?:\n|$)/i) ||
                        detail.armyListText.match(/Detachment\s*[-–:]\s*(.+?)(?:\n|$)/i);
      if (detMatch) detail.detachment = detMatch[1].trim();
    }

    // Rename 'player' to 'playerName' for consistency
    if (detail.player && !detail.playerName) {
      detail.playerName = detail.player;
    }

    // Navigate back to the list page
    await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(delayMs);

    return detail;
  } catch (err) {
    console.warn(`  Failed to get details from ${url}: ${err.message}`);
    // Try to go back
    await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    return { error: err.message };
  }
}

/**
 * Try to navigate to the next page of results.
 */
async function goToNextPage(page) {
  // Strategy 1: "Next" button/link
  const nextSelectors = [
    'a:has-text("Next")',
    'a:has-text("next")',
    'button:has-text("Next")',
    'a:has-text(">")',
    'a:has-text("»")',
    '.pagination a:last-child',
    '[class*="next"]',
    '[aria-label="Next"]',
    'a[rel="next"]',
  ];

  for (const selector of nextSelectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        const isDisabled = await el.evaluate(
          (node) =>
            node.classList.contains('disabled') ||
            node.getAttribute('aria-disabled') === 'true' ||
            node.hasAttribute('disabled')
        );
        if (!isDisabled) {
          await el.click();
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          return true;
        }
      }
    } catch {
      continue;
    }
  }

  // Strategy 2: "Load more" button
  const loadMoreSelectors = [
    'button:has-text("Load More")',
    'button:has-text("Show More")',
    'button:has-text("Load more")',
    '[class*="load-more"]',
    '[class*="show-more"]',
  ];

  for (const selector of loadMoreSelectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        await el.click();
        await sleep(2000);
        return true;
      }
    } catch {
      continue;
    }
  }

  // Strategy 3: Infinite scroll - scroll to bottom and check if new content appears
  const prevHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(2000);
  const newHeight = await page.evaluate(() => document.body.scrollHeight);

  return newHeight > prevHeight;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
