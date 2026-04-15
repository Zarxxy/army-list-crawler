const fs = require('fs');
const path = require('path');
const { getArg, parseRecord, extractDetachment, flattenLists, log, UNIT_REGEX, ALT_UNIT_REGEX } = require('./utils');
const { normaliseName, findRulesUnit, parseDetachments } = require('./enrich-rules');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const listsFile = getArg(args, '--lists') || path.join(__dirname, 'output', 'army-lists-latest.json');
const reportFile = getArg(args, '--report') || path.join(__dirname, 'reports', 'meta-report-latest.json');
const previousFile = getArg(args, '--previous') || path.join(__dirname, 'output', 'army-lists-previous.json');
const rulesFile = getArg(args, '--rules') || path.join(__dirname, 'rules', 'death-guard-latest.json');
const outputDir = getArg(args, '--output') || path.join(__dirname, 'reports');
const format = getArg(args, '--format') || 'all';

const CONFIG = {
  MIN_CO_OCCUR_FREQ: 2,       // minimum pair appearances for co-occurrence output
  MIN_WINNING_LISTS: 3,       // use winning lists only if at least this many exist
  MAX_CO_OCCUR_RESULTS: 15,   // top N co-occurrence pairs included in output
  MAX_UNIT_NAME_LENGTH: 80,   // sanity cap — longer strings are likely parsing artefacts
  VARIANCE_LOW_PCT: 20,       // lower bound for "contested" unit choices
  VARIANCE_HIGH_PCT: 80,      // upper bound for "contested" unit choices
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function emptyOutput(dataSource) {
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      dataSource: dataSource || null,
      totalListsAnalysed: 0,
      parsedListsAnalysed: 0,
      winningListsAnalysed: 0,
    },
    unitAnalysis: { units: [] },
    enhancementAnalysis: { enhancements: [] },
    coOccurrence: [],
    detachmentFrequencyAnalysis: [],
    varianceAnalysis: [],
    noveltyFlags: [],
    validationWarnings: [],
  };
}

function main() {
  if (!fs.existsSync(listsFile) || !fs.existsSync(reportFile)) {
    log.warn('Input files not found. Generating empty optimizer output.');
    writeOutput(emptyOutput(null), 'No army lists to optimize.\n');
    return;
  }

  let rawLists, metaReport;
  try {
    rawLists = JSON.parse(fs.readFileSync(listsFile, 'utf-8'));
  } catch (err) {
    log.warn(`Failed to parse lists file: ${err.message}`);
    writeOutput(emptyOutput(null), 'No army lists to optimize.\n');
    return;
  }
  try {
    metaReport = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
  } catch (err) {
    log.warn(`Failed to parse report file: ${err.message}`);
    writeOutput(emptyOutput(null), 'No army lists to optimize.\n');
    return;
  }
  const lists = flattenLists(rawLists);

  if (lists.length === 0) {
    log.warn('No lists found. Generating empty optimizer output.');
    writeOutput(emptyOutput(metaReport.meta), 'No army lists to optimize.\n');
    return;
  }

  log.info(`Loaded ${lists.length} army lists and meta report.`);

  const result = optimize(lists, metaReport);
  const textOutput = renderText(result);
  log.info(textOutput);
  writeOutput(result, textOutput);
}

