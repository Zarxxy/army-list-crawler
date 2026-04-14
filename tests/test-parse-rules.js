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

/** A minimal clean Death Guard unit with all expected fields. */
const DG_UNIT = {
  name: 'Plague Marines',
  _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Plague-Marines',
  stats: { M: '5"', T: '5', Sv: '3+', W: '2', Ld: '6+', OC: '2' },
  weapons: [{ name: 'Plague boltgun', type: 'Ranged' }],
  abilities: [{ name: 'Contagion of Nurgle', description: 'desc' }],
  keywords: ['INFANTRY', 'CHAOS', 'NURGLE', 'DEATH GUARD', 'PLAGUE MARINES'],
  points: '180 pts',
};

/** A Forge World unit whose slug appears in the FORGE_WORLD_SLUGS blocklist. */
const FW_UNIT = {
  name: 'Spartan',
  _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Spartan',
  stats: {},
  weapons: [],
  abilities: [],
  keywords: ['VEHICLE', 'CHAOS', 'SPARTAN'],
  points: '400 pts',
};

/** A summoned daemon ally — excluded because of SUMMONED keyword. */
const SUMMONED_UNIT = {
  name: 'Plaguebearers',
  _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Plaguebearers',
  stats: {},
  weapons: [],
  abilities: [],
  keywords: ['INFANTRY', 'CHAOS', 'DAEMON', 'NURGLE', 'SUMMONED', 'PLAGUEBEARERS'],
  points: '80 pts',
};

/** A Daemon Engine — no SUMMONED keyword, so it's kept (failsafe). */
const DAEMON_ENGINE_UNIT = {
  name: 'Plagueburst Crawler',
  _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Plagueburst-Crawler',
  stats: {},
  weapons: [],
  abilities: [],
  keywords: ['VEHICLE', 'CHAOS', 'NURGLE', 'DAEMON', 'PLAGUEBURST CRAWLER'],
  points: '150 pts',
};

/** Minimal valid rules input with one clean unit and one detachment. */
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

