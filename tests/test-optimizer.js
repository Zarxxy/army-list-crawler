'use strict';

/**
 * Integration tests for optimizer.js
 * Generates a meta report from fixture data first, then runs the optimizer
 * once and validates its JSON output.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPORT_SCRIPT    = path.join(__dirname, '..', 'report.js');
const OPTIMIZER_SCRIPT = path.join(__dirname, '..', 'optimizer.js');
const FIXTURE_LISTS    = path.join(__dirname, 'fixtures', 'army-lists.json');
const PREV_FIXTURE     = path.join(__dirname, 'fixtures', 'army-lists-previous.json');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-optimizer-'));
const REPORT_FILE = path.join(TMP, 'meta-report-latest.json');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Shared state: populated in before(), read by all tests
let opt;

before(() => {
  // Generate meta report
  spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', FIXTURE_LISTS, '--output', TMP, '--format', 'json'],
    { encoding: 'utf-8' }
  );
  // Run optimizer once
  const result = spawnSync(
    process.execPath,
    [OPTIMIZER_SCRIPT,
      '--lists', FIXTURE_LISTS,
      '--report', REPORT_FILE,
      '--output', TMP,
      '--format', 'json'],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0, `optimizer stderr: ${result.stderr}`);
  opt = JSON.parse(fs.readFileSync(path.join(TMP, 'optimizer-latest.json'), 'utf-8'));
});

test('optimizer output has all required top-level keys', () => {
  for (const key of ['meta', 'unitAnalysis', 'enhancementAnalysis', 'coOccurrence',
    'detachmentFrequencyAnalysis', 'varianceAnalysis', 'noveltyFlags', 'validationWarnings']) {
    assert.ok(key in opt, `missing key: ${key}`);
  }
  assert.ok(Array.isArray(opt.noveltyFlags));
  assert.ok(Array.isArray(opt.varianceAnalysis));
  assert.ok(Array.isArray(opt.validationWarnings));
  assert.equal(opt.meta.totalListsAnalysed, 5);
});

test('detachmentFrequencyAnalysis contains Plague Company with sorted topUnits', () => {
  const pc = opt.detachmentFrequencyAnalysis.find((d) => d.detachment === 'Plague Company');
  assert.ok(pc, 'Plague Company not in detachmentFrequencyAnalysis');
  assert.ok(pc.listCount >= 1);

  // topUnits sorted by count descending
  const counts = pc.topUnits.map((u) => u.count);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i - 1] >= counts[i], 'topUnits not sorted by count');
  }
});

test('unitAnalysis contains expected units with valid frequencies', () => {
  const mortarion = opt.unitAnalysis.units.find(u => u.name === 'Mortarion');
  assert.ok(mortarion, 'Mortarion not found');
  assert.ok(mortarion.frequency > 0);

  const pm = opt.unitAnalysis.units.find(u => u.name === 'Plague Marines');
  assert.ok(pm, 'Plague Marines not found');

  for (const u of opt.unitAnalysis.units) {
    assert.ok(u.frequency >= 0 && u.frequency <= 100, `frequency out of range for ${u.name}`);
  }
});

test('varianceAnalysis has Plague Company with contested choices including Cultists', () => {
  const pc = opt.varianceAnalysis.find((d) => d.detachment === 'Plague Company');
  assert.ok(pc, 'Plague Company not in varianceAnalysis');
  assert.ok(pc.variantChoices.length > 0);
  const cultists = pc.variantChoices.find((c) => c.name === 'Cultists' || c.name === 'Death Guard Cultists');
  assert.ok(cultists, 'Cultists not in variantChoices');
  assert.equal(cultists.frequency, 50);
});

test('noveltyFlags contains Blightlord Terminators when previous file is provided', () => {
  const result = spawnSync(
    process.execPath,
    [OPTIMIZER_SCRIPT,
      '--lists', FIXTURE_LISTS,
      '--report', REPORT_FILE,
      '--output', TMP,
      '--format', 'json',
      '--previous', PREV_FIXTURE],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0);
  const freshOpt = JSON.parse(fs.readFileSync(path.join(TMP, 'optimizer-latest.json'), 'utf-8'));
  const blt = freshOpt.noveltyFlags.find((f) => f.name === 'Blightlord Terminators');
  assert.ok(blt);
  assert.equal(blt.type, 'unit');
  assert.equal(blt.detachment, 'Inexorable Advance');
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
  assert.equal(result.status, 0);
});

test('optimizer exits 0 with empty input and produces valid JSON', () => {
  const FIXTURE_EMPTY = path.join(__dirname, 'fixtures', 'army-lists-empty.json');
  const emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-optimizer-empty-'));
  try {
    spawnSync(
      process.execPath,
      [REPORT_SCRIPT, '--input', FIXTURE_EMPTY, '--output', emptyTmp, '--format', 'json'],
      { encoding: 'utf-8' }
    );
    const result = spawnSync(
      process.execPath,
      [OPTIMIZER_SCRIPT,
        '--lists', FIXTURE_EMPTY,
        '--report', path.join(emptyTmp, 'meta-report-latest.json'),
        '--output', emptyTmp,
        '--format', 'json'],
      { encoding: 'utf-8' }
    );
    assert.equal(result.status, 0);
    const emptyOpt = JSON.parse(fs.readFileSync(path.join(emptyTmp, 'optimizer-latest.json'), 'utf-8'));
    assert.equal(emptyOpt.meta.totalListsAnalysed, 0);
    assert.ok(Array.isArray(emptyOpt.unitAnalysis.units));
    assert.ok(Array.isArray(emptyOpt.detachmentFrequencyAnalysis));
  } finally {
    fs.rmSync(emptyTmp, { recursive: true, force: true });
  }
});
