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

test('listsByDetachment is populated with Plague Company (4 lists)', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  assert.ok(report.listsByDetachment, 'listsByDetachment missing');
  const pc = report.listsByDetachment['Plague Company'];
  assert.ok(pc, 'Plague Company not in listsByDetachment');
  assert.equal(pc.length, 4, `expected 4 Plague Company lists, got ${pc.length}`);
});

test('listsByDetachment entries have armyListText', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  const pc = report.listsByDetachment['Plague Company'];
  assert.ok(pc && pc[0].armyListText, 'first Plague Company entry missing armyListText');
});

test('crawlDiff is null when no previous file is provided', () => {
  runReport();
  const report = readJSON('meta-report-latest.json');
  assert.equal(report.crawlDiff, null, 'crawlDiff should be null with no previous file');
});

// ---------------------------------------------------------------------------
// Crawl diff (with previous file)
// ---------------------------------------------------------------------------

const PREV_FIXTURE = path.join(__dirname, 'fixtures', 'army-lists-previous.json');

test('crawlDiff is non-null when previous file is provided', () => {
  const result = runReport(['--previous', PREV_FIXTURE]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const report = readJSON('meta-report-latest.json');
  assert.notEqual(report.crawlDiff, null, 'crawlDiff should not be null with previous file');
});

test('crawlDiff.newLists has 3 entries not present in previous', () => {
  runReport(['--previous', PREV_FIXTURE]);
  const report = readJSON('meta-report-latest.json');
  // Current: Alice, Bob, Carol, Dan, Eve — Previous: Alice, Bob, Fred
  // New: Carol, Dan, Eve (3)
  assert.equal(report.crawlDiff.newLists.length, 3,
    `expected 3 new lists, got ${report.crawlDiff.newLists.length}: ${JSON.stringify(report.crawlDiff.newLists)}`);
});

test('crawlDiff.droppedLists contains Fred Green from previous', () => {
  runReport(['--previous', PREV_FIXTURE]);
  const report = readJSON('meta-report-latest.json');
  assert.equal(report.crawlDiff.droppedLists.length, 1,
    `expected 1 dropped list, got ${report.crawlDiff.droppedLists.length}`);
  assert.equal(report.crawlDiff.droppedLists[0].player, 'Fred Green');
});

test('crawlDiff.newTechChoices includes Blightlord Terminators', () => {
  runReport(['--previous', PREV_FIXTURE]);
  const report = readJSON('meta-report-latest.json');
  assert.ok(
    report.crawlDiff.newTechChoices.includes('Blightlord Terminators'),
    `newTechChoices: ${JSON.stringify(report.crawlDiff.newTechChoices)}`
  );
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

test('report exits with code 1 and prints error when input file is missing', () => {
  const result = spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', '/nonexistent/file.json', '--output', TMP, '--format', 'json'],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 1, 'should exit 1 with missing input file');
  assert.ok(result.stderr.includes('ERROR'), 'should print ERROR to stderr');
});


// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

const FIXTURE_EMPTY  = path.join(__dirname, 'fixtures', 'army-lists-empty.json');

test('report exits 0 and produces empty report when input has no lists', () => {
  const result = spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', FIXTURE_EMPTY, '--output', TMP, '--format', 'json'],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const report = readJSON('meta-report-latest.json');
  assert.equal(report.meta.totalLists, 0);
  assert.deepEqual(report.detachmentBreakdown, []);
});

test('report with malformed-fields fixture still exits 0', () => {
  const FIXTURE_MALFORMED = path.join(__dirname, 'fixtures', 'army-lists-malformed.json');
  const result = spawnSync(
    process.execPath,
    [REPORT_SCRIPT, '--input', FIXTURE_MALFORMED, '--output', TMP, '--format', 'json'],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});
