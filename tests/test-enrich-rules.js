'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { enrich, parseDetachments, normaliseName, findRulesUnit, extractTargetKeywords } = require('../enrich-rules');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_RULES = {
  faction: 'death-guard',
  edition: '10ed',
  factionAbilities: [
    { name: "NURGLE'S GIFT (AURA)", description: 'Faction ability.' },
    { name: 'WORLDBLIGHT', description: 'Detachment ability description.' },
    { name: 'ENHANCEMENTS', description: 'Daemon Weapon of Nurgle\n10 pts\n\nSome description.' },
    { name: 'STRATAGEMS', description:
      'PUTRID DETONATION\n1CP\nVIRULENT VECTORIUM \u2013 STRATEGIC PLOY STRATAGEM\nFluff text.\nWHEN: Any phase.\n\nTARGET: One DEATH GUARD VEHICLE or DEATH GUARD MONSTER model.\n\nEFFECT: Something happens.\n' +
      'DISGUSTINGLY RESILIENT\n2CP\nVIRULENT VECTORIUM \u2013 BATTLE TACTIC STRATAGEM\nFluff.\nWHEN: Shooting phase.\n\nTARGET: One DEATH GUARD INFANTRY unit.\n\nEFFECT: Subtract 1 damage.'
    },
  ],
  units: [
    { name: 'Datasheets', stats: {}, weapons: [], abilities: [], keywords: [], points: '' },
    { name: 'Plague Marines', stats: {}, weapons: [], abilities: [], keywords: ['INFANTRY', 'BATTLELINE', 'CHAOS', 'NURGLE', 'PLAGUE MARINES'], points: '' },
    { name: 'Blightlord Terminators', stats: {}, weapons: [], abilities: [], keywords: ['INFANTRY', 'CHAOS', 'NURGLE', 'TERMINATOR', 'BLIGHTLORD TERMINATORS'], points: '' },
    { name: 'Mortarion', stats: {}, weapons: [], abilities: [], keywords: ['MONSTER', 'CHARACTER', 'FLY', 'EPIC HERO', 'CHAOS', 'NURGLE', 'DAEMON', 'PRIMARCH', 'MORTARION'], points: '' },
    { name: 'Poxwalkers', stats: {}, weapons: [], abilities: [], keywords: ['INFANTRY', 'CHAOS', 'NURGLE', 'POXWALKERS'], points: '' },
  ],
};

