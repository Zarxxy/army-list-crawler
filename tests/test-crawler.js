'use strict';

/**
 * Unit tests for pure (non-Playwright) functions in crawler.js.
 * These tests do not launch a browser.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  filterByFaction,
  identifyListSections,
  buildDirectSections,
  normalizeEntry,
  splitConcatenatedText,
  parseFieldsFromTexts,
} = require('../crawler');

// ---------------------------------------------------------------------------
// filterByFaction
// ---------------------------------------------------------------------------

test('filterByFaction returns all entries when no faction given', () => {
  const lists = [
    { faction: 'Death Guard' },
    { faction: 'Tyranids' },
  ];
  assert.equal(filterByFaction(lists, null).length, 2);
});

test('filterByFaction filters by faction substring (case-insensitive)', () => {
  const lists = [
    { faction: 'Death Guard', playerName: 'Alice' },
    { faction: 'Tyranids', playerName: 'Bob' },
    { faction: 'Death Guard', playerName: 'Carol' },
  ];
  const result = filterByFaction(lists, 'death guard');
  assert.equal(result.length, 2);
  assert.ok(result.every((e) => e.faction === 'Death Guard'));
});

test('filterByFaction also checks armyListText', () => {
  const lists = [
    { faction: null, armyListText: 'Faction: Death Guard\nDetachment: Virulent Vectorium' },
    { faction: null, armyListText: 'Faction: Necrons' },
  ];
  const result = filterByFaction(lists, 'death guard');
  assert.equal(result.length, 1);
});

test('filterByFaction returns empty array when nothing matches', () => {
  const lists = [{ faction: 'Tyranids' }];
  assert.equal(filterByFaction(lists, 'Death Guard').length, 0);
});

// ---------------------------------------------------------------------------
// identifyListSections
// ---------------------------------------------------------------------------

test('identifyListSections picks up links with "list" in text', () => {
  const navLinks = [
    { text: 'Army Lists', href: 'https://listhammer.info/lists' },
    { text: 'Home', href: 'https://listhammer.info/' },
    { text: 'Meta Stats', href: 'https://listhammer.info/stats' },
  ];
  const sections = identifyListSections(navLinks);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'Army Lists');
});

test('identifyListSections deduplicates identical URLs', () => {
  const navLinks = [
    { text: 'Lists', href: 'https://listhammer.info/lists' },
    { text: 'All Army Lists', href: 'https://listhammer.info/lists' },
  ];
  const sections = identifyListSections(navLinks);
  assert.equal(sections.length, 1);
});

test('identifyListSections falls back to href-based matching', () => {
  // Use a hostname without 'list' to avoid false positive on href.includes('/list')
  const navLinks = [
    { text: 'Play', href: 'https://example.com/40k' },
    { text: 'Home', href: 'https://example.com/' },
  ];
  const sections = identifyListSections(navLinks);
  assert.equal(sections.length, 1);
  assert.ok(sections[0].url.includes('/40k'));
});

// ---------------------------------------------------------------------------
// buildDirectSections
// ---------------------------------------------------------------------------

test('buildDirectSections with faction produces two URLs (all + undefeated)', () => {
  const sections = buildDirectSections(null, 'Death Guard');
  assert.equal(sections.length, 2);
  assert.ok(sections[0].url.includes('faction=Death+Guard'));
  assert.ok(sections[1].url.includes('wins=X-0'));
});

test('buildDirectSections without faction produces one URL', () => {
  const sections = buildDirectSections(null, null);
  assert.equal(sections.length, 1);
});

test('buildDirectSections section names reflect filter', () => {
  const sections = buildDirectSections(null, 'Tyranids');
  assert.ok(sections[0].name.includes('Tyranids'));
  assert.ok(sections[0].name.includes('All'));
  assert.ok(sections[1].name.includes('Undefeated'));
});

// ---------------------------------------------------------------------------
// splitConcatenatedText
// ---------------------------------------------------------------------------

const FACTION_PATTERNS = [/death guard/i, /tyranid/i, /necron/i];
const DETACHMENT_NAMES = ['Virulent Vectorium', "Mortarion's Hammer"];

test('splitConcatenatedText extracts date from end', () => {
  const parts = splitConcatenatedText('John DoeDeath GuardSome GT2026-03-21', FACTION_PATTERNS, DETACHMENT_NAMES);
  assert.ok(parts.some((p) => p === '2026-03-21'), `parts: ${JSON.stringify(parts)}`);
});

test('splitConcatenatedText extracts record', () => {
  const parts = splitConcatenatedText('Alice5-1Death Guard2026-01-15', FACTION_PATTERNS, DETACHMENT_NAMES);
  assert.ok(parts.some((p) => /^\d+-\d+/.test(p)), `parts: ${JSON.stringify(parts)}`);
});

test('splitConcatenatedText extracts known detachment', () => {
  const parts = splitConcatenatedText('BobDeath GuardVirulent VectoriumGT 20262026-04-01', FACTION_PATTERNS, DETACHMENT_NAMES);
  assert.ok(parts.some((p) => p === 'Virulent Vectorium'), `parts: ${JSON.stringify(parts)}`);
});

test('splitConcatenatedText handles plain text with no structured data', () => {
  const parts = splitConcatenatedText('Hello World', FACTION_PATTERNS, DETACHMENT_NAMES);
  assert.ok(Array.isArray(parts));
  assert.ok(parts.length >= 1);
});

// ---------------------------------------------------------------------------
// parseFieldsFromTexts
// ---------------------------------------------------------------------------

test('parseFieldsFromTexts identifies date field', () => {
  const texts = ['John Doe', 'Death Guard', '5-1', '2026-03-21'];
  const result = parseFieldsFromTexts(texts, FACTION_PATTERNS, DETACHMENT_NAMES);
  assert.equal(result.date, '2026-03-21');
});

test('parseFieldsFromTexts identifies record field', () => {
  const texts = ['Alice', 'Death Guard', '4-1-0', '2026-01-10'];
  const result = parseFieldsFromTexts(texts, FACTION_PATTERNS, DETACHMENT_NAMES);
  assert.equal(result.record, '4-1-0');
});

test('parseFieldsFromTexts identifies faction field', () => {
  const texts = ['Bob', 'Death Guard', '3-2', '2026-02-05'];
  const result = parseFieldsFromTexts(texts, FACTION_PATTERNS, DETACHMENT_NAMES);
  assert.equal(result.faction, 'Death Guard');
});

test('parseFieldsFromTexts assigns player name from first unknown', () => {
  const texts = ['Alice Smith', 'Death Guard', '5-0', '2026-04-01'];
  const result = parseFieldsFromTexts(texts, FACTION_PATTERNS, DETACHMENT_NAMES);
  assert.equal(result.playerName, 'Alice Smith');
});

// ---------------------------------------------------------------------------
// normalizeEntry
// ---------------------------------------------------------------------------

test('normalizeEntry passes through entry with correct semantic data', () => {
  const entry = {
    playerName: 'Alice',
    faction: 'Death Guard',
    event: 'Some GT',
    record: '5-0',
  };
  const result = normalizeEntry(entry);
  assert.equal(result.playerName, 'Alice');
  assert.equal(result.faction, 'Death Guard');
});

test('normalizeEntry tries to parse from childTexts when fields look wrong', () => {
  const entry = {
    faction: 'Alice Smith', // player name in faction field
    playerName: null,
    childTexts: ['Alice Smith', 'Death Guard', 'Virulent Vectorium', 'Open GT', '5-0', '2026-01-01'],
  };
  const result = normalizeEntry(entry);
  // Should have detected Death Guard as the real faction
  assert.equal(result.faction, 'Death Guard');
});
