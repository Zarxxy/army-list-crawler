'use strict';

// Lazily required so pure functions can be imported in tests without Playwright installed
let chromium;

const fs   = require('fs');
const path = require('path');
const { getArg } = require('./utils');

const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const rfConfig  = appConfig.rulesFetcher || {};

const WAHAPEDIA_BASE  = rfConfig.wahapediaBase  || 'https://wahapedia.ru';
const DEFAULT_FACTION = rfConfig.defaultFaction  || 'death-guard';
const DEFAULT_EDITION = rfConfig.defaultEdition  || '10ed';
const FRESHNESS_DAYS  = rfConfig.freshnessDays   || 7;
const MAX_TXT_CHARS   = rfConfig.maxTxtChars     || 180000;

const CONFIG = rfConfig.timeouts || {
  NAV_TIMEOUT_MS:       60000,
  JS_RENDER_WAIT_MS:    3000,
  CF_CHALLENGE_WAIT_MS: 10000,
  PAGE_DELAY_MS:        2000,
  VIEWPORT_WIDTH:       1920,
  VIEWPORT_HEIGHT:      1080,
};

// ---------------------------------------------------------------------------
// Forge World / Legends / Kill Team unit blocklist
//
// These unit slugs appear on the Death Guard faction page but are NOT part of
// the standard competitive 10th edition army — they are Forge World, Horus
// Heresy legacy, or Kill Team datasheets.  The list is maintained in
// config.json (rulesFetcher.forgeWorldSlugs) so parse-rules.js can share it
// without importing Playwright-adjacent code.  Add new entries there if
// wahapedia adds more non-competitive units.
// ---------------------------------------------------------------------------
const FORGE_WORLD_SLUGS = new Set(rfConfig.forgeWorldSlugs || []);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const faction   = getArg(args, '--faction')   || DEFAULT_FACTION;
const edition   = getArg(args, '--edition')   || DEFAULT_EDITION;
const outputDir = getArg(args, '--output')    || path.join(__dirname, 'rules');
const _rawMaxUnits  = parseInt(getArg(args, '--max-units') || '0', 10);
const maxUnits  = Number.isFinite(_rawMaxUnits)  && _rawMaxUnits  >= 0 ? _rawMaxUnits  : 0; // 0 = no limit
const _rawPageDelay = parseInt(getArg(args, '--delay') || String(CONFIG.PAGE_DELAY_MS), 10);
const pageDelay = Number.isFinite(_rawPageDelay) && _rawPageDelay >= 0 ? _rawPageDelay : CONFIG.PAGE_DELAY_MS;
const force     = args.includes('--force');
const headless  = !args.includes('--no-headless');
const dumpHtml  = args.includes('--dump-html');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testing, no Playwright dependency)
// ---------------------------------------------------------------------------

/**
 * Returns true if the rules JSON file exists and was fetched within maxDays.
 */
function isFresh(filePath, maxDays = FRESHNESS_DAYS) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!data.fetchedAt) return false;
    const age = Date.now() - new Date(data.fetchedAt).getTime();
    return age < maxDays * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Builds the wahapedia faction overview URL.
 * e.g. buildFactionUrl('death-guard', '10ed')
 *   => 'https://wahapedia.ru/wh40k10ed/factions/death-guard/'
 */
function buildFactionUrl(factionSlug, ed = DEFAULT_EDITION) {
  return `${WAHAPEDIA_BASE}/wh40k${ed}/factions/${factionSlug}/`;
}

/**
 * Builds the wahapedia unit datasheet URL.
 * e.g. buildUnitUrl('death-guard', '10ed', 'Daemon-Prince-of-Nurgle')
 *   => 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Daemon-Prince-of-Nurgle'
 */
function buildUnitUrl(factionSlug, ed, unitSlug) {
  return `${WAHAPEDIA_BASE}/wh40k${ed}/factions/${factionSlug}/${unitSlug}`;
}

/**
 * Converts the structured rules data object into a plain-text document
 * suitable for inclusion in an LLM system prompt.
 */