test('extractSlug returns the last path segment of _url', () => {
  const unit = { _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Plague-Marines' };
  assert.equal(extractSlug(unit), 'Plague-Marines');
});

test('extractSlug returns null when _url is absent', () => {
  assert.equal(extractSlug({ name: 'Some Unit' }), null);
});

test('extractSlug returns null when unit is null', () => {
  assert.equal(extractSlug(null), null);
});

test('extractSlug handles a Sokar-pattern-Stormbird slug correctly', () => {
  const unit = { _url: 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Sokar-pattern-Stormbird' };
  assert.equal(extractSlug(unit), 'Sokar-pattern-Stormbird');
});

// ---------------------------------------------------------------------------
// parseRules — Forge World filtering
// ---------------------------------------------------------------------------

test('parseRules removes a unit whose _url slug is in the FW blocklist', () => {
  const { cleaned, stats } = parseRules(makeRulesData([FW_UNIT]), 'death-guard');
  assert.equal(cleaned.units.length, 0);
  assert.equal(stats.forgeWorldRemoved, 1);
});

test('parseRules keeps a unit whose _url slug is not in the FW blocklist', () => {
  const { cleaned, stats } = parseRules(makeRulesData([DG_UNIT]), 'death-guard');
  assert.equal(cleaned.units.length, 1);
  assert.equal(stats.forgeWorldRemoved, 0);
});

test('parseRules keeps a unit with no _url field (cannot confirm FW — failsafe)', () => {
  const noUrl = { ...DG_UNIT };
  delete noUrl._url;
  const { cleaned } = parseRules(makeRulesData([noUrl]), 'death-guard');
  assert.equal(cleaned.units.length, 1);
});

test('parseRules handles an empty units array without throwing', () => {
  const { cleaned } = parseRules(makeRulesData([]), 'death-guard');
  assert.deepEqual(cleaned.units, []);
});

// ---------------------------------------------------------------------------
// parseRules — SUMMONED daemon filtering
// ---------------------------------------------------------------------------

test('parseRules removes a unit with SUMMONED keyword', () => {
  const { cleaned, stats } = parseRules(makeRulesData([SUMMONED_UNIT]), 'death-guard');
  assert.equal(cleaned.units.length, 0);
  assert.equal(stats.summonedRemoved, 1);
});

test('parseRules keeps a daemon engine without SUMMONED keyword', () => {
  const { cleaned } = parseRules(makeRulesData([DAEMON_ENGINE_UNIT]), 'death-guard');
  assert.equal(cleaned.units.length, 1);
});

test('parseRules keeps a unit with no keywords at all (failsafe)', () => {
  const noKw = { ...DG_UNIT, keywords: [] };
  const { cleaned } = parseRules(makeRulesData([noKw]), 'death-guard');
  assert.equal(cleaned.units.length, 1);
});

// ---------------------------------------------------------------------------
// parseRules — unit name deduplication
// ---------------------------------------------------------------------------

test('parseRules removes a second unit with the same name', () => {
  const dup = { ...DG_UNIT, weapons: [] };
  const { cleaned } = parseRules(makeRulesData([DG_UNIT, dup]), 'death-guard');
  assert.equal(cleaned.units.length, 1);
});

test('parseRules name deduplication is case-insensitive', () => {
  const lower = { ...DG_UNIT, name: 'plague marines' };
  const { cleaned } = parseRules(makeRulesData([DG_UNIT, lower]), 'death-guard');
  assert.equal(cleaned.units.length, 1);
});

test('parseRules keeps units with distinct names', () => {
  const { cleaned } = parseRules(makeRulesData([DG_UNIT, DAEMON_ENGINE_UNIT]), 'death-guard');
  assert.equal(cleaned.units.length, 2);
});

// ---------------------------------------------------------------------------
// parseRules — detachment deduplication
// ---------------------------------------------------------------------------

test('parseRules deduplicates detachments by name', () => {
  const dets = [
    { name: 'Virulent Vectorium', stratagems: [], enhancements: [] },
    { name: 'Virulent Vectorium', stratagems: [], enhancements: [] },
  ];
  const { cleaned, stats } = parseRules(makeRulesData([DG_UNIT], dets), 'death-guard');
  assert.equal(cleaned.detachments.length, 1);
  assert.equal(stats.detachmentsBefore, 2);
  assert.equal(stats.detachmentsAfter, 1);
});

test('parseRules handles an empty detachments array', () => {
  const { cleaned } = parseRules(makeRulesData([DG_UNIT], []), 'death-guard');
  assert.deepEqual(cleaned.detachments, []);
});

test('parseRules tolerates missing detachments field on input', () => {
  const raw = makeRulesData([DG_UNIT]);
  delete raw.detachments;
  const { cleaned } = parseRules(raw, 'death-guard');
  assert.deepEqual(cleaned.detachments, []);
});

// ---------------------------------------------------------------------------
// parseRules — validation warnings
// ---------------------------------------------------------------------------

test('parseRules emits a warning for a unit with no name', () => {
  const unnamed = { ...DG_UNIT, name: '' };
  const { stats } = parseRules(makeRulesData([unnamed]), 'death-guard');
  assert.ok(stats.validationWarnings.length > 0);
});

test('parseRules does not warn for a unit with empty stats (known scraper limitation)', () => {
  const noStats = { ...DG_UNIT, stats: {} };
  const { stats } = parseRules(makeRulesData([noStats]), 'death-guard');
  assert.equal(stats.validationWarnings.length, 0);
});

test('parseRules does not warn for a unit with empty weapons (known scraper limitation)', () => {
  const noWeapons = { ...DG_UNIT, weapons: [] };
  const { stats } = parseRules(makeRulesData([noWeapons]), 'death-guard');
  assert.equal(stats.validationWarnings.length, 0);
});

test('parseRules does not warn for a clean unit', () => {
  const { stats } = parseRules(makeRulesData([DG_UNIT]), 'death-guard');
  assert.equal(stats.validationWarnings.length, 0);
});

// ---------------------------------------------------------------------------
// parseRules — stats counters
// ---------------------------------------------------------------------------

test('parseRules stats reflect correct before/after counts', () => {
  const input = makeRulesData([DG_UNIT, FW_UNIT, SUMMONED_UNIT]);
  const { stats } = parseRules(input, 'death-guard');
  assert.equal(stats.unitsBefore, 3);
  assert.equal(stats.unitsAfter, 1);
  assert.equal(stats.forgeWorldRemoved, 1);
  assert.equal(stats.summonedRemoved, 1);
});

test('parseRules stats.validationWarnings is always an array', () => {
  const { stats } = parseRules(makeRulesData([DG_UNIT]), 'death-guard');
  assert.ok(Array.isArray(stats.validationWarnings));
});

// ---------------------------------------------------------------------------
// parseRules — output shape
// ---------------------------------------------------------------------------

test('parseRules stamps parsedAt as a valid ISO date string', () => {
  const { cleaned } = parseRules(makeRulesData([DG_UNIT]), 'death-guard');
  assert.ok(typeof cleaned.parsedAt === 'string');
  assert.ok(!isNaN(Date.parse(cleaned.parsedAt)));
});

test('parseRules preserves faction and edition from input', () => {
  const { cleaned } = parseRules(makeRulesData([DG_UNIT]), 'death-guard');
  assert.equal(cleaned.faction, 'death-guard');
  assert.equal(cleaned.edition, '10ed');
});

test('parseRules preserves factionAbilities from input', () => {
  const raw = makeRulesData([DG_UNIT]);
  raw.factionAbilities = [{ name: 'Disgustingly Resilient', description: 'desc' }];
  const { cleaned } = parseRules(raw, 'death-guard');
  assert.equal(cleaned.factionAbilities.length, 1);
});

test('parseRules output units is an array', () => {
  const { cleaned } = parseRules(makeRulesData([DG_UNIT]), 'death-guard');
  assert.ok(Array.isArray(cleaned.units));
});

test('parseRules output detachments is an array', () => {
  const { cleaned } = parseRules(makeRulesData([DG_UNIT]), 'death-guard');
  assert.ok(Array.isArray(cleaned.detachments));
});

test('parseRules is a pure function — does not mutate input', () => {
  const raw = makeRulesData([DG_UNIT, FW_UNIT]);
  const originalLength = raw.units.length;
  parseRules(raw, 'death-guard');
  assert.equal(raw.units.length, originalLength);
});
