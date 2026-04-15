'use strict';

// ---------------------------------------------------------------------------
// parse-rules.js
//
// Post-processing utility that reads the raw JSON written by rules-fetcher.js
// and applies deterministic filtering, deduplication, and validation before
// regenerating the plain-text file consumed by ai-analysis.js.
//
// Separating this step from the Playwright scraper means the data-cleaning
// logic is independently testable and can be re-run without re-scraping the
// website.
//
// Usage:
//   node parse-rules.js [options]
//
// Options:
//   --input  <path>    JSON file to read  (default: rules/<faction>-latest.json)
//   --output <path>    JSON file to write (default: same as --input, in-place)
//   --faction <slug>   Faction slug       (default: config.json rulesFetcher.defaultFaction)
//   --edition <ed>     Edition label      (default: config.json rulesFetcher.defaultEdition)
//   --dry-run          Parse + validate, log stats, skip all file writes
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');
const { getArg } = require('./utils');

const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const rfConfig  = appConfig.rulesFetcher || {};

// Reuse pure functions from rules-fetcher.  The require.main guard there
// prevents Playwright from being loaded when rules-fetcher is imported.
const {
  rulesToText,
  estimateTokens,
  truncateToTokenBudget,
  hasFactionKeyword,
  deduplicateUnit,
  deduplicateDetachments,
  FORGE_WORLD_SLUGS,
} = require('./rules-fetcher');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const faction  = getArg(args, '--faction') || rfConfig.defaultFaction || 'death-guard';
const edition  = getArg(args, '--edition') || rfConfig.defaultEdition || '10ed';
const rulesDir = path.join(__dirname, 'rules');
const dryRun   = args.includes('--dry-run');

const defaultInput  = path.join(rulesDir, `${faction}-latest.json`);
const inputFile     = getArg(args, '--input')  || defaultInput;
const outputFile    = getArg(args, '--output') || inputFile;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the slug from a unit's _url field (last path segment).
 * Used to match against FORGE_WORLD_SLUGS — slug matching is more reliable
 * than matching on unit.name because display names can differ from URL slugs
 * (e.g. 'Sokar-pattern Stormbird' vs 'Sokar-pattern-Stormbird').
 *
 * @param {object} unit
 * @returns {string|null}
 */
function extractSlug(unit) {
  if (!unit || !unit._url) return null;
  return unit._url.split('/').pop() || null;
}

/**
 * Filters, deduplicates, and validates a raw rules data object.
 * Pure function — no file I/O.
 *
 * @param {object} rulesData  — raw JSON from rules-fetcher.js
 * @param {string} factionSlug — e.g. 'death-guard'
 * @returns {{ cleaned: object, stats: object }}
 */