function rulesToText(rulesData) {
  if (!rulesData) return '';
  const lines = [];
  const factionLabel = (rulesData.faction || 'DEATH GUARD').toUpperCase().replace(/-/g, ' ');
  const edLabel = rulesData.edition ? rulesData.edition.toUpperCase() : '10TH EDITION';

  lines.push(`=== ${factionLabel} RULES REFERENCE (${edLabel}) ===`);
  if (rulesData.fetchedAt) {
    lines.push(`Fetched: ${rulesData.fetchedAt.slice(0, 10)}`);
  }
  lines.push('');

  // Faction abilities
  if (rulesData.factionAbilities && rulesData.factionAbilities.length > 0) {
    lines.push('--- FACTION ABILITIES ---');
    for (const ab of rulesData.factionAbilities) {
      if (ab.name) {
        lines.push(`[${ab.name}]${ab.description ? ': ' + ab.description : ''}`);
      }
    }
    lines.push('');
  }

  // Detachments
  if (rulesData.detachments && rulesData.detachments.length > 0) {
    lines.push('--- DETACHMENTS ---');
    for (const det of rulesData.detachments) {
      lines.push('');
      lines.push(`### ${det.name}`);
      if (det.ability) {
        lines.push(`Detachment Ability: ${det.ability}`);
      }
      if (det.stratagems && det.stratagems.length > 0) {
        lines.push('Stratagems:');
        for (const s of det.stratagems) {
          const cp = s.cp ? ` (${s.cp} CP)` : '';
          lines.push(`  [${s.name}]${cp}${s.description ? ': ' + s.description : ''}`);
        }
      }
      if (det.enhancements && det.enhancements.length > 0) {
        lines.push('Enhancements:');
        for (const e of det.enhancements) {
          lines.push(`  [${e.name}]${e.description ? ': ' + e.description : ''}`);
        }
      }
    }
    lines.push('');
  }

  // Unit datasheets
  if (rulesData.units && rulesData.units.length > 0) {
    lines.push('--- UNIT DATASHEETS ---');
    for (const unit of rulesData.units) {
      lines.push('');
      lines.push(`### ${unit.name}`);

      // Stats
      if (unit.stats && Object.keys(unit.stats).length > 0) {
        const statKeys = ['M', 'T', 'Sv', 'W', 'Ld', 'OC'];
        const statParts = statKeys
          .filter((k) => unit.stats[k] !== undefined)
          .map((k) => `${k}: ${unit.stats[k]}`);
        if (statParts.length > 0) lines.push(statParts.join('  '));
      }

      // Weapons
      if (unit.weapons && unit.weapons.length > 0) {
        lines.push('Weapons:');
        for (const w of unit.weapons) {
          const profile = [
            w.range ? `Range: ${w.range}` : null,
            w.a     ? `A: ${w.a}`         : null,
            w.bs    ? `BS: ${w.bs}`        : null,
            w.s     ? `S: ${w.s}`          : null,
            w.ap    ? `AP: ${w.ap}`        : null,
            w.d     ? `D: ${w.d}`          : null,
          ].filter(Boolean).join(' ');
          lines.push(`  ${w.name}${w.type ? ' (' + w.type + ')' : ''}: ${profile}`);
          if (w.abilities) lines.push(`    Abilities: ${w.abilities}`);
        }
      }

      // Unit abilities
      if (unit.abilities && unit.abilities.length > 0) {
        lines.push('Abilities:');
        for (const ab of unit.abilities) {
          if (ab.name) {
            lines.push(`  [${ab.name}]${ab.description ? ': ' + ab.description : ''}`);
          }
        }
      }

      // Keywords
      if (unit.keywords && unit.keywords.length > 0) {
        lines.push(`Keywords: ${unit.keywords.join(', ')}`);
      }

      // Points
      if (unit.points) {
        lines.push(`Points: ${unit.points}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Rough token estimate: ~4 chars per token for English text.
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Truncates text to at most maxChars characters, preserving whole lines.
 * Appends a notice if truncated.
 */
function truncateToTokenBudget(text, maxChars = MAX_TXT_CHARS) {
  if (!text || text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  // back up to the last newline so we don't cut mid-line
  const lastNewline = truncated.lastIndexOf('\n');
  const clean = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
  return clean + '\n\n[Document truncated to fit token budget]';
}

/**
 * Returns true if the unit should be kept for this faction.
 *
 * Strategy: exclusion-based rather than inclusion-based.
 *
 * The problem: wahapedia displays faction keywords (e.g. "DEATH GUARD") and
 * unit keywords in separate HTML sections. The scraper only reliably captures
 * one section, so "DEATH GUARD" is often absent from the keywords array even
 * for genuine Death Guard units (e.g. Plagueburst Crawler, Poxwalkers).
 *
 * The reliable signal is the SUMMONED keyword — only summoned Chaos Daemon
 * allies carry it (Plaguebearers, Plague Drones, Nurglings, Great Unclean One,
 * etc.). Death Guard units — including Daemon Engines — never have SUMMONED.
 *
 * Logic:
 *   1. No keywords extracted → keep (failsafe for selector misses)
 *   2. Has faction keyword (e.g. "DEATH GUARD") → keep (best case)
 *   3. Has SUMMONED keyword → exclude (daemon ally, not a Death Guard unit)
 *   4. Otherwise → keep (assume valid; faction keyword was just not captured)
 *
 * @param {object} unit        — scraped unit object with a `keywords` array
 * @param {string} factionSlug — e.g. "death-guard"
 */
function hasFactionKeyword(unit, factionSlug) {
  if (!unit.keywords || unit.keywords.length === 0) return true;
  const kws = unit.keywords.map((kw) => kw.toUpperCase());
  const needle = factionSlug.replace(/-/g, ' ').toUpperCase(); // "DEATH GUARD"
  if (kws.some((kw) => kw.includes(needle))) return true;  // explicitly ours
  if (kws.includes('SUMMONED')) return false;               // daemon ally
  return true;                                              // faction kw not captured — keep
}

/**
 * Removes duplicate weapons (by name) and abilities (by name) within a unit.
 * Mutates and returns the unit object.
 */
function deduplicateUnit(unit) {
  if (unit.weapons) {
    unit.weapons = unit.weapons.filter(
      (w, i, arr) => arr.findIndex((x) => x.name === w.name) === i
    );
  }
  if (unit.abilities) {
    unit.abilities = unit.abilities.filter(
      (a, i, arr) => arr.findIndex((x) => x.name === a.name) === i
    );
  }
  return unit;
}

/**
 * Deduplicates an array of detachment objects by name, and within each
 * detachment deduplicates stratagems and enhancements by name.
 *
 * @param {object[]} detachments
 * @returns {object[]} deduplicated detachments
 */
function deduplicateDetachments(detachments) {
  const seen = new Set();
  return detachments
    .filter((d) => {
      const key = d.name?.toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((d) => {
      if (d.stratagems) {
        d.stratagems = d.stratagems.filter(
          (s, i, arr) => arr.findIndex((x) => x.name === s.name) === i
        );
      }
      if (d.enhancements) {
        d.enhancements = d.enhancements.filter(
          (e, i, arr) => arr.findIndex((x) => x.name === e.name) === i
        );
      }
      return d;
    });
}

// ---------------------------------------------------------------------------
// Faction / keyword helpers (exported for testing and parse-rules.js)
// ---------------------------------------------------------------------------

/**
 * Returns true if the unit should be kept for this faction.
 *
 * Strategy: exclusion-based rather than inclusion-based.
 *
 * The problem: wahapedia displays faction keywords (e.g. "DEATH GUARD") and
 * unit keywords in separate HTML sections. The scraper only reliably captures
 * one section, so "DEATH GUARD" is often absent from the keywords array even
 * for genuine Death Guard units (e.g. Plagueburst Crawler, Poxwalkers).
 *
 * The reliable signal is the SUMMONED keyword — only summoned Chaos Daemon
 * allies carry it (Plaguebearers, Plague Drones, Nurglings, Great Unclean One,
 * etc.). Death Guard units — including Daemon Engines — never have SUMMONED.
 *
 * Logic:
 *   1. No keywords extracted → keep (failsafe for selector misses)
 *   2. Has faction keyword (e.g. "DEATH GUARD") → keep (best case)
 *   3. Has SUMMONED keyword → exclude (daemon ally, not a Death Guard unit)
 *   4. Otherwise → keep (assume valid; faction keyword was just not captured)
 *
 * @param {object} unit        — scraped unit object with a `keywords` array
 * @param {string} factionSlug — e.g. "death-guard"
 */
function hasFactionKeyword(unit, factionSlug) {
  if (!unit.keywords || unit.keywords.length === 0) return true;
  const kws = unit.keywords.map((kw) => kw.toUpperCase());
  const needle = factionSlug.replace(/-/g, ' ').toUpperCase(); // "DEATH GUARD"
  if (kws.some((kw) => kw.includes(needle))) return true;  // explicitly ours
  if (kws.includes('SUMMONED')) return false;               // daemon ally
  return true;                                              // faction kw not captured — keep
}

/**
 * Removes duplicate weapons (by name) and abilities (by name) within a unit.
 * Mutates and returns the unit object.
 */
function deduplicateUnit(unit) {
  if (unit.weapons) {
    unit.weapons = unit.weapons.filter(
      (w, i, arr) => arr.findIndex((x) => x.name === w.name) === i
    );
  }
  if (unit.abilities) {
    unit.abilities = unit.abilities.filter(
      (a, i, arr) => arr.findIndex((x) => x.name === a.name) === i
    );
  }
  return unit;
}

/**
 * Removes duplicate detachments by name and deduplicates stratagems +
 * enhancements within each surviving detachment.
 *
 * @param {Array} detachments
 * @returns {Array}
 */
function deduplicateDetachments(detachments) {
  const seen = new Set();
  return detachments.filter((d) => {
    const key = (d.name || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((d) => {
    if (d.stratagems) {
      d.stratagems = d.stratagems.filter(
        (s, i, arr) => arr.findIndex((x) => x.name === s.name) === i
      );
    }
    if (d.enhancements) {
      d.enhancements = d.enhancements.filter(
        (e, i, arr) => arr.findIndex((x) => x.name === e.name) === i
      );
    }
    return d;
  });
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

async function launchBrowser() {
  ({ chromium } = require('playwright'));
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
      `--window-size=${CONFIG.VIEWPORT_WIDTH},${CONFIG.VIEWPORT_HEIGHT}`,
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: CONFIG.VIEWPORT_WIDTH, height: CONFIG.VIEWPORT_HEIGHT },
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

  // Anti-bot evasion: mask webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Navigate to a URL with Cloudflare challenge detection + fallback wait.
 */
async function navigateSafe(page, url) {
  console.log(`  Navigating to: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: CONFIG.NAV_TIMEOUT_MS });
  await sleep(CONFIG.JS_RENDER_WAIT_MS);

  // Check for Cloudflare challenge
  const hasCfChallenge = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    return bodyText.includes('Checking your browser') ||
           bodyText.includes('DDoS protection') ||
           bodyText.includes('Just a moment') ||
           bodyText.includes('Verify you are human') ||
           bodyText.includes('Enable JavaScript') ||
           !!document.querySelector('#challenge-form, #cf-challenge-running, .cf-browser-verification');
  });

  if (hasCfChallenge) {
    console.warn(`  Cloudflare challenge detected — waiting ${CONFIG.CF_CHALLENGE_WAIT_MS}ms…`);
    await sleep(CONFIG.CF_CHALLENGE_WAIT_MS);
    const stillChallenge = await page.evaluate(() =>
      document.body?.innerText?.includes('Checking your browser') ||
      !!document.querySelector('#cf-challenge-running')
    );
    if (stillChallenge) {
      throw new Error(`Cloudflare challenge did not resolve for ${url}`);
    }
  }

  // Human-like scroll
  await page.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
  await sleep(500);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

/**
 * Saves full rendered HTML to a debug file when --dump-html is passed.
 */
async function maybeDumpHtml(page, label) {
  if (!dumpHtml) return;
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const dest = path.join(outputDir, `debug-${safeLabel}.html`);
  const html = await page.content().catch(() => '');
  fs.writeFileSync(dest, html, 'utf-8');
  console.log(`  [dump-html] Saved ${html.length} chars → ${dest}`);
}

// ---------------------------------------------------------------------------
// Scraping helpers — run inside page.evaluate()
// ---------------------------------------------------------------------------

/**
 * Extracts all text content from an element matched by selector, or null.
 */
function elText(el) {
  return el ? (el.innerText || el.textContent || '').trim() : null;
}

// ---------------------------------------------------------------------------
// Scraping: faction page
// ---------------------------------------------------------------------------

/**
 * Scrapes the faction overview page.
 * Returns { factionAbilities, detachmentSections, unitLinks }
 *
 * Uses section-aware DOM traversal: walks elements in document order,
 * tracks the current page section (Datasheets, Detachments, Forge World,
 * Crusade, etc.) and only collects content from the relevant sections.
 */
async function scrapeFactionPage(page, factionSlug, ed) {
  const factionUrl = buildFactionUrl(factionSlug, ed);
  await navigateSafe(page, factionUrl);
  await maybeDumpHtml(page, `faction-${factionSlug}`);

  const result = await page.evaluate((slug) => {
    const out = {
      factionAbilities: [],
      detachmentSections: [],
      unitLinks: [],
    };

    const unitPattern = new RegExp(`/factions/${slug}/([^/?#]+)$`, 'i');

    // ── Section markers (lowercase) ───────────────────────────────────────────
    // When one of these headings is encountered, the section state changes.
    const SECTION_RULES = [
      // { match: fn(txtLower) => bool, state: string }
      { match: (t) => t === 'datasheets' || t === 'datasheet',     state: 'datasheets' },
      { match: (t) => t === 'detachments' || t === 'detachment',   state: 'detachments' },
      { match: (t) => t.includes('army rule') || t.includes('faction abilit') || t === 'army rules', state: 'army-rules' },
      { match: (t) => t.includes('crusade'),                        state: 'crusade' },
      { match: (t) => t.includes('boarding'),                       state: 'boarding' },
      { match: (t) => t.includes('forge world') || t.includes('forgeworld') || t.includes('legend'), state: 'forgeworld' },
      { match: (t) => t.includes('kill team'),                      state: 'killteam' },
      { match: (t) => t.includes('apocalypse') || t.includes('horus heresy'), state: 'excluded' },
    ];

    // Sections from which unit links are collected
    const UNIT_LINK_SECTIONS = new Set(['datasheets', 'initial']);
    // Sections that are explicitly excluded from unit links
    const UNIT_EXCLUDE_SECTIONS = new Set(['crusade', 'boarding', 'forgeworld', 'killteam', 'excluded']);

    // Sub-headings within the detachments section that are NOT detachment names
    // (these are sub-sections like the stratagems list, enhancement list, etc.)
    const DET_SKIP_HEADINGS = new Set([
      'enhancements', 'stratagems', 'detachment rule', 'detachment rules',
      'introduction', 'books', 'overview', 'rules', 'adaptations',
      'rules adaptations', 'army rules', 'privacy preferences',
      'boons of nurgle', 'boarding actions', 'unclean uprising',
      'arch-contaminators', 'forming boarding squads', 'mustering a boarding patrol',
      'vectors of decay', 'rules adaptations',
    ]);

    let sectionState = 'initial';

    // ── Single-pass DOM walk (headings update state, links are collected) ─────
    document.querySelectorAll('h1, h2, h3, h4, a[href]').forEach((el) => {
      // ── Heading: update section state ──────────────────────────────────────
      if (/^H[1-4]$/.test(el.tagName)) {
        const txtLower = (el.innerText || '').toLowerCase().trim();
        for (const rule of SECTION_RULES) {
          if (rule.match(txtLower)) {
            sectionState = rule.state;
            return;
          }
        }
        // Headings that don't match any rule leave the state unchanged
        return;
      }

      // ── Link: collect unit links ────────────────────────────────────────────
      if (UNIT_EXCLUDE_SECTIONS.has(sectionState)) return;

      const href = el.getAttribute('href') || '';
      const m = href.match(unitPattern);
      if (!m) return;

      const unitSlug = m[1];
      const label = (el.innerText || el.textContent || '').trim() || unitSlug;

      if (!out.unitLinks.find((u) => u.slug === unitSlug)) {
        // Tag links with the section they were found in so we can prefer 'datasheets'
        out.unitLinks.push({ slug: unitSlug, label, _section: sectionState });
      }
    });

    // If we found links specifically in the 'datasheets' section, prefer those.
    // Otherwise fall back to all non-excluded links.
    const datasheetsLinks = out.unitLinks.filter((u) => u._section === 'datasheets');
    if (datasheetsLinks.length > 0) {
      out.unitLinks = datasheetsLinks;
    } else {
      out.unitLinks = out.unitLinks.filter((u) => UNIT_LINK_SECTIONS.has(u._section));
    }
    // Strip internal _section tag
    out.unitLinks.forEach((u) => delete u._section);

    // ── Faction abilities ─────────────────────────────────────────────────────
    // Strategy 1: class-based
    const abilityEls = document.querySelectorAll(
      '[class*="faction"][class*="ability"], [class*="FactionAbility"], [class*="faction-ability"]'
    );
    abilityEls.forEach((el) => {
      const name = el.querySelector('[class*="name"], [class*="title"], strong, b, h3, h4')?.innerText?.trim();
      const desc = el.querySelector('[class*="desc"], [class*="text"], p')?.innerText?.trim() || el.innerText?.trim();
      if (name) out.factionAbilities.push({ name, description: desc || '' });
    });

    // Strategy 2: headings in the army-rules section
    if (out.factionAbilities.length === 0) {
      let inArmyRules = false;
      document.querySelectorAll('h2, h3, h4').forEach((h) => {
        const txtLower = (h.innerText || '').toLowerCase().trim();
        if (txtLower.includes('army rule') || txtLower.includes('faction abilit')) {
          inArmyRules = true;
          return;
        }
        if (inArmyRules && (txtLower === 'detachments' || txtLower === 'datasheets')) {
          inArmyRules = false;
          return;
        }
        if (!inArmyRules) return;
        const name = h.innerText.trim();
        const desc = h.nextElementSibling?.innerText?.trim() || '';
        if (name && name.length > 2 && name.length < 80) {
          out.factionAbilities.push({ name, description: desc });
        }
      });
    }

    // ── Detachment sections — bounded to the 'detachments' section ───────────
    // Walk h2/h3 headings in document order. When we enter the 'detachments'
    // section (detected by a heading that says "Detachments"), collect each
    // sub-heading as a potential detachment. Stop when we hit any other major
    // section (Crusade, Datasheets, Army Rules, etc.).
    let inDetachments = false;
    document.querySelectorAll('h2, h3').forEach((h) => {
      const txt = (h.innerText || '').trim();
      const txtLower = txt.toLowerCase();

      // Detect section start
      if (txtLower === 'detachments' || txtLower === 'detachment') {
        inDetachments = true;
        return;
      }
      // Detect section end
      if (txtLower === 'datasheets' || txtLower === 'datasheet' ||
          txtLower.includes('crusade') || txtLower.includes('boarding') ||
          txtLower.includes('forge world') || txtLower.includes('kill team') ||
          txtLower.includes('army rule') || txtLower.includes('unclean uprising') ||
          txtLower.includes('arch-contaminators') || txtLower.includes('privacy')) {
        inDetachments = false;
        return;
      }

      if (!inDetachments) return;
      if (DET_SKIP_HEADINGS.has(txtLower)) return;
      if (txt.length < 3 || txt.length > 80) return;

      // Collect following siblings as raw content
      let sibling = h.nextElementSibling;
      const parts = [];
      while (sibling && !['H2', 'H3'].includes(sibling.tagName)) {
        parts.push((sibling.innerText || '').trim());
        sibling = sibling.nextElementSibling;
      }
      const rawText = parts.join('\n').slice(0, 3000);
      if (rawText.length > 10) {
        out.detachmentSections.push({ name: txt, rawText });
      }
    });

    // Fallback: class-based selector if no section-bounded detachments found
    if (out.detachmentSections.length === 0) {
      document.querySelectorAll('[class*="detachment"], [class*="Detachment"]').forEach((el) => {
        const name = el.querySelector('[class*="name"], [class*="title"], h2, h3, h4, strong')?.innerText?.trim()
          || el.getAttribute('data-name')
          || el.innerText?.split('\n')[0]?.trim();
        if (name && name.length > 2 && name.length < 80) {
          out.detachmentSections.push({ name, rawText: (el.innerText || '').trim().slice(0, 3000) });
        }
      });
    }

    return out;
  }, factionSlug);

  console.log(`  Found ${result.unitLinks.length} unit links, ${result.detachmentSections.length} detachment blocks, ${result.factionAbilities.length} faction abilities`);
  return result;
}

// ---------------------------------------------------------------------------
// Scraping: unit datasheet page
// ---------------------------------------------------------------------------

/**
 * Scrapes a single unit datasheet page.
 * Returns { name, stats, weapons, abilities, keywords, points }
 */
async function scrapeUnitDatasheet(page, unitSlug, factionSlug, ed) {
  const url = buildUnitUrl(factionSlug, ed, unitSlug);
  await navigateSafe(page, url);
  await maybeDumpHtml(page, `unit-${unitSlug}`);

  const result = await page.evaluate((slug) => {
    const unit = {
      name: '',
      stats: {},
      weapons: [],
      abilities: [],
      keywords: [],
      points: '',
      _url: window.location.href,
    };

    // ── Unit name ──────────────────────────────────────────────────────────────
    // wahapedia h1 contains filter UI widgets as nested elements, so innerText
    // includes e.g. "Death Guard – Plagueburst Crawler\nNo filter\nVIRULENT..."
    // Take only the first line, then strip any "Faction – " prefix.
    const h1 = document.querySelector('h1');
    const h1FirstLine = h1?.innerText?.trim().split('\n')[0]?.trim() || '';
    const h1Clean = h1FirstLine.replace(/^.*?[–—-]\s*/, '').trim(); // strip "Death Guard – "
    unit.name = h1Clean
      || document.title?.replace(/\s*[-|].*/, '').trim()
      || slug.replace(/-/g, ' ');

    // ── Stat block ─────────────────────────────────────────────────────────────
    // Look for a table or div grid containing M, T, Sv, W, Ld, OC headers
    const statKeys = ['M', 'T', 'Sv', 'W', 'Ld', 'OC'];

    // Strategy 1: find a table whose headers contain the stat keys
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th, thead td')).map((th) => th.innerText?.trim());
      const hasStats = statKeys.filter((k) => headers.includes(k)).length >= 3;
      if (hasStats) {
        const dataRow = table.querySelector('tbody tr, tr:not(:first-child)');
        if (dataRow) {
          const cells = Array.from(dataRow.querySelectorAll('td')).map((td) => td.innerText?.trim());
          headers.forEach((h, i) => {
            if (statKeys.includes(h) && cells[i] !== undefined) {
              unit.stats[h] = cells[i];
            }
          });
        }
        break;
      }
    }

    // Strategy 2: look for divs/spans labeled with stat names
    if (Object.keys(unit.stats).length === 0) {
      const allEls = document.querySelectorAll('[class*="stat"], [class*="Stat"], [class*="characteristic"]');
      allEls.forEach((el) => {
        const label = el.querySelector('[class*="label"], [class*="name"], dt, th')?.innerText?.trim();
        const value = el.querySelector('[class*="value"], [class*="val"], dd, td')?.innerText?.trim();
        if (label && statKeys.includes(label) && value) {
          unit.stats[label] = value;
        }
      });
    }

    // Strategy 3: scan all text for patterns like "M  T  Sv  W  Ld  OC" followed by values
    if (Object.keys(unit.stats).length === 0) {
      const bodyText = document.body?.innerText || '';
      const headerLine = bodyText.match(/\bM\b[^\n]*\bT\b[^\n]*\bSv\b[^\n]*\bW\b/);
      if (headerLine) {
        const lineIdx = bodyText.indexOf(headerLine[0]);
        const afterHeader = bodyText.slice(lineIdx + headerLine[0].length).split('\n')[1] || '';
        const vals = afterHeader.trim().split(/\s+/);
        // Align to stat order M, T, Sv, W, Ld, OC
        const order = ['M', 'T', 'Sv', 'W', 'Ld', 'OC'];
        order.forEach((k, i) => {
          if (vals[i]) unit.stats[k] = vals[i];
        });
      }
    }

    // ── Weapon tables ──────────────────────────────────────────────────────────
    const weaponStatKeys = ['A', 'BS', 'WS', 'S', 'AP', 'D'];
    for (const table of tables) {
      const headerEls = Array.from(table.querySelectorAll('th, thead td'));
      const headers = headerEls.map((th) => th.innerText?.trim());
      const hasWeaponStats = weaponStatKeys.filter((k) => headers.includes(k)).length >= 3;
      if (!hasWeaponStats) continue;

      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      rows.forEach((row) => {
        const cells = Array.from(row.querySelectorAll('td')).map((td) => td.innerText?.trim());
        if (cells.length < 3) return;

        // First cell is usually the weapon name
        const weapon = { name: cells[0] || '' };
        headers.forEach((h, i) => {
          if (h === 'A')           weapon.a    = cells[i];
          else if (h === 'BS' || h === 'WS') weapon.bs = cells[i];
          else if (h === 'S')      weapon.s    = cells[i];
          else if (h === 'AP')     weapon.ap   = cells[i];
          else if (h === 'D')      weapon.d    = cells[i];
          else if (h === 'Range')  weapon.range = cells[i];
        });

        // Abilities footnote is often the last column or a separate row
        const abIdx = headers.indexOf('Abilities') !== -1 ? headers.indexOf('Abilities')
                     : headers.indexOf('Special') !== -1 ? headers.indexOf('Special') : -1;
        if (abIdx !== -1 && cells[abIdx]) weapon.abilities = cells[abIdx];

        if (weapon.name) unit.weapons.push(weapon);
      });
    }

    // ── Unit abilities ─────────────────────────────────────────────────────────
    // Strategy 1: elements with class containing 'ability'
    const abilityEls = document.querySelectorAll(
      '[class*="ability"]:not([class*="faction"]):not([class*="weapon"]), [class*="Ability"]'
    );
    abilityEls.forEach((el) => {
      const nameEl = el.querySelector('[class*="name"], [class*="title"], strong, b, dt');
      const descEl = el.querySelector('[class*="desc"], [class*="text"], p, dd');
      const name = nameEl?.innerText?.trim() || el.innerText?.split('\n')[0]?.trim();
      const description = descEl?.innerText?.trim()
                        || el.innerText?.replace(name || '', '').trim().slice(0, 500);
      if (name && name.length > 1 && name.length < 80) {
        unit.abilities.push({ name, description: description || '' });
      }
    });

    // Strategy 2: headings followed by text near keyword "ABILITIES"
    if (unit.abilities.length === 0) {
      const headings = document.querySelectorAll('h3, h4');
      headings.forEach((h) => {
        const txt = h.innerText?.trim();
        if (!txt || txt.length > 80) return;
        const desc = h.nextElementSibling?.innerText?.trim() || '';
        if (desc) unit.abilities.push({ name: txt, description: desc.slice(0, 500) });
      });
    }

    // ── Keywords ───────────────────────────────────────────────────────────────
    // Strategy 1: element with class 'keywords'
    const kwEls = document.querySelectorAll('[class*="keyword"], [class*="Keyword"]');
    if (kwEls.length > 0) {
      kwEls.forEach((el) => {
        const txt = el.innerText?.trim();
        if (txt) {
          txt.split(/[,·•\n]+/).forEach((kw) => {
            const k = kw.trim();
            if (k && k.length < 60 && !unit.keywords.includes(k)) unit.keywords.push(k);
          });
        }
      });
    }

    // Strategy 2: text containing "KEYWORDS:" label
    if (unit.keywords.length === 0) {
      const bodyText = document.body?.innerText || '';
      const kwMatch = bodyText.match(/KEYWORDS?:\s*([^\n]+)/i);
      if (kwMatch) {
        kwMatch[1].split(/[,·•]+/).forEach((kw) => {
          const k = kw.trim();
          if (k && k.length < 60) unit.keywords.push(k);
        });
      }
    }

    // ── Points ─────────────────────────────────────────────────────────────────
    const ptsEl = document.querySelector('[class*="points"], [class*="pts"], [class*="cost"]');
    if (ptsEl) {
      unit.points = ptsEl.innerText?.trim();
    }
    if (!unit.points) {
      const bodyText = document.body?.innerText || '';
      const ptsMatch = bodyText.match(/(\d+)\s*(?:pts?|points)/i);
      if (ptsMatch) unit.points = ptsMatch[1] + ' pts';
    }

    return unit;
  }, unitSlug);

  // ── Post-scrape: strip stratagem noise from unit abilities ────────────────
  // Wahapedia unit pages show ALL faction stratagems that can target the unit
  // at the bottom of the page.  The ability selector picks them up because they
  // share class names with real unit abilities.  Filter them out by pattern:
  //   • description starts with a CP cost  → stratagem
  //   • description contains stratagem-category markers
  //   • name starts with a number          → composition/wargear row
  if (result.abilities) {
    result.abilities = result.abilities.filter((ab) => {
      const desc = (ab.description || '').trim();
      const name = (ab.name || '').trim();
      // Reject if the description leads with a CP cost (e.g. "1CP", "2 CP")
      if (/^\d+\s*CP\b/i.test(desc)) return false;
      // Reject stratagem category labels in description
      if (/–\s*(BATTLE TACTIC|EPIC DEED|STRATEGIC PLOY|WARGEAR STRATAGEM|BOARDING ACTIONS)/i.test(desc)) return false;
      // Reject composition rows — "1 Plague Champion", "5 models", "1 model"
      if (/^\d+\s+/.test(name)) return false;
      // Reject if description is purely a list of detachment names (no sentence structure)
      if (/^\w[^\s]+(\n\w[^\s]+){3,}$/.test(desc)) return false;
      return true;
    });
  }

  // ── Post-scrape: strip faction ability noise ──────────────────────────────
  // The faction ability class selector also matches detachment rules, which
  // have either no description or a description that is a stratagem/enhancement
  // list.  Keep only abilities with a substantive description (> 50 chars).
  // This is applied on the faction page result via scrapeFactionPage callers.
  // (No action needed here — filtering happens after scrapeFactionPage returns.)

  return result;
}

