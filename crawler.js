const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://listhammer.info';
const OUTPUT_DIR = path.join(__dirname, 'output');

// Parse CLI args
const args = process.argv.slice(2);
const gameFilter = getArg(args, '--game'); // "40k", "aos", or null for both
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
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  try {
    // Navigate to the homepage to discover sections
    console.log('Loading homepage...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(2000);

    // Discover navigation links for list sections
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

    // Identify list page URLs
    const listSections = identifyListSections(navLinks);
    console.log(`Identified list sections: ${listSections.map((s) => s.name).join(', ')}`);

    const allResults = {};

    for (const section of listSections) {
      if (gameFilter) {
        const is40k = section.name.toLowerCase().includes('40k');
        const isAos = section.name.toLowerCase().includes('aos') || section.name.toLowerCase().includes('sigmar');
        if (gameFilter === '40k' && !is40k) continue;
        if (gameFilter === 'aos' && !isAos) continue;
      }

      console.log(`\n--- Crawling section: ${section.name} ---`);
      const lists = await crawlListSection(page, section, delay, maxPages);
      allResults[section.name] = lists;
      console.log(`  Collected ${lists.length} army lists from ${section.name}`);
    }

    // If no sections were discovered, try fallback direct URLs
    if (Object.keys(allResults).length === 0) {
      console.log('\nNo sections discovered via nav. Trying fallback URLs...');
      const fallbackSections = getFallbackSections(gameFilter);
      for (const section of fallbackSections) {
        console.log(`\n--- Crawling fallback: ${section.name} ---`);
        const lists = await crawlListSection(page, section, delay, maxPages);
        allResults[section.name] = lists;
        console.log(`  Collected ${lists.length} army lists from ${section.name}`);
      }
    }

    // Save results
    const totalLists = Object.values(allResults).reduce((sum, arr) => sum + arr.length, 0);
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
  } finally {
    await browser.close();
  }
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
  return page.evaluate((baseUrl) => {
    const entries = [];

    // Strategy 1: Table rows (common for tournament results)
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr, tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td, th');
        if (cells.length < 2) continue;

        // Skip header rows
        if (row.querySelector('th') && row.closest('thead')) continue;

        const cellTexts = [...cells].map((c) => c.textContent.trim());
        const link = row.querySelector('a[href]');
        const detailUrl = link ? new URL(link.href, baseUrl).href : null;

        entries.push({
          playerName: cellTexts[0] || null,
          faction: cellTexts[1] || null,
          event: cellTexts[2] || null,
          record: cellTexts[3] || null,
          date: cellTexts[4] || null,
          rawCells: cellTexts,
          detailUrl,
        });
      }
    }

    if (entries.length > 0) return entries;

    // Strategy 2: Card/article-based layout
    const cards = document.querySelectorAll(
      '.card, .list-item, .army-list, article, [class*="list-entry"], [class*="army-card"]'
    );
    for (const card of cards) {
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
      const link = card.querySelector('a[href]');
      const detailUrl = link ? new URL(link.href, baseUrl).href : null;

      entries.push({
        playerName: title ? title.textContent.trim() : null,
        faction: faction ? faction.textContent.trim() : null,
        event: event ? event.textContent.trim() : null,
        record: record ? record.textContent.trim() : null,
        detailUrl,
        rawText: card.textContent.trim().substring(0, 500),
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
        entries.push({
          rawText: text.substring(0, 500),
          detailUrl: new URL(href, baseUrl).href,
        });
      }
    }

    return entries;
  }, BASE_URL);
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
