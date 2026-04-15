'use strict';

/**
 * Integration tests for report.js
 * Runs the script once against fixture data and validates the JSON output.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPORT_SCRIPT  = path.join(__dirname, '..', 'report.js');
const FIXTURE_LISTS  = path.join(__dirname, 'fixtures', 'army-lists.json');
const PREV_FIXTURE   = path.join(__dirname, 'fixtures', 'army-lists-previous.json');
const FIXTURE_EMPTY  = path.join(__dirname, 'fixtures', 'army-lists-empty.json');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-report-'));

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Shared state
let report;

before(() => {
  const result = spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', FIXTURE_LISTS, '--output', TMP, '--format', 'json'],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  report = JSON.parse(fs.readFileSync(path.join(TMP, 'meta-report-latest.json'), 'utf-8'));
});

test('report meta and basic structure', () => {
  assert.ok(fs.existsSync(path.join(TMP, 'meta-report-latest.json')));
  assert.equal(report.meta.totalLists, 5);
  assert.equal(report.meta.faction, 'Death Guard');
  assert.equal(report.crawlDiff, null);
});

test('detachmentBreakdown is sorted and contains expected detachments', () => {
  const counts = report.detachmentBreakdown.map(d => d.count);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i - 1] >= counts[i], 'detachments not sorted by count');
  }

  const pc = report.detachmentBreakdown.find(d => d.detachment === 'Plague Company');
  assert.ok(pc);
  assert.equal(pc.count, 4);

  const ia = report.detachmentBreakdown.find(d => d.detachment === 'Inexorable Advance');
  assert.ok(ia);
  assert.equal(ia.count, 1);
});

test('listsByDetachment is populated with armyListText', () => {
  const pc = report.listsByDetachment['Plague Company'];
  assert.ok(pc);
  assert.equal(pc.length, 4);
  assert.ok(pc[0].armyListText);
});

test('recordDistribution and eventBreakdown are populated', () => {
  assert.ok(report.recordDistribution.length > 0);
  const fiveOne = report.recordDistribution.find(r => r.record === '5-1');
  assert.ok(fiveOne);

  assert.ok(report.eventBreakdown.length > 0);
  const gt = report.eventBreakdown.find(e => e.event === 'GT Showdown 2024');
  assert.ok(gt);
  assert.equal(gt.listCount, 3);
});

test('crawlDiff with previous file: new lists, dropped lists, new tech', () => {
  const result = spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', FIXTURE_LISTS, '--output', TMP, '--format', 'json',
     '--previous', PREV_FIXTURE],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0);
  const diffReport = JSON.parse(fs.readFileSync(path.join(TMP, 'meta-report-latest.json'), 'utf-8'));

  assert.notEqual(diffReport.crawlDiff, null);
  assert.equal(diffReport.crawlDiff.newLists.length, 3);
  assert.equal(diffReport.crawlDiff.droppedLists.length, 1);
  assert.equal(diffReport.crawlDiff.droppedLists[0].player, 'Fred Green');
  assert.ok(diffReport.crawlDiff.newTechChoices.includes('blightlord terminators'));
});

test('report exits 1 with missing input file', () => {
  const result = spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', '/nonexistent/file.json', '--output', TMP, '--format', 'json'],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('ERROR'));
});

test('report exits 0 with empty input', () => {
  const result = spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', FIXTURE_EMPTY, '--output', TMP, '--format', 'json'],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0);
  const emptyReport = JSON.parse(fs.readFileSync(path.join(TMP, 'meta-report-latest.json'), 'utf-8'));
  assert.equal(emptyReport.meta.totalLists, 0);
  assert.deepEqual(emptyReport.detachmentBreakdown, []);
});

test('report with malformed-fields fixture still exits 0', () => {
  const FIXTURE_MALFORMED = path.join(__dirname, 'fixtures', 'army-lists-malformed.json');
  const result = spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', FIXTURE_MALFORMED, '--output', TMP, '--format', 'json'],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0);
});
