const fs = require('fs');
const path = require('path');
const { getArg, log } = require('./utils');

// ---------------------------------------------------------------------------
// Builds the GitHub Pages site by inlining report JSON directly into the
// HTML template. The result is a single self-contained index.html that
// works without a server and without separate data files.
//
// Also copies the raw JSON into docs/data/ as a fallback / for direct access.
//
// Usage:
//   node build-site.js
//   node build-site.js --reports-dir ./reports --docs-dir ./docs
//   node build-site.js --lists-file ./output/army-lists-latest.json
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const reportsDir = getArg(args, '--reports-dir') || path.join(__dirname, 'reports');
const docsDir    = getArg(args, '--docs-dir')    || path.join(__dirname, 'docs');
const listsFile  = getArg(args, '--lists-file')  || path.join(__dirname, 'output', 'army-lists-latest.json');
const rulesFile    = getArg(args, '--rules-file')    || path.join(__dirname, 'rules', 'death-guard-latest.json');
const enrichedFile = getArg(args, '--enriched-file') || path.join(__dirname, 'reports', 'enriched-rules-latest.json');
const dataDir    = path.join(docsDir, 'data');
const templatePath = path.join(docsDir, 'template.html');
const outputPath   = path.join(docsDir, 'index.html');

// ---------------------------------------------------------------------------

/**
 * Prevent sequences inside JSON from breaking the surrounding <script> block.
 * - </script> would close the tag prematurely.
 * - <!-- can trigger legacy HTML-comment handling inside scripts in some browsers.
 */
function escapeForScriptTag(jsonStr) {
  return jsonStr
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/<!--/g, '<\\!--');
}

/**
 * Generates llms.txt (site overview + data links) and llms-full.txt
 * (concatenated plain-text reports) in docsDir so LLMs can read the site
 * without parsing the JavaScript-heavy index.html.
 *
 * @param {string} reportsDir - Path to the reports directory
 * @param {string} docsDir    - Path to the docs output directory
 * @param {object|null} metaData - Parsed meta-report JSON (for faction/timestamp)
 */
