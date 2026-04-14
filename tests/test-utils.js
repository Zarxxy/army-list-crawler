'use strict';

/**
 * Unit tests for shared utility functions in utils.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getArg, parseRecord, extractDetachment, flattenLists } = require('../utils');

// ---------------------------------------------------------------------------
// getArg
// ---------------------------------------------------------------------------

test('getArg returns value for a known flag', () => {
  const args = ['--game', '40k', '--faction', 'Death Guard'];
  assert.equal(getArg(args, '--game'), '40k');
  assert.equal(getArg(args, '--faction'), 'Death Guard');
});

test('getArg returns null for missing flag', () => {
  const args = ['--game', '40k'];
  assert.equal(getArg(args, '--faction'), null);
});

test('getArg returns null when flag is last with no value', () => {
  const args = ['--game'];
  assert.equal(getArg(args, '--game'), null);
});

// ---------------------------------------------------------------------------
// parseRecord
// ---------------------------------------------------------------------------

test('parseRecord parses W-L record', () => {
  const r = parseRecord('3-1');
  assert.equal(r.wins, 3);
  assert.equal(r.losses, 1);
  assert.equal(r.draws, 0);
});

test('parseRecord parses W-L-D record', () => {
  const r = parseRecord('4-2-1');
  assert.equal(r.wins, 4);
  assert.equal(r.losses, 2);
  assert.equal(r.draws, 1);
});

test('parseRecord returns null for null input', () => {
  assert.equal(parseRecord(null), null);
});

test('parseRecord returns null for non-matching string', () => {
  assert.equal(parseRecord('no record here'), null);
});

// ---------------------------------------------------------------------------
// extractDetachment
// ---------------------------------------------------------------------------

test('extractDetachment extracts detachment name', () => {
  assert.equal(extractDetachment('Detachment: Plague Company\nMore text'), 'Plague Company');
});

test('extractDetachment handles dash separator', () => {
  assert.equal(extractDetachment('Detachment - Flyblown Host'), 'Flyblown Host');
});

test('extractDetachment returns null when not present', () => {
  assert.equal(extractDetachment('No detachment here'), null);
});

test('extractDetachment returns null for null input', () => {
  assert.equal(extractDetachment(null), null);
});

// ---------------------------------------------------------------------------
// flattenLists
// ---------------------------------------------------------------------------

test('flattenLists deduplicates entries across sections', () => {
  const raw = {
    sections: {
      sectionA: [{ playerName: 'Alice', event: 'GT', date: '2024-01-01' }],
      sectionB: [{ playerName: 'Alice', event: 'GT', date: '2024-01-01' }],
    },
  };
  assert.equal(flattenLists(raw).length, 1);
});

test('flattenLists merges unique entries from multiple sections', () => {
  const raw = {
    sections: {
      sectionA: [{ playerName: 'Alice', event: 'GT', date: '2024-01-01' }],
      sectionB: [{ playerName: 'Bob',   event: 'GT', date: '2024-01-01' }],
    },
  };
  assert.equal(flattenLists(raw).length, 2);
});

test('flattenLists attaches section name to each entry', () => {
  const raw = {
    sections: {
      mySection: [{ playerName: 'Alice', event: 'GT', date: '2024-01-01' }],
    },
  };
  assert.equal(flattenLists(raw)[0].section, 'mySection');
});

test('flattenLists returns empty array for empty sections', () => {
  assert.deepEqual(flattenLists({ sections: {} }), []);
});

test('flattenLists handles missing sections gracefully', () => {
  assert.deepEqual(flattenLists({}), []);
});
