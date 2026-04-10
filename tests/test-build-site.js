'use strict';

/**
 * Integration tests for build-site.js
 * Verifies that JSON data is correctly injected into the HTML template.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BUILD_SCRIPT = path.join(__dirname, '..', 'build-site.js');
const TEMPLATE     = path.join(__dirname, '..', 'docs', 'template.html');

const TMP         = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-site-'));
const DOCS_DIR    = path.join(TMP, 'docs');
const REPORTS_DIR = path.join(TMP, 'reports');
const LISTS_FILE  = path.join(TMP, 'army-lists-latest.json');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Updated sample data matching current schemas
const SAMPLE_META = {
  meta: { faction: 'Death Guard', totalLists: 5, generatedAt: new Date().toISOString(), crawledAt: '...' },
  detachmentBreakdown: [],
  eventBreakdown: [],
  recordDistribution: [],
  pointsAnalysis: {},
  crawlDiff: null,
  listsByDetachment: {},
};

const SAMPLE_OPT = {
  meta: { totalListsAnalysed: 5 },
  unitAnalysis: { units: [] },
  enhancementAnalysis: { enhancements: [] },
  coOccurrence: [],
  detachmentFrequencyAnalysis: [{ detachment: 'Plague Company', listCount: 4, topUnits: [], topEnhancements: [] }],
  varianceAnalysis: [],
  noveltyFlags: [],
};

const SAMPLE_AI = {
  generatedAt: new Date().toISOString(),
  model: 'claude-opus-4-6',
  faction: 'Death Guard',
  skipped: false,
  inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
  detachmentSummaries: [{ detachment: 'Plague Company', summary: 'Test summary.' }],
  listCharacterizations: [],
  crossDetachmentPatterns: 'Test patterns.',
  crawlDiff: null,
};

const SAMPLE_LISTS = {
  crawledAt: new Date().toISOString(),
  totalLists: 1,
  sections: {
    All: [{
      playerName: 'Alice Smith',
      faction: 'Death Guard',
      event: 'Test Event',
      date: '2024-01-10',
      record: '5-1',
      detachment: 'Plague Company',
      armyListText: 'Detachment: Plague Company\n\nMortarion [480pts]\n\nTotal: 480pts',
    }],
  },
};

before(() => {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  // Copy template to our tmp docs dir so build-site can find it
  fs.copyFileSync(TEMPLATE, path.join(DOCS_DIR, 'template.html'));

  fs.writeFileSync(path.join(REPORTS_DIR, 'meta-report-latest.json'), JSON.stringify(SAMPLE_META), 'utf-8');
  fs.writeFileSync(path.join(REPORTS_DIR, 'optimizer-latest.json'),   JSON.stringify(SAMPLE_OPT),  'utf-8');
  fs.writeFileSync(path.join(REPORTS_DIR, 'ai-analysis-latest.json'), JSON.stringify(SAMPLE_AI),   'utf-8');
  fs.writeFileSync(LISTS_FILE, JSON.stringify(SAMPLE_LISTS), 'utf-8');
});

function runBuild() {
  return spawnSync(
    process.execPath,
    [BUILD_SCRIPT,
      '--reports-dir', REPORTS_DIR,
      '--docs-dir',    DOCS_DIR,
      '--lists-file',  LISTS_FILE],
    { encoding: 'utf-8' }
  );
}

function readHTML() {
  return fs.readFileSync(path.join(DOCS_DIR, 'index.html'), 'utf-8');
}

test('build-site.js exits with code 0', () => {
  const result = runBuild();
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test('build-site produces docs/index.html', () => {
  runBuild();
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'index.html')));
});

test('index.html contains injected meta report JSON', () => {
  runBuild();
  const html = readHTML();
  assert.ok(html.includes('"Death Guard"'), 'Death Guard not found in HTML');
  assert.ok(!html.includes('/*__META_REPORT_DATA__*/null'), 'placeholder not replaced');
});

test('index.html contains injected optimizer JSON', () => {
  runBuild();
  const html = readHTML();
  assert.ok(!html.includes('/*__OPTIMIZER_DATA__*/null'), 'optimizer placeholder not replaced');
  assert.ok(html.includes('Plague Company'), 'optimizer detachment not found in HTML');
});

test('index.html contains injected AI analysis JSON', () => {
  runBuild();
  const html = readHTML();
  assert.ok(!html.includes('/*__AI_ANALYSIS_DATA__*/null'), 'AI analysis placeholder not replaced');
  assert.ok(html.includes('Test summary.'), 'AI summary not found in HTML');
});

test('index.html does not contain unreplaced LISTS_DATA placeholder', () => {
  runBuild();
  const html = readHTML();
  assert.ok(!html.includes('/*__LISTS_DATA__*/null'), 'LISTS_DATA placeholder not replaced');
});

test('index.html contains injected army lists JSON', () => {
  runBuild();
  const html = readHTML();
  assert.ok(html.includes('Alice Smith'), 'army lists player not found in HTML');
});

test('build-site copies JSON to docs/data/', () => {
  runBuild();
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'data', 'meta-report.json')));
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'data', 'optimizer.json')));
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'data', 'ai-analysis.json')));
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'data', 'army-lists.json')));
});

test('build-site handles missing AI analysis gracefully (still exits 0)', () => {
  // Remove the AI analysis file temporarily
  const aiPath = path.join(REPORTS_DIR, 'ai-analysis-latest.json');
  const backup = aiPath + '.bak';
  fs.renameSync(aiPath, backup);
  try {
    const result = spawnSync(
      process.execPath,
      [BUILD_SCRIPT, '--reports-dir', REPORTS_DIR, '--docs-dir', DOCS_DIR, '--lists-file', LISTS_FILE],
      { encoding: 'utf-8' }
    );
    assert.equal(result.status, 0);
  } finally {
    fs.renameSync(backup, aiPath);
  }
});

test('build-site embeds skipped placeholder when AI analysis is marked skipped:true', () => {
  const aiPath = path.join(REPORTS_DIR, 'ai-analysis-latest.json');
  const original = fs.readFileSync(aiPath, 'utf-8');
  // Write a skipped placeholder
  fs.writeFileSync(aiPath, JSON.stringify({ ...SAMPLE_AI, skipped: true, reason: 'no key' }), 'utf-8');
  try {
    runBuild();
    const html = readHTML();
    // Placeholder comment must have been replaced
    assert.ok(!html.includes('/*__AI_ANALYSIS_DATA__*/'), 'placeholder comment should have been replaced');
    // A skipped placeholder JSON should be embedded so the dashboard can show a message
    assert.ok(html.includes('"skipped":true'), 'skipped placeholder should be embedded in HTML');
  } finally {
    fs.writeFileSync(aiPath, original, 'utf-8');
  }
});

test('index.html is valid-ish HTML (has doctype and body tags)', () => {
  runBuild();
  const html = readHTML();
  assert.ok(html.toLowerCase().startsWith('<!doctype html'), 'missing doctype');
  assert.ok(html.includes('</body>'), 'missing closing body tag');
  assert.ok(html.includes('</html>'), 'missing closing html tag');
});
