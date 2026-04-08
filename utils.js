'use strict';

/**
 * Shared utility functions used across crawler.js, report.js, and optimizer.js.
 */

/**
 * Return the value following `flag` in an args array, or null if absent.
 * Example: getArg(['--game', '40k'], '--game') → '40k'
 */
function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

/**
 * Parse a W-L or W-L-D record string into an object, or return null.
 */
function parseRecord(record) {
  if (!record) return null;
  const m = record.match(/(\d+)\s*[-–]\s*(\d+)(?:\s*[-–]\s*(\d+))?/);
  if (!m) return null;
  return {
    wins: parseInt(m[1], 10),
    losses: parseInt(m[2], 10),
    draws: m[3] ? parseInt(m[3], 10) : 0,
  };
}

/**
 * Extract the detachment name from an army list text, or return null.
 */
function extractDetachment(text) {
  if (!text) return null;
  const m = text.match(/Detachment:\s*(.+?)(?:\n|$)/i) ||
            text.match(/Detachment\s*[-–:]\s*(.+?)(?:\n|$)/i);
  return m ? m[1].trim() : null;
}

/**
 * Flatten sections from a raw crawled JSON into a deduplicated list of entries.
 */
function flattenLists(raw) {
  const lists = [];
  const seen = new Set();
  for (const [sectionName, entries] of Object.entries(raw.sections || {})) {
    for (const entry of entries) {
      const key = [entry.playerName || entry.player, entry.event, entry.date].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      lists.push({ ...entry, section: sectionName });
    }
  }
  return lists;
}

module.exports = { getArg, parseRecord, extractDetachment, flattenLists };