// ---------------------------------------------------------------------------
// Detachment extraction from raw faction page text
// ---------------------------------------------------------------------------

/**
 * Parses structured detachment data from raw text blocks scraped off the faction page.
 * Falls back to simple text sections when structured selectors find nothing detailed.
 */
function parseDetachmentsFromRaw(detachmentSections) {
  return detachmentSections.map((section) => {
    const text = section.rawText || '';
    const det = { name: section.name, ability: '', stratagems: [], enhancements: [] };

    // Extract ability (first paragraph-like block)
    const abilityMatch = text.match(/(?:detachment abil\w*|battle tactic|stratagem)[:\s]+([^\n]{10,300})/i);
    if (abilityMatch) det.ability = abilityMatch[1].trim();
    if (!det.ability) {
      // Use first substantial line as ability text
      const lines = text.split('\n').filter((l) => l.trim().length > 15);
      if (lines[1]) det.ability = lines[1].trim().slice(0, 300);
    }

    // Extract stratagems: lines that contain CP costs like "1CP" or "2CP"
    const stratagemPattern = /([A-Z][^\n]{5,60})\n[^\n]*(\dCP|\d\s*CP)[^\n]*/gi;
    let m;
    while ((m = stratagemPattern.exec(text)) !== null) {
      const name = m[1].trim();
      const cp   = m[2].trim();
      const desc = text.slice(m.index + m[0].length, m.index + m[0].length + 300).split('\n')[0].trim();
      det.stratagems.push({ name, cp, description: desc });
    }

    // Extract enhancements: lines near the word "Enhancement"
    const enhPattern = /Enhancement[s]?[:\s]+([^\n]+)/gi;
    while ((m = enhPattern.exec(text)) !== null) {
      const name = m[1].trim().replace(/\s*\(.*$/, '');
      if (name.length > 2 && name.length < 80) {
        det.enhancements.push({ name, description: '' });
      }
    }

    return det;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Death Guard Rules Fetcher ===');
  console.log(`Faction: ${faction} | Edition: ${edition} | Force: ${force} | Headless: ${headless}`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const jsonOutPath = path.join(outputDir, `${faction}-${edition}.json`);
  const txtOutPath  = path.join(outputDir, `${faction}-${edition}.txt`);
  const latestJson  = path.join(outputDir, `${faction}-latest.json`);
  const latestTxt   = path.join(outputDir, `${faction}-latest.txt`);

  // Freshness gate
  if (!force && isFresh(jsonOutPath, FRESHNESS_DAYS)) {
    const data = JSON.parse(fs.readFileSync(jsonOutPath, 'utf-8'));
    console.log(`Rules are fresh (fetched ${data.fetchedAt?.slice(0, 10)}). Use --force to re-fetch.`);
    process.exit(0);
  }

  let browser;
  try {
    const launch = await launchBrowser();
    browser = launch.browser;
    const page = launch.page;

    // ── Step 1: Faction overview page ─────────────────────────────────────────
    console.log('\n[1/3] Scraping faction overview page…');
    const factionData = await scrapeFactionPage(page, faction, edition);

    // Strip faction ability entries that have no real description (< 50 chars).
    // Detachment rules, enhancement lists, and stratagem dumps picked up by the
    // broad class selector all have either empty or very short descriptions.
    // Genuine army-wide abilities (Nurgle's Gift, Pact of Decay) have full text.
    factionData.factionAbilities = (factionData.factionAbilities || []).filter(
      (ab) => ab.description && ab.description.trim().length > 50
    );
    console.log(`  After description filter: ${factionData.factionAbilities.length} faction abilities kept`);

    await sleep(pageDelay);

    // ── Step 2: Unit datasheets ────────────────────────────────────────────────
    console.log(`\n[2/3] Scraping ${factionData.unitLinks.length} unit datasheets…`);
    const units = [];

    // Filter out non-unit links (e.g. detachment pages, general pages)
    // Unit slugs on wahapedia typically start with an uppercase letter
    let unitLinks = factionData.unitLinks.filter((u) => /^[A-Z]/.test(u.slug) || /^[A-Z]/.test(u.label));

    // Remove known Forge World / Legends / Kill Team units
    const beforeFwFilter = unitLinks.length;
    unitLinks = unitLinks.filter((u) => !FORGE_WORLD_SLUGS.has(u.slug));
    if (unitLinks.length < beforeFwFilter) {
      console.log(`  Filtered ${beforeFwFilter - unitLinks.length} Forge World/non-competitive units`);
    }

    if (maxUnits > 0 && unitLinks.length > maxUnits) {
      console.log(`  Capping at ${maxUnits} units (--max-units). Skipping ${unitLinks.length - maxUnits} units.`);
      unitLinks = unitLinks.slice(0, maxUnits);
    }

    for (let i = 0; i < unitLinks.length; i++) {
      const link = unitLinks[i];
      console.log(`  [${i + 1}/${unitLinks.length}] ${link.label} (${link.slug})`);
      try {
        const unit = await scrapeUnitDatasheet(page, link.slug, faction, edition);
        deduplicateUnit(unit);
        if (!hasFactionKeyword(unit, faction)) {
          console.log(`  Skipping "${unit.name}" — keywords [${(unit.keywords || []).join(', ')}] do not include faction identifier`);
        } else {
          units.push(unit);
        }
      } catch (err) {
        console.warn(`  Failed to scrape ${link.slug}: ${err.message}`);
        // Omit error stubs — they produce garbage entries in the rules document
      }
      if (i < unitLinks.length - 1) await sleep(pageDelay);
    }

    // ── Step 3: Parse detachment data from raw text ────────────────────────────
    console.log('\n[3/3] Parsing detachment rules from faction page…');
    const rawDetachments = parseDetachmentsFromRaw(factionData.detachmentSections);
    const detachments = deduplicateDetachments(rawDetachments);
    console.log(`  Parsed ${rawDetachments.length} detachment blocks → ${detachments.length} after deduplication`);

    // ── Deduplicate units by name ──────────────────────────────────────────────
    const seenNames = new Set();
    const dedupedUnits = units.filter((u) => {
      const key = u.name?.toLowerCase().trim();
      if (!key || seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });
    console.log(`  Units scraped: ${units.length} → ${dedupedUnits.length} after name deduplication`);

    // ── Assemble + save ────────────────────────────────────────────────────────
    const rulesData = {
      faction,
      edition,
      fetchedAt: new Date().toISOString(),
      factionAbilities: factionData.factionAbilities,
      detachments,
      units: dedupedUnits,
    };

    let txt = rulesToText(rulesData);
    txt = truncateToTokenBudget(txt);

    fs.writeFileSync(jsonOutPath, JSON.stringify(rulesData, null, 2), 'utf-8');
    fs.writeFileSync(txtOutPath,  txt, 'utf-8');
    fs.copyFileSync(jsonOutPath, latestJson);
    fs.copyFileSync(txtOutPath,  latestTxt);

    console.log('\n=== Done ===');
    console.log(`JSON: ${jsonOutPath}`);
    console.log(`TXT:  ${txtOutPath} (${txt.length} chars, ~${estimateTokens(txt)} tokens)`);
    console.log(`Detachments: ${detachments.length}, Units: ${dedupedUnits.length}, Faction abilities: ${rulesData.factionAbilities.length}`);

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Exports (pure functions only — no Playwright dependency in tests)
// ---------------------------------------------------------------------------

if (require.main !== module) {
  module.exports = {
    getArg,
    isFresh,
    buildFactionUrl,
    buildUnitUrl,
    rulesToText,
    estimateTokens,
    truncateToTokenBudget,
    parseDetachmentsFromRaw,
    hasFactionKeyword,
    deduplicateUnit,
    deduplicateDetachments,
    FORGE_WORLD_SLUGS,
  };
} else {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
