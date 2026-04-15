'use strict';

/**
 * Integration tests for build-site.js
 * Runs build once; verifies JSON injection, file outputs, and edge cases.
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

// Shared state: populated by before(), read by all tests
let buildResult;
let html;

before(() => {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.copyFileSync(TEMPLATE, path.join(DOCS_DIR, 'template.html'));

  fs.writeFileSync(path.join(REPORTS_DIR, 'meta-report-latest.json'), JSON.stringify(SAMPLE_META), 'utf-8');
  fs.writeFileSync(path.join(REPORTS_DIR, 'optimizer-latest.json'),   JSON.stringify(SAMPLE_OPT),  'utf-8');
  fs.writeFileSync(path.join(REPORTS_DIR, 'ai-analysis-latest.json'), JSON.stringify(SAMPLE_AI),   'utf-8');
  fs.writeFileSync(LISTS_FILE, JSON.stringify(SAMPLE_LISTS), 'utf-8');

  buildResult = spawnSync(
    process.execPath,
    [BUILD_SCRIPT, '--reports-dir', REPORTS_DIR, '--docs-dir', DOCS_DIR, '--lists-file', LISTS_FILE],
    { encoding: 'utf-8' }
  );
  html = fs.existsSync(path.join(DOCS_DIR, 'index.html'))
    ? fs.readFileSync(path.join(DOCS_DIR, 'index.html'), 'utf-8')
    : '';
});

test('build-site exits 0 and produces index.html', () => {
  assert.equal(buildResult.status, 0, `stderr: ${buildResult.stderr}`);
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'index.html')));
});

test('all placeholders are replaced with injected data', () => {
  // No unreplaced placeholders
  assert.ok(!html.includes('/*__META_REPORT_DATA__*/null'));
  assert.ok(!html.includes('/*__OPTIMIZER_DATA__*/null'));
  assert.ok(!html.includes('/*__AI_ANALYSIS_DATA__*/null'));
  assert.ok(!html.includes('/*__LISTS_DATA__*/null'));

  // Injected content appears
  assert.ok(html.includes('"Death Guard"'));
  assert.ok(html.includes('Plague Company'));
  assert.ok(html.includes('Test summary.'));
  assert.ok(html.includes('Alice Smith'));
});

test('build-site copies JSON to docs/data/', () => {
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'data', 'meta-report.json')));
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'data', 'optimizer.json')));
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'data', 'ai-analysis.json')));
  assert.ok(fs.existsSync(path.join(DOCS_DIR, 'data', 'army-lists.json')));
});

test('index.html is valid-ish HTML', () => {
  assert.ok(html.toLowerCase().startsWith('<!doctype html'));
  assert.ok(html.includes('</body>'));
  assert.ok(html.includes('</html>'));
});

test('handles missing AI analysis gracefully (still exits 0)', () => {
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

test('embeds skipped placeholder when AI analysis is marked skipped:true', () => {
  const aiPath = path.join(REPORTS_DIR, 'ai-analysis-latest.json');
  const original = fs.readFileSync(aiPath, 'utf-8');
  fs.writeFileSync(aiPath, JSON.stringify({ ...SAMPLE_AI, skipped: true, reason: 'no key' }), 'utf-8');
  try {
    spawnSync(
      process.execPath,
      [BUILD_SCRIPT, '--reports-dir', REPORTS_DIR, '--docs-dir', DOCS_DIR, '--lists-file', LISTS_FILE],
      { encoding: 'utf-8' }
    );
    const freshHtml = fs.readFileSync(path.join(DOCS_DIR, 'index.html'), 'utf-8');
    assert.ok(!freshHtml.includes('/*__AI_ANALYSIS_DATA__*/'));
    assert.ok(freshHtml.includes('"skipped":true'));
  } finally {
    fs.writeFileSync(aiPath, original, 'utf-8');
  }
});
