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
  for (const key of ['meta', 'unitAnalysis', 'enhancementAnalysis', 'coOccurrence',
    'detachmentFrequencyAnalysis', 'varianceAnalysis', 'noveltyFlags']) {
    assert.ok(key in opt, `missing key: ${key}`);
  }
});

test('detachmentFrequencyAnalysis contains Plague Company', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  const pc = opt.detachmentFrequencyAnalysis.find((d) => d.detachment === 'Plague Company');
  assert.ok(pc, 'Plague Company not in detachmentFrequencyAnalysis');
  assert.ok(pc.listCount >= 1, 'Plague Company listCount should be >= 1');
});

test('detachmentFrequencyAnalysis topUnits are sorted by count descending', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  for (const det of opt.detachmentFrequencyAnalysis) {
    const counts = det.topUnits.map((u) => u.count);
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i - 1] >= counts[i],
        `topUnits not sorted by count for ${det.detachment}`);
    }
  }
});

test('noveltyFlags is an array', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  assert.ok(Array.isArray(opt.noveltyFlags), 'noveltyFlags should be an array');
});

test('noveltyFlags contains Blightlord Terminators when previous file is provided', () => {
  const PREV_FIXTURE = path.join(__dirname, 'fixtures', 'army-lists-previous.json');
  runOptimizer(['--previous', PREV_FIXTURE]);
  const opt = readJSON('optimizer-latest.json');
  const blt = opt.noveltyFlags.find((f) => f.name === 'Blightlord Terminators');
  assert.ok(blt,
    `Blightlord Terminators not in noveltyFlags: ${JSON.stringify(opt.noveltyFlags)}`);
  assert.equal(blt.type, 'unit');
  assert.equal(blt.detachment, 'Inexorable Advance');
});

test('varianceAnalysis is an array', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  assert.ok(Array.isArray(opt.varianceAnalysis), 'varianceAnalysis should be an array');
});

test('varianceAnalysis has Plague Company entry with contested choices', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  const pc = opt.varianceAnalysis.find((d) => d.detachment === 'Plague Company');
  assert.ok(pc, `Plague Company not in varianceAnalysis. Entries: ${JSON.stringify(opt.varianceAnalysis.map(d => d.detachment))}`);
  assert.ok(pc.variantChoices.length > 0, 'Plague Company should have contested choices');
});

test('varianceAnalysis Plague Company includes Cultists at 50%', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  const pc = opt.varianceAnalysis.find((d) => d.detachment === 'Plague Company');
  // After name normalisation, "Cultists" becomes "Death Guard Cultists" (canonical rules name)
  const cultists = pc?.variantChoices.find((c) => c.name === 'Cultists' || c.name === 'Death Guard Cultists');
  assert.ok(cultists,
    `Cultists not in Plague Company variantChoices: ${JSON.stringify(pc?.variantChoices.map(c => c.name))}`);
  assert.equal(cultists.frequency, 50, `expected 50% for Cultists, got ${cultists.frequency}`);
});

test('unitAnalysis contains Mortarion (appears in all fixture lists)', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  const mortarion = opt.unitAnalysis.units.find(u => u.name === 'Mortarion');
  assert.ok(mortarion, 'Mortarion not found in unitAnalysis');
  assert.ok(mortarion.frequency > 0, 'Mortarion frequency should be > 0');
});

test('unitAnalysis contains Plague Marines', () => {
  runOptimizer();
  const opt = readJSON('optimizer-latest.json');
  const pm = opt.unitAnalysis.units.find(u => u.name === 'Plague Marines');
  assert.ok(pm, 'Plague Marines not in unitAnalysis');
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
    assert.equal(opt.meta.totalListsAnalysed, 0, 'empty result should have meta.totalListsAnalysed = 0');
    assert.ok(Array.isArray(opt.unitAnalysis.units), 'empty result should have unitAnalysis.units array');
    assert.ok(Array.isArray(opt.detachmentFrequencyAnalysis), 'empty result should have detachmentFrequencyAnalysis array');
  } finally {
    fs.rmSync(emptyTmp, { recursive: true, force: true });
  }
});