function buildLlmsFiles(reportsDir, docsDir, metaData) {
  const faction     = metaData?.faction    || 'Unknown Faction';
  const generatedAt = metaData?.generatedAt || new Date().toISOString();

  // --- llms.txt ---
  const llmsTxt = [
    `# Listhammer — ${faction} Meta Analyser`,
    '',
    '> Automated Warhammer 40K tournament army list analysis, powered by Claude AI.',
    `> Last updated: ${generatedAt}`,
    '',
    '## What is this?',
    '',
    'This site crawls top-finishing tournament army lists from listhammer.info, runs',
    'statistical meta analysis, and produces AI-generated per-list and per-detachment',
    'characterizations for competitive play.',
    '',
    '## Site Structure',
    '',
    '3-tab interface:',
    '- **Lists** — all lists sortable by date/event size; expandable cards with full',
    '  army list text, AI archetype + game plan, novelty badges for new lists.',
    '- **By Detachment** — lists grouped by detachment; AI summary; unit frequency',
    '  table; variance (contested choices); novelty flags; collapsible list cards.',
    '- **Patterns** — AI cross-detachment overview and crawl diff summary.',
    '',
    '## Data Endpoints',
    '',
    'These files contain the raw structured data:',
    '',
    '- [Meta Report](data/meta-report.json)',
    '  Detachment breakdown, crawl diff (new/dropped lists, new tech), lists by detachment.',
    '',
    '- [Army Optimizer](data/optimizer.json)',
    '  Per-detachment unit/enhancement frequency, variance (contested choices),',
    '  novelty flags (tech not seen in previous crawl), unit co-occurrence pairs.',
    '',
    '- [AI Analysis](data/ai-analysis.json)',
    '  Claude-generated per-list characterizations (archetype, game plan, tech diffs),',
    '  per-detachment summaries, cross-detachment patterns, crawl diff prose.',
    '',
    '- [Army Lists](data/army-lists.json)',
    '  Raw crawled list data with firstSeen/lastSeen timestamps.',
    '',
    '- [Rules Data](data/rules.json)',
    '  Death Guard rules: faction abilities, detachment abilities, stratagems,',
    '  enhancements, unit keywords/abilities (scraped from wahapedia.ru).',
    '',
    '## Full Plain-Text Report',
    '',
    'For a single human/LLM-readable document with all analysis:',
    '[llms-full.txt](llms-full.txt)',
    '',
    '## Important Dataset Context',
    '',
    'ALL lists in this dataset are top-finishing results (1st or 2nd place at their',
    'tournament). This dataset does NOT represent the general player field.',
    'Do not infer win rates or comparative skill from list frequency.',
    '',
    '## How to Interpret',
    '',
    '- List frequency = how many top-finishing players chose a given unit or detachment.',
    '- "Undefeated" = 0 recorded losses at an event (draws allowed).',
    `- Lists are from ${faction} players at tracked 40K events.`,
    '- AI characterizations are generated by Claude with strict no-win-rate rules.',
    '  All claims are grounded in list count and unit inclusion rate only.',
    '- noveltyFlags = units/enhancements not seen in the previous crawl.',
    '- varianceAnalysis = units appearing in 20–79% of a detachment\'s lists (contested picks).',
  ].join('\n');

  fs.writeFileSync(path.join(docsDir, 'llms.txt'), llmsTxt, 'utf-8');
  log.info('  Generated llms.txt');

  // --- llms-full.txt ---
  const reportFiles = [
    { file: 'meta-report-latest.txt', label: 'META REPORT' },
    { file: 'optimizer-latest.txt',   label: 'ARMY OPTIMIZER' },
    { file: 'ai-analysis-latest.txt', label: 'AI ANALYSIS' },
  ];

  const separator = '='.repeat(80);
  const sections = [
    `Listhammer Meta Analysis — ${faction}  |  Generated: ${generatedAt}`,
    separator,
  ];

  for (const { file, label } of reportFiles) {
    const srcPath = path.join(reportsDir, file);
    if (fs.existsSync(srcPath)) {
      sections.push('', fs.readFileSync(srcPath, 'utf-8').trim());
    } else {
      sections.push('', `[${label}: not available — run the full pipeline to generate this section]`);
    }
  }

  fs.writeFileSync(path.join(docsDir, 'llms-full.txt'), sections.join('\n'), 'utf-8');
  log.info('  Generated llms-full.txt');
}

