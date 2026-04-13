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
} = require('../rules-fetcher');

// Temp dir for isFresh file tests
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-fetcher-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// isFresh
// ---------------------------------------------------------------------------

test('isFresh returns false when file does not exist', () => {
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

test('isFresh returns false when fetchedAt is missing', () => {
  const p = path.join(TMP, 'no-date.json');
  fs.writeFileSync(p, JSON.stringify({ faction: 'death-guard' }), 'utf-8');
  assert.equal(isFresh(p, 7), false);
});

test('isFresh returns false when file contains invalid JSON', () => {
  const p = path.join(TMP, 'bad.json');
  fs.writeFileSync(p, 'not json', 'utf-8');
  assert.equal(isFresh(p, 7), false);
});

// ---------------------------------------------------------------------------
// buildFactionUrl
// ---------------------------------------------------------------------------

test('buildFactionUrl constructs the correct wahapedia URL', () => {
  const url = buildFactionUrl('death-guard', '10ed');
  assert.equal(url, 'https://wahapedia.ru/wh40k10ed/factions/death-guard/');
});

test('buildFactionUrl supports different editions', () => {
  const url = buildFactionUrl('death-guard', '11ed');
  assert.equal(url, 'https://wahapedia.ru/wh40k11ed/factions/death-guard/');
});

test('buildFactionUrl supports different factions', () => {
  const url = buildFactionUrl('tyranids', '10ed');
  assert.equal(url, 'https://wahapedia.ru/wh40k10ed/factions/tyranids/');
});

// ---------------------------------------------------------------------------
// buildUnitUrl
// ---------------------------------------------------------------------------

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

test('rulesToText returns a non-empty string for valid input', () => {
  const txt = rulesToText(MINIMAL_RULES);
  assert.ok(txt.length > 0);
});

test('rulesToText includes the faction name in the header', () => {
  const txt = rulesToText(MINIMAL_RULES);
  assert.ok(txt.includes('DEATH GUARD'));
});

test('rulesToText includes faction ability names', () => {
  const txt = rulesToText(MINIMAL_RULES);
  assert.ok(txt.includes('Disgustingly Resilient'));
});

test('rulesToText includes detachment names', () => {
  const txt = rulesToText(MINIMAL_RULES);
  assert.ok(txt.includes('Virulent Vectorium'));
});

test('rulesToText includes stratagem names', () => {
  const txt = rulesToText(MINIMAL_RULES);
  assert.ok(txt.includes('Cloud of Flies'));
});

test('rulesToText includes enhancement names', () => {
  const txt = rulesToText(MINIMAL_RULES);
  assert.ok(txt.includes('Suppurating Plate'));
});

test('rulesToText includes unit names', () => {
  const txt = rulesToText(MINIMAL_RULES);
  assert.ok(txt.includes('Plague Marines'));
});

test('rulesToText includes unit stat line', () => {
  const txt = rulesToText(MINIMAL_RULES);
  assert.ok(txt.includes('M: 5"') && txt.includes('T: 5'));
});

test('rulesToText includes weapon names', () => {
  const txt = rulesToText(MINIMAL_RULES);
  assert.ok(txt.includes('Plague boltgun'));
});

test('rulesToText returns empty string for null input', () => {
  assert.equal(rulesToText(null), '');
});

test('rulesToText handles missing sections gracefully', () => {
  const txt = rulesToText({ faction: 'death-guard', edition: '10ed', fetchedAt: new Date().toISOString() });
  assert.ok(txt.includes('DEATH GUARD'));
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

test('estimateTokens returns approximately chars/4', () => {
  const text = 'a'.repeat(400);
  assert.equal(estimateTokens(text), 100);
});

test('estimateTokens returns 0 for empty string', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens returns 0 for null', () => {
  assert.equal(estimateTokens(null), 0);
});

test('estimateTokens rounds up', () => {
  // 5 chars → ceil(5/4) = 2
  assert.equal(estimateTokens('hello'), 2);
});

// ---------------------------------------------------------------------------
// truncateToTokenBudget
// ---------------------------------------------------------------------------

test('truncateToTokenBudget returns text unchanged when under limit', () => {
  const text = 'short text';
  assert.equal(truncateToTokenBudget(text, 1000), text);
});

test('truncateToTokenBudget truncates to maxChars', () => {
  const text = 'a'.repeat(200) + '\n' + 'b'.repeat(200);
  const result = truncateToTokenBudget(text, 100);
  assert.ok(result.length <= 100 + 50); // some slack for the notice
});

test('truncateToTokenBudget appends a truncation notice', () => {
  const text = 'x'.repeat(500);
  const result = truncateToTokenBudget(text, 100);
  assert.ok(result.includes('[Document truncated'));
});

test('truncateToTokenBudget returns text unchanged when exactly at limit', () => {
  const text = 'a'.repeat(100);
  assert.equal(truncateToTokenBudget(text, 100), text);
});

test('truncateToTokenBudget handles null gracefully', () => {
  assert.equal(truncateToTokenBudget(null, 100), null);
});

// ---------------------------------------------------------------------------
// parseDetachmentsFromRaw
// ---------------------------------------------------------------------------

test('parseDetachmentsFromRaw returns an array of detachment objects', () => {
  const sections = [
    { name: 'Virulent Vectorium', rawText: 'Virulent Vectorium\nSpread the Sickness ability text here.\nCloud of Flies\n1CP\nThis is a stratagem.' },
  ];
  const result = parseDetachmentsFromRaw(sections);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Virulent Vectorium');
});

test('parseDetachmentsFromRaw handles empty sections array', () => {
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

test('hasFactionKeyword returns true when keyword matches faction slug', () => {
  const unit = { keywords: ['Infantry', 'Chaos', 'Death Guard', 'Nurgle'] };
  assert.equal(hasFactionKeyword(unit, 'death-guard'), true);
});

test('hasFactionKeyword returns true when no keywords extracted (failsafe)', () => {
  const unit = { keywords: [] };
  assert.equal(hasFactionKeyword(unit, 'death-guard'), true);
});

test('hasFactionKeyword returns true when keywords field is missing', () => {
  const unit = { name: 'Unknown Unit' };
  assert.equal(hasFactionKeyword(unit, 'death-guard'), true);
});

test('hasFactionKeyword returns false for daemon unit with wrong keywords', () => {
  const unit = { keywords: ['Infantry', 'Chaos', 'Daemon', 'Nurgle'] };
  assert.equal(hasFactionKeyword(unit, 'death-guard'), false);
});

test('hasFactionKeyword returns false for Chaos Daemon ally unit', () => {
  const unit = { keywords: ['Chaos Daemon', 'Nurgle', 'Plaguebearer'] };
  assert.equal(hasFactionKeyword(unit, 'death-guard'), false);
});

test('hasFactionKeyword is case-insensitive', () => {
  const unit = { keywords: ['DEATH GUARD', 'NURGLE'] };
  assert.equal(hasFactionKeyword(unit, 'death-guard'), true);
});

test('hasFactionKeyword works for other faction slugs', () => {
  const unit = { keywords: ['Infantry', 'Tyranids', 'Synapse'] };
  assert.equal(hasFactionKeyword(unit, 'tyranids'), true);
  assert.equal(hasFactionKeyword(unit, 'death-guard'), false);
});

// ---------------------------------------------------------------------------
// deduplicateUnit
// ---------------------------------------------------------------------------

test('deduplicateUnit removes duplicate weapons by name', () => {
  const unit = {
    weapons: [
      { name: 'Plague boltgun', a: '2' },
      { name: 'Plague boltgun', a: '2' }, // duplicate
      { name: 'Blight grenades', a: 'D6' },
    ],
    abilities: [],
  };
  deduplicateUnit(unit);
  assert.equal(unit.weapons.length, 2);
  assert.equal(unit.weapons[0].name, 'Plague boltgun');
  assert.equal(unit.weapons[1].name, 'Blight grenades');
});

test('deduplicateUnit removes duplicate abilities by name', () => {
  const unit = {
    weapons: [],
    abilities: [
      { name: 'Contagion of Nurgle', description: 'desc' },
      { name: 'Contagion of Nurgle', description: 'desc' }, // duplicate
      { name: 'Disgustingly Resilient', description: 'desc2' },
    ],
  };
  deduplicateUnit(unit);
  assert.equal(unit.abilities.length, 2);
});

test('deduplicateUnit is a no-op when no duplicates', () => {
  const unit = {
    weapons: [{ name: 'Weapon A' }, { name: 'Weapon B' }],
    abilities: [{ name: 'Ability A' }],
  };
  deduplicateUnit(unit);
  assert.equal(unit.weapons.length, 2);
  assert.equal(unit.abilities.length, 1);
});

test('deduplicateUnit handles missing weapons array gracefully', () => {
  const unit = { abilities: [{ name: 'A' }] };
  assert.doesNotThrow(() => deduplicateUnit(unit));
});

test('deduplicateUnit handles missing abilities array gracefully', () => {
  const unit = { weapons: [{ name: 'W' }] };
  assert.doesNotThrow(() => deduplicateUnit(unit));
});

test('deduplicateUnit returns the unit object', () => {
  const unit = { weapons: [], abilities: [] };
  assert.strictEqual(deduplicateUnit(unit), unit);
});

// ---------------------------------------------------------------------------
// deduplicateDetachments
// ---------------------------------------------------------------------------

test('deduplicateDetachments removes detachment with same name', () => {
  const detachments = [
    { name: 'Virulent Vectorium', stratagems: [], enhancements: [] },
    { name: 'Virulent Vectorium', stratagems: [], enhancements: [] }, // duplicate
    { name: "Mortarion's Hammer", stratagems: [], enhancements: [] },
  ];
  const result = deduplicateDetachments(detachments);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Virulent Vectorium');
  assert.equal(result[1].name, "Mortarion's Hammer");
});

test('deduplicateDetachments deduplicates stratagems within a detachment', () => {
  const detachments = [
    {
      name: 'Virulent Vectorium',
      stratagems: [
        { name: 'Cloud of Flies', cp: '1 CP' },
        { name: 'Cloud of Flies', cp: '1 CP' }, // duplicate
        { name: 'Plague of Attrition', cp: '2 CP' },
      ],
      enhancements: [],
    },
  ];
  const result = deduplicateDetachments(detachments);
  assert.equal(result[0].stratagems.length, 2);
});

test('deduplicateDetachments deduplicates enhancements within a detachment', () => {
  const detachments = [
    {
      name: 'Virulent Vectorium',
      stratagems: [],
      enhancements: [
        { name: 'Suppurating Plate' },
        { name: 'Suppurating Plate' }, // duplicate
        { name: 'Droning Halo' },
      ],
    },
  ];
  const result = deduplicateDetachments(detachments);
  assert.equal(result[0].enhancements.length, 2);
});

test('deduplicateDetachments handles empty array', () => {
  assert.deepEqual(deduplicateDetachments([]), []);
});

test('deduplicateDetachments handles detachments without stratagems/enhancements', () => {
  const detachments = [{ name: 'Test Detachment', ability: 'Some ability' }];
  assert.doesNotThrow(() => deduplicateDetachments(detachments));
  const result = deduplicateDetachments(detachments);
  assert.equal(result.length, 1);
});
