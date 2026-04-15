'use strict';

/**
 * Unit tests for parse-rules.js.
 * Tests the extractSlug helper and the parseRules pipeline (pure, no file I/O).
 *
 * hasFactionKeyword, deduplicateUnit, and deduplicateDetachments are tested at
 * their source in test-rules-fetcher.js — no duplication here.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { parseRules, extractSlug } = require('../parse-rules');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DG_UNIT = {
  name: 'Plague Marines',
  _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Plague-Marines',
  stats: { M: '5"', T: '5', Sv: '3+', W: '2', Ld: '6+', OC: '2' },
  weapons: [{ name: 'Plague boltgun', type: 'Ranged' }],
  abilities: [{ name: 'Contagion of Nurgle', description: 'desc' }],
  keywords: ['INFANTRY', 'CHAOS', 'NURGLE', 'DEATH GUARD', 'PLAGUE MARINES'],
  points: '180 pts',
};

const FW_UNIT = {
  name: 'Spartan',
  _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Spartan',
  stats: {},
  weapons: [],
  abilities: [],
  keywords: ['VEHICLE', 'CHAOS', 'SPARTAN'],
  points: '400 pts',
};

const SUMMONED_UNIT = {
  name: 'Plaguebearers',
  _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Plaguebearers',
  stats: {},
  weapons: [],
  abilities: [],
  keywords: ['INFANTRY', 'CHAOS', 'DAEMON', 'NURGLE', 'SUMMONED', 'PLAGUEBEARERS'],
  points: '80 pts',
};

const DAEMON_ENGINE_UNIT = {
  name: 'Plagueburst Crawler',
  _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Plagueburst-Crawler',
  stats: {},
  weapons: [],
  abilities: [],
  keywords: ['VEHICLE', 'CHAOS', 'NURGLE', 'DAEMON', 'PLAGUEBURST CRAWLER'],
  points: '150 pts',
};

function makeRulesData(units = [DG_UNIT], detachments = []) {
  return {
    faction: 'death-guard',
    edition: '10ed',
    fetchedAt: '2026-04-13T10:00:00.000Z',
    factionAbilities: [],
    detachments,
    units,
  };
}

// ---------------------------------------------------------------------------
// extractSlug
// ---------------------------------------------------------------------------

test('extractSlug extracts last path segment from _url', () => {
  assert.equal(extractSlug({ _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Plague-Marines' }), 'Plague-Marines');
  assert.equal(extractSlug({ _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Sokar-pattern-Stormbird' }), 'Sokar-pattern-Stormbird');
});

test('extractSlug returns null for missing _url or null unit', () => {
  assert.equal(extractSlug({ name: 'Some Unit' }), null);
  assert.equal(extractSlug(null), null);
});

// ---------------------------------------------------------------------------
// parseRules — Forge World filtering
// ---------------------------------------------------------------------------

test('parseRules removes FW units and keeps non-FW units', () => {
  const { cleaned, stats } = parseRules(makeRulesData([FW_UNIT]), 'death-guard');
  assert.equal(cleaned.units.length, 0);
  assert.equal(stats.forgeWorldRemoved, 1);

  const { cleaned: c2, stats: s2 } = parseRules(makeRulesData([DG_UNIT]), 'death-guard');
  assert.equal(c2.units.length, 1);
  assert.equal(s2.forgeWorldRemoved, 0);
});

test('parseRules keeps a unit with no _url field (failsafe)', () => {
  const noUrl = { ...DG_UNIT };
  delete noUrl._url;
  const { cleaned } = parseRules(makeRulesData([noUrl]), 'death-guard');
  assert.equal(cleaned.units.length, 1);
});

// ---------------------------------------------------------------------------
// parseRules — SUMMONED daemon filtering
// ---------------------------------------------------------------------------

test('parseRules removes SUMMONED units and keeps daemon engines', () => {
  const { cleaned, stats } = parseRules(makeRulesData([SUMMONED_UNIT]), 'death-guard');
  assert.equal(cleaned.units.length, 0);
  assert.equal(stats.summonedRemoved, 1);

  const { cleaned: c2 } = parseRules(makeRulesData([DAEMON_ENGINE_UNIT]), 'death-guard');
  assert.equal(c2.units.length, 1);
});

// ---------------------------------------------------------------------------
// parseRules — deduplication
// ---------------------------------------------------------------------------

test('parseRules deduplicates units by name (case-insensitive)', () => {
  const dup = { ...DG_UNIT, weapons: [] };
  const { cleaned } = parseRules(makeRulesData([DG_UNIT, dup]), 'death-guard');
  assert.equal(cleaned.units.length, 1);

  const lower = { ...DG_UNIT, name: 'plague marines' };
  const { cleaned: c2 } = parseRules(makeRulesData([DG_UNIT, lower]), 'death-guard');
  assert.equal(c2.units.length, 1);

  const { cleaned: c3 } = parseRules(makeRulesData([DG_UNIT, DAEMON_ENGINE_UNIT]), 'death-guard');
  assert.equal(c3.units.length, 2);
});

test('parseRules deduplicates detachments and handles empty/missing arrays', () => {
  const dets = [
    { name: 'Virulent Vectorium', stratagems: [], enhancements: [] },
    { name: 'Virulent Vectorium', stratagems: [], enhancements: [] },
  ];
  const { cleaned, stats } = parseRules(makeRulesData([DG_UNIT], dets), 'death-guard');
  assert.equal(cleaned.detachments.length, 1);
  assert.equal(stats.detachmentsBefore, 2);
  assert.equal(stats.detachmentsAfter, 1);

  const { cleaned: c2 } = parseRules(makeRulesData([DG_UNIT], []), 'death-guard');
  assert.deepEqual(c2.detachments, []);

  const raw = makeRulesData([DG_UNIT]);
  delete raw.detachments;
  const { cleaned: c3 } = parseRules(raw, 'death-guard');
  assert.deepEqual(c3.detachments, []);
});

// ---------------------------------------------------------------------------
// parseRules — validation warnings
// ---------------------------------------------------------------------------

test('parseRules warns for unnamed units, not for units with empty stats/weapons', () => {
  const unnamed = { ...DG_UNIT, name: '' };
  const { stats } = parseRules(makeRulesData([unnamed]), 'death-guard');
  assert.ok(stats.validationWarnings.length > 0);

  const { stats: s2 } = parseRules(makeRulesData([{ ...DG_UNIT, stats: {} }]), 'death-guard');
  assert.equal(s2.validationWarnings.length, 0);

  const { stats: s3 } = parseRules(makeRulesData([DG_UNIT]), 'death-guard');
  assert.equal(s3.validationWarnings.length, 0);
});

// ---------------------------------------------------------------------------
// parseRules — stats and output shape
// ---------------------------------------------------------------------------

test('parseRules stats reflect correct before/after counts', () => {
  const input = makeRulesData([DG_UNIT, FW_UNIT, SUMMONED_UNIT]);
  const { stats } = parseRules(input, 'death-guard');
  assert.equal(stats.unitsBefore, 3);
  assert.equal(stats.unitsAfter, 1);
  assert.equal(stats.forgeWorldRemoved, 1);
  assert.equal(stats.summonedRemoved, 1);
  assert.ok(Array.isArray(stats.validationWarnings));
});

test('parseRules output has correct shape and preserves input fields', () => {
  const raw = makeRulesData([DG_UNIT]);
  raw.factionAbilities = [{ name: 'Disgustingly Resilient', description: 'desc' }];
  const { cleaned } = parseRules(raw, 'death-guard');

  assert.ok(typeof cleaned.parsedAt === 'string');
  assert.ok(!isNaN(Date.parse(cleaned.parsedAt)));
  assert.equal(cleaned.faction, 'death-guard');
  assert.equal(cleaned.edition, '10ed');
  assert.ok(Array.isArray(cleaned.units));
  assert.ok(Array.isArray(cleaned.detachments));
  assert.equal(cleaned.factionAbilities.length, 1);
});

test('parseRules is a pure function — does not mutate input', () => {
  const raw = makeRulesData([DG_UNIT, FW_UNIT]);
  const originalLength = raw.units.length;
  parseRules(raw, 'death-guard');
  assert.equal(raw.units.length, originalLength);
});