function main() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Read template
  if (!fs.existsSync(templatePath)) {
    log.error(`Template not found: ${templatePath}`);
    process.exit(1);
  }
  let html = fs.readFileSync(templatePath, 'utf-8');

  let embedded = 0;

  // Meta report
  const metaSrc = path.join(reportsDir, 'meta-report-latest.json');
  let metaJSON = 'null';
  if (fs.existsSync(metaSrc)) {
    metaJSON = fs.readFileSync(metaSrc, 'utf-8');
    fs.copyFileSync(metaSrc, path.join(dataDir, 'meta-report.json'));
    log.info('  Embedded meta report');
    embedded++;
  } else {
    log.warn('  Warning: meta report not found — run "npm run report" first');
  }

  // Optimizer report
  const optSrc = path.join(reportsDir, 'optimizer-latest.json');
  let optJSON = 'null';
  if (fs.existsSync(optSrc)) {
    optJSON = fs.readFileSync(optSrc, 'utf-8');
    fs.copyFileSync(optSrc, path.join(dataDir, 'optimizer.json'));
    log.info('  Embedded optimizer report');
    embedded++;
  } else {
    log.warn('  Warning: optimizer report not found — run "npm run optimize" first');
  }

  // AI analysis report
  const aiSrc = path.join(reportsDir, 'ai-analysis-latest.json');
  let aiJSON = 'null';
  if (fs.existsSync(aiSrc)) {
    let aiData;
    try {
      aiData = JSON.parse(fs.readFileSync(aiSrc, 'utf-8'));
    } catch (err) {
      log.warn(`  Warning: failed to parse AI analysis JSON: ${err.message}`);
      aiData = { skipped: true, reason: `Parse error: ${err.message}` };
    }
    // Only embed if the analysis was not skipped / is not an empty placeholder
    if (!aiData.skipped) {
      aiJSON = JSON.stringify(aiData);
      fs.copyFileSync(aiSrc, path.join(dataDir, 'ai-analysis.json'));
      log.info('  Embedded AI analysis');
      embedded++;
    } else {
      log.warn(`  AI analysis skipped (${aiData.reason || 'no reason given'}) — embedding placeholder`);
      aiJSON = JSON.stringify({ skipped: true, reason: aiData.reason || 'AI analysis was skipped' });
    }
  } else {
    log.warn('  Warning: AI analysis not found — embedding placeholder (run "npm run ai-analysis" to generate)');
    aiJSON = JSON.stringify({ skipped: true, reason: 'AI analysis was not run. Set ANTHROPIC_API_KEY and run "npm run ai-analysis".' });
  }

  // Army lists (for INLINE_LISTS — expandable card decklists)
  let listsJSON = 'null';
  if (fs.existsSync(listsFile)) {
    listsJSON = fs.readFileSync(listsFile, 'utf-8');
    fs.copyFileSync(listsFile, path.join(dataDir, 'army-lists.json'));
    log.info('  Embedded army lists');
    embedded++;
  } else {
    log.warn(`  Warning: army lists not found at ${listsFile} — run "npm run crawl:dg" first`);
  }

  // Rules data (unit keywords, abilities, detachment rules, stratagems, enhancements)
  let rulesJSON = 'null';
  if (fs.existsSync(rulesFile)) {
    const rulesData = JSON.parse(fs.readFileSync(rulesFile, 'utf-8'));
    // Strip _url fields to reduce page weight
    if (Array.isArray(rulesData.units)) {
      for (const unit of rulesData.units) {
        delete unit._url;
      }
    }
    rulesJSON = JSON.stringify(rulesData);
    fs.writeFileSync(path.join(dataDir, 'rules.json'), JSON.stringify(rulesData, null, 2), 'utf-8');
    log.info('  Embedded rules data');
    embedded++;
  } else {
    log.warn(`  Warning: rules file not found at ${rulesFile} — run "npm run fetch-rules" first`);
  }

  // Enriched rules (cross-referenced rules + optimizer data)
  let enrichedJSON = 'null';
  if (fs.existsSync(enrichedFile)) {
    enrichedJSON = fs.readFileSync(enrichedFile, 'utf-8');
    fs.copyFileSync(enrichedFile, path.join(dataDir, 'enriched-rules.json'));
    log.info('  Embedded enriched rules');
    embedded++;
  } else {
    log.warn(`  Warning: enriched rules not found at ${enrichedFile} — run "npm run enrich" first`);
  }

  // Inject data into the template
  // The template uses the pattern: var X = /*__PLACEHOLDER__*/null;
  // We need to replace both the comment AND the trailing null to avoid syntax errors
  const placeholders = [
    '/*__META_REPORT_DATA__*/null',
    '/*__OPTIMIZER_DATA__*/null',
    '/*__AI_ANALYSIS_DATA__*/null',
    '/*__LISTS_DATA__*/null',
    '/*__RULES_DATA__*/null',
    '/*__ENRICHED_DATA__*/null',
  ];
  const replacements = [metaJSON, optJSON, aiJSON, listsJSON, rulesJSON, enrichedJSON];

  for (let i = 0; i < placeholders.length; i++) {
    const before = html.length;
    html = html.replace(placeholders[i], escapeForScriptTag(replacements[i]));
    if (html.length === before) {
      log.warn(`  WARNING: Placeholder ${placeholders[i].slice(2, placeholders[i].indexOf('*/'))} not found in template`);
    }
  }

  fs.writeFileSync(outputPath, html, 'utf-8');

  if (embedded === 0) {
    log.warn('\nNo reports found — site will show empty state.');
  }

  log.info(`\nSite built -> ${path.relative(__dirname, outputPath)} (${embedded} report${embedded > 1 ? 's' : ''} inlined)`);
  log.info('Deploy docs/ to GitHub Pages, or open index.html in a browser.');

  // Generate LLM-readable files
  let llmsMetaData = null;
  if (metaJSON !== 'null') {
    try {
      const parsed = JSON.parse(metaJSON);
      llmsMetaData = parsed.meta || parsed;
    } catch (err) {
      log.warn(`  Warning: failed to parse meta JSON for llms files: ${err.message}`);
    }
  }
  buildLlmsFiles(reportsDir, docsDir, llmsMetaData);
}

main();