function writeOutput(result, textOutput) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'text' || format === 'all') {
    const textPath = path.join(outputDir, `optimizer-${timestamp}.txt`);
    fs.writeFileSync(textPath, textOutput, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'optimizer-latest.txt'), textOutput, 'utf-8');
    log.info(`Text report saved to ${textPath}`);
  }

  if (format === 'json' || format === 'all') {
    const jsonPath = path.join(outputDir, `optimizer-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'optimizer-latest.json'), JSON.stringify(result, null, 2), 'utf-8');
    log.info(`JSON report saved to ${jsonPath}`);
  }
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Army list text parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Canonical name normalisation
// ---------------------------------------------------------------------------

let _canonicalUnits = null;
let _canonicalNameMap = null;

function loadCanonicalNames() {
  if (_canonicalUnits !== null) return;
  try {
    if (fs.existsSync(rulesFile)) {
      const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf-8'));
      _canonicalUnits = (rules.units || []).filter((u) => u.name !== 'Datasheets');
      _canonicalNameMap = {};
      for (const unit of _canonicalUnits) {
        _canonicalNameMap[normaliseName(unit.name)] = unit;
      }
      log.info(`Loaded ${_canonicalUnits.length} canonical unit names from rules.`);
    } else {
      _canonicalUnits = [];
      _canonicalNameMap = {};
    }
  } catch (err) {
    log.warn(`Failed to load canonical names: ${err.message}`);
    _canonicalUnits = [];
    _canonicalNameMap = {};
  }
}

function normaliseUnitName(rawName) {
  loadCanonicalNames();
  if (_canonicalUnits.length === 0) return rawName;
  const match = findRulesUnit(rawName, _canonicalUnits, _canonicalNameMap);
  return match ? match.name : rawName;
}

// UNIT_REGEX and ALT_UNIT_REGEX imported from utils.js

function parseArmyListText(text) {
  if (!text) return null;

  const parsed = { units: [], enhancements: [], warlord: null, detachment: null, totalPoints: null };

  // Detachment
  const detMatch = text.match(/Detachment:\s*(.+?)(?:\n|$)/i) ||
                    text.match(/Detachment\s*[-–:]\s*(.+?)(?:\n|$)/i);
  if (detMatch) parsed.detachment = detMatch[1].trim();

  // Total points
  const ptsMatch = text.match(/\[?\s*(\d{3,5})\s*(?:pts|points)\s*\]?/i);
  if (ptsMatch) parsed.totalPoints = parseInt(ptsMatch[1], 10);

  // Warlord
  const warlordMatch = text.match(/Warlord:\s*(.+?)(?:\n|$)/i) ||
                        text.match(/\bWarlord\b[^:\n]*?[-–:]\s*(.+?)(?:\n|$)/i);
  if (warlordMatch) parsed.warlord = warlordMatch[1].trim();

  // Enhancements
  const enhRegex = /Enhancement[s]?:\s*(.+?)(?:\n|$)/gi;
  let enhMatch;
  while ((enhMatch = enhRegex.exec(text)) !== null) {
    const enh = enhMatch[1].trim();
    if (enh && enh.toLowerCase() !== 'none' && !parsed.enhancements.includes(enh)) {
      parsed.enhancements.push(enh);
    }
  }

  // Units with points — "Unit Name [Xpts]" or "Unit Name (Xpts)"
  UNIT_REGEX.lastIndex = 0;
  let unitMatch;
  while ((unitMatch = UNIT_REGEX.exec(text)) !== null) {
    const rawName = unitMatch[1].trim().replace(/^[x×]\d+\s+/i, '').replace(/\s*[-–:]\s*$/, '');
    const pts = parseInt(unitMatch[2], 10);
    if (rawName && pts > 0 && rawName.length < CONFIG.MAX_UNIT_NAME_LENGTH) {
      parsed.units.push({ name: normaliseUnitName(rawName), points: pts });
    }
  }

  // Alternate: "Name    Xpts"
  ALT_UNIT_REGEX.lastIndex = 0;
  while ((unitMatch = ALT_UNIT_REGEX.exec(text)) !== null) {
    const rawName = unitMatch[1].trim().replace(/\.+$/, '').trim();
    const pts = parseInt(unitMatch[2], 10);
    if (rawName && pts > 0 && rawName.length < CONFIG.MAX_UNIT_NAME_LENGTH && !parsed.units.find((u) => u.name === rawName && u.points === pts)) {
      parsed.units.push({ name: normaliseUnitName(rawName), points: pts });
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Core optimizer
// ---------------------------------------------------------------------------

function optimize(lists, metaReport) {
  // Parse all army list texts
  const parsedLists = lists
    .map((l) => ({ ...l, parsed: parseArmyListText(l.armyListText), record: parseRecord(l.record) }))
    .filter((l) => l.parsed && l.parsed.units.length > 0);

  if (parsedLists.length === 0) {
    return { error: 'No parseable army lists found.' };
  }

  const parsedWinning = parsedLists.filter((l) => l.record && l.record.wins >= 3 && l.record.wins > l.record.losses);

  // Use winning lists for unit/enhancement/co-occurrence analysis, fall back to all
  const analysisSet = parsedWinning.length >= CONFIG.MIN_WINNING_LISTS ? parsedWinning : parsedLists;

  const unitAnalysis = analyseUnits(analysisSet);
  const enhancementAnalysis = analyseEnhancements(analysisSet);
  const coOccurrence = analyseCoOccurrence(analysisSet);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      dataSource: metaReport.meta,
      totalListsAnalysed: lists.length,
      parsedListsAnalysed: parsedLists.length,
      winningListsAnalysed: parsedWinning.length,
    },
    unitAnalysis,
    enhancementAnalysis,
    coOccurrence: coOccurrence.slice(0, CONFIG.MAX_CO_OCCUR_RESULTS),
    detachmentFrequencyAnalysis: buildDetachmentFrequency(parsedLists),
    varianceAnalysis: buildVarianceAnalysis(parsedLists),
    noveltyFlags: buildNoveltyFlags(parsedLists, previousFile),
    validationWarnings: validateEnhancements(parsedLists),
  };
}

// ---------------------------------------------------------------------------
// Unit analysis — frequency, win-rate correlation, average points
// ---------------------------------------------------------------------------

function analyseUnits(parsedLists) {
  const unitData = {};
  const totalLists = parsedLists.length;

  for (const list of parsedLists) {
    const isWinning = list.record && list.record.wins >= 3 && list.record.wins > list.record.losses;
    const isUndefeated = list.record && list.record.losses === 0 && list.record.wins > 0;
    const seen = new Set();

    for (const unit of list.parsed.units) {
      const key = unit.name;
      if (seen.has(key)) {
        // Same unit taken multiple times — track quantity
        if (unitData[key]) unitData[key].totalCopies++;
        continue;
      }
      seen.add(key);

      if (!unitData[key]) {
        unitData[key] = { name: key, appearances: 0, winningAppearances: 0, undefeatedAppearances: 0, pointValues: [], totalCopies: 0 };
      }
      unitData[key].appearances++;
      unitData[key].totalCopies++;
      unitData[key].pointValues.push(unit.points);
      if (isWinning) unitData[key].winningAppearances++;
      if (isUndefeated) unitData[key].undefeatedAppearances++;
    }
  }

  const units = Object.values(unitData)
    .map((u) => {
      const avgPts = u.pointValues.length > 0 ? Math.round(u.pointValues.reduce((s, v) => s + v, 0) / u.pointValues.length) : 0;
      const modePts = mode(u.pointValues);
      return {
        name: u.name,
        appearances: u.appearances,
        frequency: pct(u.appearances, totalLists),
        avgPoints: avgPts,
        typicalPoints: modePts,
        avgCopies: u.totalCopies > 0 ? Math.round((u.totalCopies / u.appearances) * 10) / 10 : 1,
        winCorrelation: pct(u.winningAppearances, u.appearances),
        undefeatedAppearances: u.undefeatedAppearances,
      };
    })
    .sort((a, b) => b.frequency - a.frequency || b.appearances - a.appearances);

  return { parsedLists: totalLists, units };
}

function mode(arr) {
  if (arr.length === 0) return 0;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  let maxCount = 0, maxVal = arr[0];
  for (const [val, count] of Object.entries(counts)) {
    if (count > maxCount) { maxCount = count; maxVal = parseInt(val, 10); }
  }
  return maxVal;
}

// ---------------------------------------------------------------------------
// Enhancement analysis
// ---------------------------------------------------------------------------

function analyseEnhancements(parsedLists) {
  const enhData = {};
  let listsWithEnhancements = 0;

  for (const list of parsedLists) {
    if (list.parsed.enhancements.length === 0) continue;
    listsWithEnhancements++;
    for (const enh of list.parsed.enhancements) {
      if (!enhData[enh]) enhData[enh] = { name: enh, appearances: 0 };
      enhData[enh].appearances++;
    }
  }

  const enhancements = Object.values(enhData)
    .map((e) => ({ ...e, frequency: pct(e.appearances, listsWithEnhancements) }))
    .sort((a, b) => b.frequency - a.frequency);

  return { parsedLists: listsWithEnhancements, enhancements };
}

// ---------------------------------------------------------------------------
// Co-occurrence analysis — which units appear together?
// ---------------------------------------------------------------------------

function analyseCoOccurrence(parsedLists) {
  const pairCounts = {};
  const minFrequency = CONFIG.MIN_CO_OCCUR_FREQ;

  for (const list of parsedLists) {
    const unitNames = [...new Set(list.parsed.units.map((u) => u.name))].sort();
    for (let i = 0; i < unitNames.length; i++) {
      for (let j = i + 1; j < unitNames.length; j++) {
        const pair = unitNames[i] + ' + ' + unitNames[j];
        pairCounts[pair] = (pairCounts[pair] || 0) + 1;
      }
    }
  }

  return Object.entries(pairCounts)
    .filter(([, count]) => count >= minFrequency)
    .sort((a, b) => b[1] - a[1])
    .map(([pair, count]) => ({
      pair,
      count,
      frequency: pct(count, parsedLists.length),
    }));
}

// ---------------------------------------------------------------------------
// Detachment frequency analysis
// ---------------------------------------------------------------------------

function buildDetachmentFrequency(parsedLists) {
  const byDetachment = {};
  for (const list of parsedLists) {
    const det = list.parsed.detachment || list.detachment || extractDetachment(list.armyListText) || 'Unknown';
    if (!byDetachment[det]) byDetachment[det] = [];
    byDetachment[det].push(list);
  }

  return Object.entries(byDetachment)
    .map(([detachment, lists]) => {
      const listCount = lists.length;

      const unitCounts = {};
      for (const list of lists) {
        const seen = new Set();
        for (const unit of list.parsed.units) {
          if (!seen.has(unit.name)) {
            seen.add(unit.name);
            unitCounts[unit.name] = (unitCounts[unit.name] || 0) + 1;
          }
        }
      }

      const enhCounts = {};
      for (const list of lists) {
        for (const enh of list.parsed.enhancements) {
          enhCounts[enh] = (enhCounts[enh] || 0) + 1;
        }
      }

      const topUnits = Object.entries(unitCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count, frequency: pct(count, listCount) }));

      const topEnhancements = Object.entries(enhCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count, frequency: pct(count, listCount) }));

      return { detachment, listCount, topUnits, topEnhancements };
    })
    .sort((a, b) => b.listCount - a.listCount);
}

// ---------------------------------------------------------------------------
// Variance analysis — "contested" unit choices per detachment
// ---------------------------------------------------------------------------

function buildVarianceAnalysis(parsedLists) {
  const byDetachment = {};
  for (const list of parsedLists) {
    const det = list.parsed.detachment || list.detachment || extractDetachment(list.armyListText) || 'Unknown';
    if (!byDetachment[det]) byDetachment[det] = [];
    byDetachment[det].push(list);
  }

  return Object.entries(byDetachment)
    .filter(([, lists]) => lists.length >= 2)
    .map(([detachment, lists]) => {
      const listCount = lists.length;

      const unitCounts = {};
      for (const list of lists) {
        const seen = new Set();
        for (const unit of list.parsed.units) {
          if (!seen.has(unit.name)) {
            seen.add(unit.name);
            unitCounts[unit.name] = (unitCounts[unit.name] || 0) + 1;
          }
        }
      }

      // Units appearing in 20–79% of this detachment's lists
      const variantChoices = Object.entries(unitCounts)
        .filter(([, count]) => {
          const freq = (count / listCount) * 100;
          return freq >= CONFIG.VARIANCE_LOW_PCT && freq < CONFIG.VARIANCE_HIGH_PCT;
        })
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count, frequency: pct(count, listCount) }));

      return { detachment, listCount, variantChoices };
    })
    .filter((d) => d.variantChoices.length > 0)
    .sort((a, b) => b.listCount - a.listCount);
}

// ---------------------------------------------------------------------------
// Novelty flags — tech not seen in previous crawl
// ---------------------------------------------------------------------------

function buildNoveltyFlags(parsedLists, prevFile) {
  const prevFilePath = prevFile || path.join(__dirname, 'output', 'army-lists-previous.json');

  if (!fs.existsSync(prevFilePath)) return [];

  let previousLists;
  try {
    const prevRaw = JSON.parse(fs.readFileSync(prevFilePath, 'utf-8'));
    previousLists = flattenLists(prevRaw);
  } catch (err) {
    log.warn(`Could not load previous file for novelty flags: ${err.message}`);
    return [];
  }

  // Collect all tech names from previous crawl
  const prevTech = new Set();
  for (const list of previousLists) {
    const parsed = parseArmyListText(list.armyListText);
    if (parsed) {
      for (const unit of parsed.units) prevTech.add(unit.name);
      for (const enh of parsed.enhancements) prevTech.add(enh);
    }
  }

  // Find new tech in current parsed lists
  const novelty = [];
  const seen = new Set();
  for (const list of parsedLists) {
    const det = list.parsed.detachment || list.detachment || 'Unknown';
    for (const unit of list.parsed.units) {
      if (!prevTech.has(unit.name) && !seen.has(unit.name)) {
        seen.add(unit.name);
        novelty.push({ name: unit.name, type: 'unit', detachment: det });
      }
    }
    for (const enh of list.parsed.enhancements) {
      if (!prevTech.has(enh) && !seen.has(enh)) {
        seen.add(enh);
        novelty.push({ name: enh, type: 'enhancement', detachment: det });
      }
    }
  }

  return novelty;
}

// ---------------------------------------------------------------------------
// Enhancement-to-detachment validation
// ---------------------------------------------------------------------------

function buildEnhancementDetachmentMap() {
  loadCanonicalNames();
  if (!_canonicalUnits) return {};

  try {
    if (!fs.existsSync(rulesFile)) return {};
    const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf-8'));
    const detachments = parseDetachments(rules.factionAbilities || []);
    const map = {};
    for (const det of detachments) {
      for (const enh of det.enhancements) {
        map[normaliseName(enh.name)] = det.name;
      }
    }
    return map;
  } catch (err) {
    log.warn(`Failed to build enhancement-detachment map: ${err.message}`);
    return {};
  }
}

function validateEnhancements(parsedLists) {
  const enhDetMap = buildEnhancementDetachmentMap();
  if (Object.keys(enhDetMap).length === 0) return [];

  const warnings = [];
  for (const list of parsedLists) {
    const listDet = list.parsed.detachment || list.detachment || extractDetachment(list.armyListText) || 'Unknown';
    for (const enh of list.parsed.enhancements) {
      const enhNorm = normaliseName(enh);
      const expectedDet = enhDetMap[enhNorm];
      if (expectedDet && normaliseName(expectedDet) !== normaliseName(listDet)) {
        warnings.push({
          type: 'enhancement-detachment-mismatch',
          enhancement: enh,
          declaredDetachment: listDet,
          expectedDetachment: expectedDet,
          player: list.playerName || list.player || 'Unknown',
          event: list.event || 'Unknown',
        });
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

function renderText(result) {
  if (result.error) return `ERROR: ${result.error}`;

  const lines = [];
  const hr = '='.repeat(74);
  const hr2 = '-'.repeat(74);

  lines.push(hr);
  lines.push('  ARMY OPTIMIZER — META ANALYSIS');
  lines.push(hr);
  lines.push(`  Generated: ${result.meta.generatedAt}`);
  lines.push(`  Lists analysed: ${result.meta.totalListsAnalysed} (${result.meta.parsedListsAnalysed} parsed, ${result.meta.winningListsAnalysed} winning)`);
  lines.push('');

  // Detachment Frequency
  if (result.detachmentFrequencyAnalysis && result.detachmentFrequencyAnalysis.length > 0) {
    lines.push(hr2);
    lines.push('  DETACHMENT FREQUENCY ANALYSIS');
    lines.push(hr2);
    for (const det of result.detachmentFrequencyAnalysis) {
      lines.push(`\n  ${det.detachment} (${det.listCount} lists)`);
      for (const u of det.topUnits.slice(0, 5)) {
        lines.push(`    ${u.name.padEnd(40)} ${u.count}x (${u.frequency}%)`);
      }
    }
    lines.push('');
  }

  // Variance Analysis
  if (result.varianceAnalysis && result.varianceAnalysis.length > 0) {
    lines.push(hr2);
    lines.push('  CONTESTED CHOICES (20\u201379% inclusion per detachment)');
    lines.push(hr2);
    for (const det of result.varianceAnalysis) {
      lines.push(`\n  ${det.detachment}:`);
      for (const u of det.variantChoices) {
        lines.push(`    ${u.name.padEnd(40)} ${u.count}x (${u.frequency}%)`);
      }
    }
    lines.push('');
  }

  // Co-occurrence
  if (result.coOccurrence && result.coOccurrence.length > 0) {
    lines.push(hr2);
    lines.push('  UNIT SYNERGIES (most common pairings)');
    lines.push(hr2);
    for (const c of result.coOccurrence.slice(0, 10)) {
      lines.push(`  ${c.pair.padEnd(60)} ${String(c.count).padStart(3)}x  (${c.frequency}%)`);
    }
    lines.push('');
  }

  // Novelty Flags
  if (result.noveltyFlags && result.noveltyFlags.length > 0) {
    lines.push(hr2);
    lines.push('  NEW TECH (not seen in previous crawl)');
    lines.push(hr2);
    for (const n of result.noveltyFlags.slice(0, 20)) {
      lines.push(`  [${n.type}] ${n.name} (${n.detachment || 'unknown detachment'})`);
    }
    lines.push('');
  }

  // Validation Warnings
  if (result.validationWarnings && result.validationWarnings.length > 0) {
    lines.push(hr2);
    lines.push('  DATA QUALITY WARNINGS');
    lines.push(hr2);
    for (const w of result.validationWarnings) {
      if (w.type === 'enhancement-detachment-mismatch') {
        lines.push(`  ⚠ ${w.player} (${w.event}): "${w.enhancement}" belongs to ${w.expectedDetachment}, but list declares ${w.declaredDetachment}`);
      }
    }
    lines.push('');
  }

  lines.push(hr);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
if (require.main === module) {
  main();
} else {
  module.exports = {
    optimize,
    parseArmyListText,
    buildDetachmentFrequency,
    buildVarianceAnalysis,
    buildNoveltyFlags,
    validateEnhancements,
  };
}
