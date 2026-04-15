'use strict';

/**
 * Unit tests for pure (non-Playwright) functions in rules-fetcher.js.
 * These tests do not launch a browser.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const {
  isFresh,
  buildFactionUrl,
  buildUnitUrl,
  rulesToText,
  estimateTokens,
  truncateToTokenBudget,
  parseDetachmentsFromRaw,
  hasFactionKeyword,
  deduplicateUnit,
  deduplicateDetachments,
  FORGE_WORLD_SLUGS,
} = require('../rules-fetcher');

// Temp dir for isFresh file tests
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-fetcher-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// isFresh
// ---------------------------------------------------------------------------

test('isFresh returns false for nonexistent file', () => {
  assert.equal(isFresh(path.join(TMP, 'nonexistent.json')), false);
});

test('isFresh returns true when fetchedAt is within maxDays', () => {
  const p = path.join(TMP, 'fresh.json');
  fs.writeFileSync(p, JSON.stringify({ fetchedAt: new Date().toISOString() }), 'utf-8');
  assert.equal(isFresh(p, 7), true);
});

test('isFresh returns false when fetchedAt exceeds maxDays', () => {
  const p = path.join(TMP, 'stale.json');
  const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(p, JSON.stringify({ fetchedAt: oldDate }), 'utf-8');
  assert.equal(isFresh(p, 7), false);
});

test('isFresh returns false for missing fetchedAt or invalid JSON', () => {
  const noDate = path.join(TMP, 'no-date.json');
  fs.writeFileSync(noDate, JSON.stringify({ faction: 'death-guard' }), 'utf-8');
  assert.equal(isFresh(noDate, 7), false);

  const badJson = path.join(TMP, 'bad.json');
  fs.writeFileSync(badJson, 'not json', 'utf-8');
  assert.equal(isFresh(badJson, 7), false);
});

// ---------------------------------------------------------------------------
// buildFactionUrl / buildUnitUrl
// ---------------------------------------------------------------------------

test('buildFactionUrl constructs correct wahapedia URLs', () => {
  assert.equal(buildFactionUrl('death-guard', '10ed'), 'https://wahapedia.ru/wh40k10ed/factions/death-guard/');
  assert.equal(buildFactionUrl('tyranids', '10ed'), 'https://wahapedia.ru/wh40k10ed/factions/tyranids/');
  assert.equal(buildFactionUrl('death-guard', '11ed'), 'https://wahapedia.ru/wh40k11ed/factions/death-guard/');
});

test('buildUnitUrl constructs the correct unit datasheet URL', () => {
  const url = buildUnitUrl('death-guard', '10ed', 'Daemon-Prince-of-Nurgle');
  assert.equal(url, 'https://wahapedia.ru/wh40k10ed/factions/death-guard/Daemon-Prince-of-Nurgle');
});

// ---------------------------------------------------------------------------
// rulesToText
// ---------------------------------------------------------------------------

const MINIMAL_RULES = {
  faction: 'death-guard',
  edition: '10ed',
  fetchedAt: '2026-04-13T10:00:00.000Z',
  factionAbilities: [
    { name: 'Disgustingly Resilient', description: 'Each time a model in this unit would lose a wound...' },
  ],
  detachments: [
    {
      name: 'Virulent Vectorium',
      ability: 'Spread the Sickness',
      stratagems: [
        { name: 'Cloud of Flies', cp: '1 CP', description: 'Target unit has Stealth.' },
      ],
      enhancements: [
        { name: 'Suppurating Plate', description: '+1 to saving throws.' },
      ],
    },
  ],
  units: [
    {
      name: 'Plague Marines',
      stats: { M: '5"', T: '5', Sv: '3+', W: '2', Ld: '6+', OC: '2' },
      weapons: [
        { name: 'Plague boltgun', type: 'Ranged', range: '24"', a: '2', bs: '3+', s: '4', ap: '-1', d: '1', abilities: 'Lethal Hits, Plague Weapon' },
      ],
      abilities: [
        { name: 'Contagion of Nurgle', description: 'Reduces Toughness of nearby enemies.' },
      ],
      keywords: ['Infantry', 'Chaos', 'Nurgle', 'Death Guard', 'Plague Marines'],
      points: '180 pts',
    },
  ],
};

test('rulesToText includes all expected sections', () => {
  const txt = rulesToText(MINIMAL_RULES);
  assert.ok(txt.length > 0);
  assert.ok(txt.includes('DEATH GUARD'));
  assert.ok(txt.includes('Disgustingly Resilient'));
  assert.ok(txt.includes('Virulent Vectorium'));
  assert.ok(txt.includes('Cloud of Flies'));
  assert.ok(txt.includes('Suppurating Plate'));
  assert.ok(txt.includes('Plague Marines'));
  assert.ok(txt.includes('M: 5"') && txt.includes('T: 5'));
  assert.ok(txt.includes('Plague boltgun'));
});

test('rulesToText handles null and missing sections gracefully', () => {
  assert.equal(rulesToText(null), '');
  const txt = rulesToText({ faction: 'death-guard', edition: '10ed', fetchedAt: new Date().toISOString() });
  assert.ok(txt.includes('DEATH GUARD'));
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

test('estimateTokens returns approximately chars/4', () => {
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('hello'), 2); // ceil(5/4)
});

// ---------------------------------------------------------------------------
// truncateToTokenBudget
// ---------------------------------------------------------------------------

test('truncateToTokenBudget passes through short text, truncates long text', () => {
  assert.equal(truncateToTokenBudget('short text', 1000), 'short text');
  assert.equal(truncateToTokenBudget('a'.repeat(100), 100), 'a'.repeat(100));
  assert.equal(truncateToTokenBudget(null, 100), null);

  const longText = 'x'.repeat(500);
  const result = truncateToTokenBudget(longText, 100);
  assert.ok(result.length <= 150); // some slack for truncation notice
  assert.ok(result.includes('[Document truncated'));
});

// ---------------------------------------------------------------------------
// parseDetachmentsFromRaw
// ---------------------------------------------------------------------------

test('parseDetachmentsFromRaw parses sections into detachment objects', () => {
  const sections = [
    { name: 'Virulent Vectorium', rawText: 'Virulent Vectorium\nSpread the Sickness ability text here.\nCloud of Flies\n1CP\nThis is a stratagem.' },
  ];
  const result = parseDetachmentsFromRaw(sections);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Virulent Vectorium');

  assert.deepEqual(parseDetachmentsFromRaw([]), []);
});

test('parseDetachmentsFromRaw preserves detachment name', () => {
  const sections = [{ name: "Mortarion's Hammer", rawText: 'Some text here.' }];
  const result = parseDetachmentsFromRaw(sections);
  assert.equal(result[0].name, "Mortarion's Hammer");
});

// ---------------------------------------------------------------------------
// hasFactionKeyword
// ---------------------------------------------------------------------------

test('hasFactionKeyword matches faction slug and is case-insensitive', () => {
  assert.equal(hasFactionKeyword({ keywords: ['Infantry', 'Chaos', 'Death Guard', 'Nurgle'] }, 'death-guard'), true);
  assert.equal(hasFactionKeyword({ keywords: ['DEATH GUARD', 'NURGLE'] }, 'death-guard'), true);
  assert.equal(hasFactionKeyword({ keywords: ['Infantry', 'Tyranids', 'Synapse'] }, 'tyranids'), true);
});

test('hasFactionKeyword returns true (failsafe) when keywords are empty or missing', () => {
  assert.equal(hasFactionKeyword({ keywords: [] }, 'death-guard'), true);
  assert.equal(hasFactionKeyword({ name: 'Unknown Unit' }, 'death-guard'), true);
});

test('hasFactionKeyword excludes SUMMONED daemons but keeps daemon engines', () => {
  assert.equal(
    hasFactionKeyword({ keywords: ['Infantry', 'Chaos', 'Daemon', 'Nurgle', 'SUMMONED', 'Plaguebearers'] }, 'death-guard'),
    false
  );
  assert.equal(
    hasFactionKeyword({ keywords: ['VEHICLE', 'CHAOS', 'NURGLE', 'DAEMON', 'PLAGUEBURST CRAWLER'] }, 'death-guard'),
    true
  );
  // Poxwalkers: no faction keyword, no SUMMONED → kept
  assert.equal(
    hasFactionKeyword({ keywords: ['INFANTRY', 'CHAOS', 'NURGLE', 'POXWALKERS'] }, 'death-guard'),
    true
  );
});

// ---------------------------------------------------------------------------
// deduplicateUnit
// ---------------------------------------------------------------------------

test('deduplicateUnit removes duplicate weapons and abilities', () => {
  const unit = {
    weapons: [
      { name: 'Plague boltgun', a: '2' },
      { name: 'Plague boltgun', a: '2' },
      { name: 'Blight grenades', a: 'D6' },
    ],
    abilities: [
      { name: 'Contagion of Nurgle', description: 'desc' },
      { name: 'Contagion of Nurgle', description: 'desc' },
      { name: 'Disgustingly Resilient', description: 'desc2' },
    ],
  };
  deduplicateUnit(unit);
  assert.equal(unit.weapons.length, 2);
  assert.equal(unit.abilities.length, 2);
});

test('deduplicateUnit is a no-op when no duplicates and handles missing arrays', () => {
  const unit = { weapons: [{ name: 'A' }, { name: 'B' }], abilities: [{ name: 'C' }] };
  deduplicateUnit(unit);
  assert.equal(unit.weapons.length, 2);
  assert.equal(unit.abilities.length, 1);

  // Missing arrays: no throw
  assert.doesNotThrow(() => deduplicateUnit({ abilities: [{ name: 'A' }] }));
  assert.doesNotThrow(() => deduplicateUnit({ weapons: [{ name: 'W' }] }));

  // Returns the unit object
  const u2 = { weapons: [], abilities: [] };
  assert.strictEqual(deduplicateUnit(u2), u2);
});

// ---------------------------------------------------------------------------
// deduplicateDetachments
// ---------------------------------------------------------------------------

test('deduplicateDetachments removes duplicate detachments, stratagems, and enhancements', () => {
  const detachments = [
    {
      name: 'Virulent Vectorium',
      stratagems: [
        { name: 'Cloud of Flies', cp: '1 CP' },
        { name: 'Cloud of Flies', cp: '1 CP' },
        { name: 'Plague of Attrition', cp: '2 CP' },
      ],
      enhancements: [
        { name: 'Suppurating Plate' },
        { name: 'Suppurating Plate' },
        { name: 'Droning Halo' },
      ],
    },
    { name: 'Virulent Vectorium', stratagems: [], enhancements: [] },
    { name: "Mortarion's Hammer", stratagems: [], enhancements: [] },
  ];
  const result = deduplicateDetachments(detachments);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Virulent Vectorium');
  assert.equal(result[0].stratagems.length, 2);
  assert.equal(result[0].enhancements.length, 2);
  assert.equal(result[1].name, "Mortarion's Hammer");
});

test('deduplicateDetachments handles empty array and missing fields', () => {
  assert.deepEqual(deduplicateDetachments([]), []);

  const detachments = [{ name: 'Test Detachment', ability: 'Some ability' }];
  assert.doesNotThrow(() => deduplicateDetachments(detachments));
  assert.equal(deduplicateDetachments(detachments).length, 1);
});

// ---------------------------------------------------------------------------
// FORGE_WORLD_SLUGS
// ---------------------------------------------------------------------------

test('FORGE_WORLD_SLUGS is populated and contains expected entries', () => {
  assert.ok(FORGE_WORLD_SLUGS instanceof Set);
  assert.ok(FORGE_WORLD_SLUGS.size > 0);
  assert.ok(FORGE_WORLD_SLUGS.has('Spartan'));
  assert.ok(FORGE_WORLD_SLUGS.has('Typhon'));
  assert.ok(FORGE_WORLD_SLUGS.has('Leviathan-Dreadnought'));
  assert.ok(!FORGE_WORLD_SLUGS.has('Plague-Marines'));
  assert.ok(!FORGE_WORLD_SLUGS.has('Mortarion'));
});