function parseRules(rulesData, factionSlug) {
  const stats = {
    forgeWorldRemoved:   0,
    summonedRemoved:     0,
    unitsBefore:         0,
    unitsAfter:          0,
    detachmentsBefore:   0,
    detachmentsAfter:    0,
    validationWarnings:  [],
  };

  const rawUnits = Array.isArray(rulesData.units) ? rulesData.units : [];
  stats.unitsBefore = rawUnits.length;

  // ── 1. Filter units ───────────────────────────────────────────────────────
  let units = rawUnits.filter((unit) => {
    // Forge World / Legends blocklist — match on URL slug for reliability
    const slug = extractSlug(unit);
    if (slug && FORGE_WORLD_SLUGS.has(slug)) {
      stats.forgeWorldRemoved++;
      return false;
    }

    // Daemon allies / wrong-faction units — requires successful keyword extraction
    // hasFactionKeyword returns true when keywords are empty (failsafe for
    // selector failures) so this only fires when keywords were actually scraped
    if (!hasFactionKeyword(unit, factionSlug)) {
      stats.summonedRemoved++;
      return false;
    }

    return true;
  });

  // ── 2. Deduplicate units by name, warning on unnamed units ───────────────
  const seenNames = new Set();
  units = units.filter((unit) => {
    const key = (unit.name || '').toLowerCase().trim();
    if (!key) {
      // Warn and drop: unnamed units cannot be identified or deduped reliably
      stats.validationWarnings.push('Unit missing name field — skipped');
      return false;
    }
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });

  // ── 3. Deduplicate weapons / abilities within each unit ───────────────────
  units.forEach(deduplicateUnit);

  // ── 4. Deduplicate detachments (stratagems + enhancements within each) ────
  const rawDetachments = Array.isArray(rulesData.detachments) ? rulesData.detachments : [];
  stats.detachmentsBefore = rawDetachments.length;
  const detachments = deduplicateDetachments(rawDetachments);
  stats.detachmentsAfter = detachments.length;

  stats.unitsAfter = units.length;

  const cleaned = {
    ...rulesData,
    units,
    detachments,
    parsedAt: new Date().toISOString(),
  };

  return { cleaned, stats };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(inputFile)) {
    console.error(`[parse-rules] Input file not found: ${inputFile}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  } catch (err) {
    console.error(`[parse-rules] Failed to parse input file "${inputFile}": ${err.message}`);
    process.exit(1);
  }
  console.log(`[parse-rules] Input: ${raw.units ? raw.units.length : 0} units, ${raw.detachments ? raw.detachments.length : 0} detachments`);
  console.log(`[parse-rules] Source: ${inputFile}`);

  const { cleaned, stats } = parseRules(raw, faction);

  // Log stats
  console.log(`  Forge World removed:   ${stats.forgeWorldRemoved}`);
  console.log(`  Daemon/wrong-faction:  ${stats.summonedRemoved}`);
  console.log(`  Units:       ${stats.unitsBefore} → ${stats.unitsAfter}`);
  console.log(`  Detachments: ${stats.detachmentsBefore} → ${stats.detachmentsAfter}`);
  if (stats.validationWarnings.length > 0) {
    stats.validationWarnings.forEach((w) => console.warn(`  WARN: ${w}`));
  }

  if (dryRun) {
    console.log('[parse-rules] Dry run — skipping writes.');
    return;
  }

  // ── Write clean JSON ───────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(cleaned, null, 2), 'utf-8');

  // ── Regenerate TXT sidecar ─────────────────────────────────────────────────
  const txtOutput = outputFile.replace(/\.json$/, '.txt');
  let txt = rulesToText(cleaned);
  txt = truncateToTokenBudget(txt);
  fs.writeFileSync(txtOutput, txt, 'utf-8');

  // ── Keep edition-stamped and -latest copies in sync ────────────────────────
  const dataFaction = cleaned.faction || faction;
  const dataEdition = cleaned.edition || edition;
  const editionJson = path.join(rulesDir, `${dataFaction}-${dataEdition}.json`);
  const editionTxt  = path.join(rulesDir, `${dataFaction}-${dataEdition}.txt`);
  const latestJson  = path.join(rulesDir, `${dataFaction}-latest.json`);
  const latestTxt   = path.join(rulesDir, `${dataFaction}-latest.txt`);

  // Sync whichever copy we didn't just write
  if (outputFile !== latestJson) {
    fs.writeFileSync(latestJson, JSON.stringify(cleaned, null, 2), 'utf-8');
    fs.writeFileSync(latestTxt, txt, 'utf-8');
  }
  if (outputFile !== editionJson) {
    fs.writeFileSync(editionJson, JSON.stringify(cleaned, null, 2), 'utf-8');
    fs.writeFileSync(editionTxt, txt, 'utf-8');
  }

  console.log(`[parse-rules] Done.`);
  console.log(`  JSON: ${outputFile}`);
  console.log(`  TXT:  ${txtOutput} (${txt.length} chars, ~${estimateTokens(txt)} tokens)`);
}

// ---------------------------------------------------------------------------
// Exports (pure functions only — no file I/O)
// ---------------------------------------------------------------------------

if (require.main !== module) {
  module.exports = { parseRules, extractSlug };
} else {
  main();
}
