'use strict';

/**
 * Integration tests for optimizer.js
 * Generates a meta report from fixture data first, then runs the optimizer
 * and validates its JSON output.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPORT_SCRIPT   = path.join(__dirname, '..', 'report.js');
const OPTIMIZER_SCRIPT = path.join(__dirname, '..', 'optimizer.js');
const FIXTURE_LISTS   = path.join(__dirname, 'fixtures', 'army-lists.json');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-optimizer-'));
const REPORT_FILE = path.join(TMP, 'meta-report-latest.json');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Generate the meta report once before all optimizer tests
before(() => {
  spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', FIXTURE_LISTS, '--output', TMP, '--format', 'json'],
    { encoding: 'utf-8' }
  );
});

function runOptimizer(extraArgs = []) {
  return spawnSync(
    process.execPath,
    [OPTIMIZER_SCRIPT,
      '--lists', FIXTURE_LISTS,
      '--report', REPORT_FILE,
      '--output', TMP,
      '--format', 'json',
      ...extraArgs],
    { encoding: 'utf-8' }
  );
}

function readJSON(name) {
  return JSON.parse(fs.readFileSync(path.join(TMP, name), 'utf-8'));
}

test('optimizer.js exits with code 0', () => {
  const result = runOptimizer();
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test('optimizer produces optimizer-latest.json', () => {
  runOptimizer();
  assert.ok(fs.existsSync(path.join(TMP, 'optimizer-latest.json')));
});

test('optimizer output has required top-level keys', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  for (const key of ['meta', 'recommendation', 'concreteList', 'detachmentAnalysis', 'unitAnalysis', 'coOccurrence']) {
    assert.ok(key in opt, `missing key: ${key}`);
  }
});

test('recommendation faction is Death Guard', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  assert.equal(opt.recommendation.faction, 'Death Guard');
});

test('recommendation detachment is from the fixture data', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  const validDetachments = ['Plague Company', 'Inexorable Advance'];
  assert.ok(
    validDetachments.includes(opt.recommendation.detachment),
    `unexpected detachment: ${opt.recommendation.detachment}`
  );
});

test('recommendation picks most popular detachment (Plague Company)', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  // Fixture has 4 Plague Company vs 1 Inexorable Advance
  assert.equal(opt.recommendation.detachment, 'Plague Company');
});

test('concreteList has units', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  assert.ok(opt.concreteList.units.length > 0, 'concreteList.units is empty');
});

test('concreteList detachment matches recommendation', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  assert.equal(opt.concreteList.detachment, opt.recommendation.detachment);
});

test('unitAnalysis contains Mortarion (appears in all fixture lists)', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  const mortarion = opt.unitAnalysis.units.find(u => u.name === 'Mortarion');
  assert.ok(mortarion, 'Mortarion not found in unitAnalysis');
  // Mortarion appears in all 5 lists
  assert.ok(mortarion.frequency > 0, 'Mortarion frequency should be > 0');
});

test('unitAnalysis contains Plague Marines', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  const pm = opt.unitAnalysis.units.find(u => u.name === 'Plague Marines');
  assert.ok(pm, 'Plague Marines not in unitAnalysis');
});

test('detachmentAnalysis entries have required fields', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  for (const d of opt.detachmentAnalysis) {
    for (const field of ['detachment', 'count', 'winRate']) {
      assert.ok(field in d, `detachmentAnalysis entry missing field: ${field}`);
    }
  }
});

test('optimizer handles missing lists file gracefully (exit 0)', () => {
  const result = spawnSync(
    process.execPath,
    [OPTIMIZER_SCRIPT,
      '--lists', '/nonexistent/lists.json',
      '--report', '/nonexistent/report.json',
      '--output', TMP,
      '--format', 'json'],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0, 'should exit 0 with missing files');
});

test('meta.totalListsAnalysed matches fixture entry count', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  assert.equal(opt.meta.totalListsAnalysed, 5);
});

test('unit frequency values are between 0 and 100', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  for (const u of opt.unitAnalysis.units) {
    assert.ok(u.frequency >= 0 && u.frequency <= 100, `frequency out of range for ${u.name}: ${u.frequency}`);
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

const FIXTURE_EMPTY = path.join(__dirname, 'fixtures', 'army-lists-empty.json');

test('optimizer exits 0 with empty input and produces valid JSON', () => {
  // Use an isolated temp dir so this test does not clobber the shared TMP meta report
  const emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-optimizer-empty-'));
  try {
    const emptyReportResult = spawnSync(
      process.execPath,
      [REPORT_SCRIPT, '--input', FIXTURE_EMPTY, '--output', emptyTmp, '--format', 'json'],
      { encoding: 'utf-8' }
    );
    assert.equal(emptyReportResult.status, 0, `report stderr: ${emptyReportResult.stderr}`);

    const result = spawnSync(
      process.execPath,
      [OPTIMIZER_SCRIPT,
        '--lists', FIXTURE_EMPTY,
        '--report', path.join(emptyTmp, 'meta-report-latest.json'),
        '--output', emptyTmp,
        '--format', 'json'],
      { encoding: 'utf-8' }
    );
    assert.equal(result.status, 0, `optimizer stderr: ${result.stderr}`);
    const opt = JSON.parse(fs.readFileSync(path.join(emptyTmp, 'optimizer-latest.json'), 'utf-8'));
    // Empty result uses top-level totalLists (no meta wrapper)
    assert.equal(opt.totalLists, 0);
  } finally {
    fs.rmSync(emptyTmp, { recursive: true, force: true });
  }
});

test('optimizer warlord field is null or a string (never crashes on empty warlord list)', () => {
  const result = runOptimizer();
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const opt = readJSON('optimizer-latest.json');
  // concreteList is only present in a non-empty result
  if (opt.concreteList) {
    const warlord = opt.concreteList.warlord;
    assert.ok(warlord === null || typeof warlord === 'string', `unexpected warlord type: ${typeof warlord}`);
  }
});
