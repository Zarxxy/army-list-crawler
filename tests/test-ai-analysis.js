'use strict';

/**
 * Tests for ai-analysis.js
 *
 * These tests do NOT make real API calls. They verify:
 *   - The script exits 0 and writes a placeholder when ANTHROPIC_API_KEY is absent
 *   - The placeholder JSON has the expected structure (new schema)
 *   - The script recovers gracefully when the meta report is missing
 *   - The script recovers gracefully when the report has zero lists
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const AI_SCRIPT     = path.join(__dirname, '..', 'ai-analysis.js');
const FIXTURE_LISTS = path.join(__dirname, 'fixtures', 'army-lists.json');

// Pre-built meta report fixture matching new report.js schema
const FIXTURE_REPORT = {
  meta: { generatedAt: new Date().toISOString(), crawledAt: '2024-01-15T10:00:00.000Z', totalLists: 5, faction: 'Death Guard' },
  detachmentBreakdown: [
    { detachment: 'Plague Company',    count: 4, percentage: '80.0', wins: 14, losses: 8, draws: 0, totalGames: 22, undefeatedCount: 0 },
    { detachment: 'Inexorable Advance', count: 1, percentage: '20.0', wins: 3, losses: 0, draws: 0, totalGames: 3, undefeatedCount: 1 },
  ],
  eventBreakdown: [],
  recordDistribution: [],
  pointsAnalysis: {},
  crawlDiff: null,
  listsByDetachment: {},
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-ai-'));
const REPORT_FILE       = path.join(TMP, 'test-meta-report.json');
const EMPTY_REPORT_FILE = path.join(TMP, 'test-empty-report.json');

fs.writeFileSync(REPORT_FILE, JSON.stringify(FIXTURE_REPORT), 'utf-8');
fs.writeFileSync(EMPTY_REPORT_FILE, JSON.stringify({
  ...FIXTURE_REPORT,
  meta: { ...FIXTURE_REPORT.meta, totalLists: 0 },
}), 'utf-8');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function runAI(env = {}, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [AI_SCRIPT,
      '--report', REPORT_FILE,
      '--lists',  FIXTURE_LISTS,
      '--output', TMP,
      ...extraArgs],
    {
      encoding: 'utf-8',
      // Explicitly clear ANTHROPIC_API_KEY so tests don't make real API calls
      env: { ...process.env, ANTHROPIC_API_KEY: '', ...env },
    }
  );
}

function readLatest() {
  const p = path.join(TMP, 'ai-analysis-latest.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}

test('exits with code 0 when ANTHROPIC_API_KEY is not set', () => {
  const result = runAI({ ANTHROPIC_API_KEY: '' });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test('writes ai-analysis-latest.json when API key is missing', () => {
  runAI({ ANTHROPIC_API_KEY: '' });
  assert.ok(fs.existsSync(path.join(TMP, 'ai-analysis-latest.json')));
});

test('writes ai-analysis-latest.txt when API key is missing', () => {
  runAI({ ANTHROPIC_API_KEY: '' });
  assert.ok(fs.existsSync(path.join(TMP, 'ai-analysis-latest.txt')));
});

test('placeholder JSON has skipped:true when no API key', () => {
  runAI({ ANTHROPIC_API_KEY: '' });
  const result = readLatest();
  assert.equal(result.skipped, true);
});

test('placeholder JSON has a reason field mentioning ANTHROPIC_API_KEY', () => {
  runAI({ ANTHROPIC_API_KEY: '' });
  const result = readLatest();
  assert.ok(result.reason, 'reason field is empty');
  assert.ok(result.reason.toLowerCase().includes('anthropic_api_key'), `unexpected reason: ${result.reason}`);
});

test('placeholder JSON has faction field', () => {
  runAI({ ANTHROPIC_API_KEY: '' });
  const result = readLatest();
  assert.ok(result.faction, 'faction field missing');
});

test('placeholder JSON has generatedAt timestamp', () => {
  runAI({ ANTHROPIC_API_KEY: '' });
  const result = readLatest();
  assert.ok(result.generatedAt, 'generatedAt missing');
  assert.ok(!isNaN(Date.parse(result.generatedAt)), `invalid date: ${result.generatedAt}`);
});

test('placeholder JSON has new-schema fields', () => {
  runAI({ ANTHROPIC_API_KEY: '' });
  const result = readLatest();
  assert.ok(Array.isArray(result.detachmentSummaries),    'detachmentSummaries should be an array');
  assert.ok(Array.isArray(result.listCharacterizations),  'listCharacterizations should be an array');
  assert.ok('crossDetachmentPatterns' in result,          'crossDetachmentPatterns field missing');
  assert.ok('crawlDiff' in result,                        'crawlDiff field missing');
});

test('exits 0 when meta report is missing', () => {
  const result = spawnSync(
    process.execPath,
    [AI_SCRIPT, '--report', '/nonexistent/report.json', '--output', TMP],
    { encoding: 'utf-8', env: { ...process.env, ANTHROPIC_API_KEY: 'fake-key' } }
  );
  assert.equal(result.status, 0);
});

test('exits 0 when report has zero lists', () => {
  const result = spawnSync(
    process.execPath,
    [AI_SCRIPT, '--report', EMPTY_REPORT_FILE, '--output', TMP],
    { encoding: 'utf-8', env: { ...process.env, ANTHROPIC_API_KEY: 'fake-key' } }
  );
  assert.equal(result.status, 0);
});

test('zero-lists placeholder has skipped:true', () => {
  spawnSync(
    process.execPath,
    [AI_SCRIPT, '--report', EMPTY_REPORT_FILE, '--output', TMP],
    { encoding: 'utf-8', env: { ...process.env, ANTHROPIC_API_KEY: 'fake-key' } }
  );
  const result = readLatest();
  assert.equal(result.skipped, true);
});

test('accepts --enriched arg without error', () => {
  // The script exits before reaching focused rules when API key is absent,
  // but the arg should be accepted without parse errors
  const enrichedPath = path.join(TMP, 'enriched-rules-latest.json');
  fs.writeFileSync(enrichedPath, JSON.stringify({ detachments: [], units: [] }), 'utf-8');

  const result = runAI({ ANTHROPIC_API_KEY: '' }, ['--enriched', enrichedPath]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});