const MOCK_OPTIMIZER = {
  unitAnalysis: {
    units: [
      { name: 'Plague Marines', appearances: 10, frequency: 83.3 },
      { name: 'Blightlord Terminators', appearances: 8, frequency: 66.7 },
      { name: 'Mortarion', appearances: 5, frequency: 41.7 },
    ],
  },
  detachmentFrequencyAnalysis: [
    {
      detachment: 'Virulent Vectorium',
      listCount: 8,
      topUnits: [
        { name: 'Plague Marines', count: 8, frequency: 100 },
        { name: 'Blightlord Terminators', count: 6, frequency: 75 },
      ],
      topEnhancements: [],
    },
  ],
  coOccurrence: [
    { pair: 'Plague Marines + Blightlord Terminators', count: 6, frequency: 50 },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('normaliseName', () => {
  it('lowercases and trims', () => {
    assert.equal(normaliseName('Plague Marines'), 'plague marines');
  });

  it('collapses whitespace', () => {
    assert.equal(normaliseName('Blightlord   Terminators'), 'blightlord terminators');
  });
});

describe('findRulesUnit', () => {
  const units = MOCK_RULES.units.filter((u) => u.name !== 'Datasheets');
  const nameMap = {};
  for (const u of units) nameMap[normaliseName(u.name)] = u;

  it('finds exact match', () => {
    const found = findRulesUnit('Plague Marines', units, nameMap);
    assert.equal(found.name, 'Plague Marines');
  });

  it('finds case-insensitive match', () => {
    const found = findRulesUnit('plague marines', units, nameMap);
    assert.equal(found.name, 'Plague Marines');
  });

  it('returns null for unknown unit', () => {
    const found = findRulesUnit('Space Marines', units, nameMap);
    assert.equal(found, null);
  });

  it('strips trailing x-count', () => {
    const found = findRulesUnit('Plague Marines x2', units, nameMap);
    assert.equal(found.name, 'Plague Marines');
  });
});

describe('extractTargetKeywords', () => {
  it('extracts VEHICLE and MONSTER', () => {
    const kws = extractTargetKeywords('One DEATH GUARD VEHICLE or DEATH GUARD MONSTER model.');
    assert.ok(kws.includes('VEHICLE'));
    assert.ok(kws.includes('MONSTER'));
  });

  it('extracts INFANTRY', () => {
    const kws = extractTargetKeywords('One DEATH GUARD INFANTRY unit.');
    assert.ok(kws.includes('INFANTRY'));
  });

  it('returns empty for null', () => {
    assert.deepEqual(extractTargetKeywords(null), []);
  });
});

describe('parseDetachments', () => {
  it('parses detachments from factionAbilities', () => {
    const dets = parseDetachments(MOCK_RULES.factionAbilities);
    assert.equal(dets.length, 1);
    assert.equal(dets[0].name, 'VIRULENT VECTORIUM');
    assert.equal(dets[0].abilityName, 'WORLDBLIGHT');
  });

  it('parses stratagems', () => {
    const dets = parseDetachments(MOCK_RULES.factionAbilities);
    assert.equal(dets[0].stratagems.length, 2);
    assert.equal(dets[0].stratagems[0].name, 'PUTRID DETONATION');
    assert.equal(dets[0].stratagems[0].cp, '1CP');
    assert.equal(dets[0].stratagems[0].type, 'STRATEGIC PLOY');
  });

  it('parses enhancements', () => {
    const dets = parseDetachments(MOCK_RULES.factionAbilities);
    assert.equal(dets[0].enhancements.length, 1);
    assert.equal(dets[0].enhancements[0].name, 'Daemon Weapon of Nurgle');
    assert.equal(dets[0].enhancements[0].pts, 10);
  });

  it('extracts target keywords from stratagems', () => {
    const dets = parseDetachments(MOCK_RULES.factionAbilities);
    // After enrich adds targetKeywords — test via enrich
    // parseDetachments itself does not add targetKeywords
    assert.ok(dets[0].stratagems[0].target);
  });

  it('returns empty array for null input', () => {
    assert.deepEqual(parseDetachments(null), []);
    assert.deepEqual(parseDetachments([]), []);
  });
});

describe('enrich', () => {
  it('produces detachments with target keywords on stratagems', () => {
    const result = enrich(MOCK_RULES, MOCK_OPTIMIZER);
    assert.equal(result.detachments.length, 1);
    const strat = result.detachments[0].stratagems[0];
    assert.ok(strat.targetKeywords.includes('VEHICLE'));
    assert.ok(strat.targetKeywords.includes('MONSTER'));
  });

  it('enriches units with keywords from rules', () => {
    const result = enrich(MOCK_RULES, MOCK_OPTIMIZER);
    const pm = result.units.find((u) => u.name === 'Plague Marines');
    assert.ok(pm);
    assert.ok(pm.keywords.includes('INFANTRY'));
    assert.ok(pm.keywords.includes('BATTLELINE'));
    assert.equal(pm.canonicalName, 'Plague Marines');
  });

  it('includes frequency and count from optimizer', () => {
    const result = enrich(MOCK_RULES, MOCK_OPTIMIZER);
    const pm = result.units.find((u) => u.name === 'Plague Marines');
    assert.equal(pm.count, 10);
    assert.equal(pm.frequency, 83.3);
  });

  it('includes detachment breakdown per unit', () => {
    const result = enrich(MOCK_RULES, MOCK_OPTIMIZER);
    const pm = result.units.find((u) => u.name === 'Plague Marines');
    assert.equal(pm.detachments.length, 1);
    assert.equal(pm.detachments[0].detachment, 'Virulent Vectorium');
  });

  it('includes co-occurrence partners', () => {
    const result = enrich(MOCK_RULES, MOCK_OPTIMIZER);
    const pm = result.units.find((u) => u.name === 'Plague Marines');
    assert.ok(pm.coOccurrencePartners.length > 0);
    assert.equal(pm.coOccurrencePartners[0].unit, 'Blightlord Terminators');
  });

  it('identifies unseen units', () => {
    const result = enrich(MOCK_RULES, MOCK_OPTIMIZER);
    assert.ok(result.unseenUnits.length > 0);
    const pw = result.unseenUnits.find((u) => u.name === 'Poxwalkers');
    assert.ok(pw, 'Poxwalkers should be unseen (not in optimizer data)');
  });

  it('works without optimizer data', () => {
    const result = enrich(MOCK_RULES, null);
    assert.equal(result.units.length, 0);
    assert.ok(result.unseenUnits.length > 0);
    assert.equal(result.detachments.length, 1);
  });

  it('sets metadata fields', () => {
    const result = enrich(MOCK_RULES, MOCK_OPTIMIZER);
    assert.ok(result.generatedAt);
    assert.equal(result.faction, 'death-guard');
    assert.equal(result.edition, '10ed');
  });
});
