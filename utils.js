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

/**
 * Minimal structured logger. Outputs ISO-timestamped, level-tagged messages.
 * Uses stderr for warn/error, stdout for info/debug.
 *
 * Usage:
 *   const { log } = require('./utils');
 *   log('info', 'Loaded 42 lists');
 *   log.warn('Something odd happened');
 *   log.error('Fatal:', err.message);
 */
function log(level, ...args) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (level === 'error' || level === 'warn') {
    console.error(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}
log.info  = (...a) => log('info',  ...a);
log.warn  = (...a) => log('warn',  ...a);
log.error = (...a) => log('error', ...a);
log.debug = (...a) => log('debug', ...a);

// ---------------------------------------------------------------------------
// Shared unit-parsing regex constants — avoids recompilation and keeps the
// pattern in one place. Uses the `g` flag so callers MUST reset lastIndex = 0
// before each use.
//
// IMPORTANT: If you change these, update the mirrored copy in
// docs/template.html (_unitRegex) which cannot use require().
// ---------------------------------------------------------------------------

/** Matches: "Unit Name [Xpts]" or "Unit Name (Xpts)" */
const UNIT_REGEX = /^[•·\-\s]*(.+?)\s*[\[(]\s*(\d+)\s*pts?\s*[\])]/gim;

/** Matches: "Unit Name    Xpts" (whitespace-separated) */
const ALT_UNIT_REGEX = /^[•·\-\s]*(.+?)\s{2,}\.{0,}?\s*(\d{2,4})\s*pts?\s*$/gim;

/**
 * Extract raw unit names + points from army-list text.
 * Returns an array of { name, points } with basic cleanup applied.
 * Does NOT apply canonical-name normalisation (caller decides).
 *
 * @param {string} text - Raw army list text
 * @param {number} [maxNameLength=80] - Reject names longer than this
 * @returns {{ name: string, points: number }[]}
 */
function parseUnitsFromText(text, maxNameLength) {
  if (!text) return [];
  const cap = maxNameLength || 80;
  const units = [];
  const seen = new Set();

  UNIT_REGEX.lastIndex = 0;
  let m;
  while ((m = UNIT_REGEX.exec(text)) !== null) {
    const rawName = m[1].trim().replace(/^[x×]\d+\s+/i, '').replace(/\s*[-–:]\s*$/, '');
    const pts = parseInt(m[2], 10);
    if (rawName && pts > 0 && rawName.length < cap) {
      const key = rawName + '|' + pts;
      if (!seen.has(key)) {
        seen.add(key);
        units.push({ name: rawName, points: pts });
      }
    }
  }

  ALT_UNIT_REGEX.lastIndex = 0;
  while ((m = ALT_UNIT_REGEX.exec(text)) !== null) {
    const rawName = m[1].trim().replace(/\.+$/, '').trim();
    const pts = parseInt(m[2], 10);
    if (rawName && pts > 0 && rawName.length < cap) {
      const key = rawName + '|' + pts;
      if (!seen.has(key)) {
        seen.add(key);
        units.push({ name: rawName, points: pts });
      }
    }
  }

  return units;
}

module.exports = { getArg, parseRecord, extractDetachment, flattenLists, log, UNIT_REGEX, ALT_UNIT_REGEX, parseUnitsFromText };
