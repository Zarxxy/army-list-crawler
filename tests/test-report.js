'use strict';

/**
 * Integration tests for report.js
 * Runs the script against fixture data and validates the JSON output.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPORT_SCRIPT  = path.join(__dirname, '..', 'report.js');
const FIXTURE_LISTS  = path.join(__dirname, 'fixtures', 'army-lists.json');

// Create a temp dir for output so tests don't pollute /reports
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-report-'));

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function runReport(extraArgs = []) {
  return spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', FIXTURE_LISTS, '--output', TMP, '--format', 'json', ...extraArgs],
    { encoding: 'utf-8' }
  );
}

function readJSON(name) {
  return JSON.parse(fs.readFileSync(path.join(TMP, name), 'utf-8'));
}

test('report.js exits with code 0', () => {
  const result = runReport();
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test('report produces meta-report-latest.json', () => {
  runReport();
  assert.ok(fs.existsSync(path.join(TMP, 'meta-report-latest.json')), 'output file missing');
});

test('report meta has correct totalLists', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  // Fixture has 5 entries in "All", 1 duplicate in "Undefeated" — expect 5 unique
  assert.equal(report.meta.totalLists, 5);
});

test('report detects Death Guard faction', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  assert.equal(report.meta.faction, 'Death Guard');
});

test('report detachmentBreakdown is sorted by count descending', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  const counts = report.detachmentBreakdown.map(d => d.count);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i - 1] >= counts[i], 'detachments not sorted by count');
  }
});

test('Plague Company appears in detachmentBreakdown', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  const pc = report.detachmentBreakdown.find(d => d.detachment === 'Plague Company');
  assert.ok(pc, 'Plague Company not found');
  assert.equal(pc.count, 4, `expected 4 Plague Company lists, got ${pc.count}`);
});

test('Inexorable Advance appears in detachmentBreakdown', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  const ia = report.detachmentBreakdown.find(d => d.detachment === 'Inexorable Advance');
  assert.ok(ia, 'Inexorable Advance not found');
  assert.equal(ia.count, 1);
});

test('undefeatedLists contains Carol White', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  const carol = report.undefeatedLists.find(u => u.player === 'Carol White');
  assert.ok(carol, 'Carol White not in undefeated lists');
  assert.equal(carol.record, '3-0');
  assert.equal(carol.detachment, 'Inexorable Advance');
});

test('topPlayers are sorted by winRate descending', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  const rates = report.topPlayers.map(p => p.winRate);
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i - 1] >= rates[i], 'topPlayers not sorted by winRate');
  }
});

test('recordDistribution is populated', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  assert.ok(report.recordDistribution.length > 0, 'recordDistribution is empty');
  // Fixture has a 5-1 record
  const fiveOne = report.recordDistribution.find(r => r.record === '5-1');
  assert.ok(fiveOne, '5-1 record missing from distribution');
});

test('eventBreakdown is populated', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  assert.ok(report.eventBreakdown.length > 0);
  const gt = report.eventBreakdown.find(e => e.event === 'GT Showdown 2024');
  assert.ok(gt, 'GT Showdown 2024 event missing');
  assert.equal(gt.listCount, 3);
});

test('report handles missing input file gracefully (exit 0, empty report)', () => {
  const result = spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', '/nonexistent/file.json', '--output', TMP, '--format', 'json'],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0, 'should exit 0 even with missing input');
});

test('win rates are between 0 and 100', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  for (const d of report.detachmentBreakdown) {
    if (d.winRate != null) {
      assert.ok(d.winRate >= 0 && d.winRate <= 100, `winRate out of range: ${d.winRate}`);
    }
  }
});
