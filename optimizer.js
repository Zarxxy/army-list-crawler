const fs = require('fs');
const path = require('path');
const { getArg, parseRecord, extractDetachment, flattenLists } = require('./utils');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const listsFile    = getArg(args, '--lists')    || path.join(__dirname, 'output', 'army-lists-latest.json');
const previousFile = getArg(args, '--previous') || path.join(__dirname, 'output', 'army-lists-previous.json');
const reportFile   = getArg(args, '--report')   || path.join(__dirname, 'reports', 'meta-report-latest.json');
const outputDir    = getArg(args, '--output')   || path.join(__dirname, 'reports');
const format       = getArg(args, '--format')   || 'all';

const CONFIG = {
  MIN_CO_OCCUR_FREQ: 2,       // minimum pair appearances for co-occurrence output
  MAX_CO_OCCUR_RESULTS: 15,   // top N co-occurrence pairs included in output
  TOP_ENHANCEMENTS: 8,        // top N enhancements to include
  // Variance: units in this % range are "contested" (not universal, not rare)
  VARIANCE_MIN_PCT: 20,
  VARIANCE_MAX_PCT: 79,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const emptyResult = { generatedAt: new Date().toISOString(), totalLists: 0, unitAnalysis: { units: [] }, enhancementAnalysis: { enhancements: [] }, coOccurrence: [], detachmentFrequencyAnalysis: [], varianceAnalysis: [], noveltyFlags: [] };

  if (!fs.existsSync(listsFile) || !fs.existsSync(reportFile)) {
    console.warn('Input files not found. Generating empty optimizer output.');
    writeOutput(emptyResult, 'No army lists to analyse.\n');
    return;
  }

  const rawLists = JSON.parse(fs.readFileSync(listsFile, 'utf-8'));
  const metaReport = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
  const lists = flattenLists(rawLists);

  if (lists.length === 0) {
    console.warn('No lists found. Generating empty optimizer output.');
    writeOutput(emptyResult, 'No army lists to analyse.\n');
    return;
  }

  console.log(`Loaded ${lists.length} army lists and meta report.\n`);

  // Load previous crawl for novelty detection
  let previousLists = [];
  if (fs.existsSync(previousFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(previousFile, 'utf-8'));
      previousLists = flattenLists(prev);
      console.log(`Loaded ${previousLists.length} previous lists for novelty detection.`);
    } catch { /* ignore */ }
  }

  const result = analyse(lists, metaReport, previousLists);
  const textOutput = renderText(result);
  console.log(textOutput);
  writeOutput(result, textOutput);
}

function writeOutput(result, textOutput) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'text' || format === 'all') {
    const textPath = path.join(outputDir, `optimizer-${timestamp}.txt`);
    fs.writeFileSync(textPath, textOutput, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'optimizer-latest.txt'), textOutput, 'utf-8');
    console.log(`\nText report saved to ${textPath}`);
  }

  if (format === 'json' || format === 'all') {
    const jsonPath = path.join(outputDir, `optimizer-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'optimizer-latest.json'), JSON.stringify(result, null, 2), 'utf-8');
    console.log(`JSON report saved to ${jsonPath}`);
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

// Module-level regex constants — avoids recompilation on every call.
// These use the `g` flag so lastIndex must be reset to 0 before each use.
const UNIT_REGEX = /^[•·\-\s]*(.+?)\s*[\[(]\s*(\d+)\s*pts?\s*[\])]/gim;
const ALT_UNIT_REGEX = /^[•·\-\s]*(.+?)\s{2,}\.{0,}?\s*(\d{2,4})\s*pts?\s*$/gim;

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
    const name = unitMatch[1].trim().replace(/^[x×]\d+\s+/i, '').replace(/\s*[-–:]\s*$/, '');
    const pts = parseInt(unitMatch[2], 10);
    if (name && pts > 0 && name.length < 80) {
      parsed.units.push({ name, points: pts });
    }
  }

  // Alternate: "Name    Xpts"
  ALT_UNIT_REGEX.lastIndex = 0;
  while ((unitMatch = ALT_UNIT_REGEX.exec(text)) !== null) {
    const name = unitMatch[1].trim().replace(/\.+$/, '').trim();
    const pts = parseInt(unitMatch[2], 10);
    if (name && pts > 0 && name.length < 80 && !parsed.units.find((u) => u.name === name && u.points === pts)) {
      parsed.units.push({ name, points: pts });
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

function analyse(lists, metaReport, previousLists) {
  const faction = (metaReport.meta && metaReport.meta.faction) || 'Unknown';

  // Parse all army list texts
  const parsedLists = lists
    .map((l) => ({ ...l, parsed: parseArmyListText(l.armyListText), record: parseRecord(l.record) }))
    .filter((l) => l.parsed && l.parsed.units.length > 0);

  console.log(`Parsed ${parsedLists.length} / ${lists.length} lists successfully.`);

  // Unit analysis (across all lists)
  const unitAnalysis = analyseUnits(parsedLists);

  // Enhancement analysis (across all lists)
  const enhancementAnalysis = analyseEnhancements(parsedLists);

  // Co-occurrence
  const coOccurrence = analyseCoOccurrence(parsedLists);

  // Per-detachment frequency analysis
  const detachmentFrequencyAnalysis = buildDetachmentFrequency(parsedLists);

  // Per-detachment variance analysis
  const varianceAnalysis = buildVarianceAnalysis(parsedLists);

  // Novelty flags — units/enhancements new since the last crawl
  const noveltyFlags = buildNoveltyFlags(parsedLists, previousLists);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      faction,
      totalListsAnalysed: lists.length,
      parsedListsAnalysed: parsedLists.length,
    },
    unitAnalysis,
    enhancementAnalysis,
    coOccurrence: coOccurrence.slice(0, CONFIG.MAX_CO_OCCUR_RESULTS),
    detachmentFrequencyAnalysis,
    varianceAnalysis,
    noveltyFlags,
  };
}

// ---------------------------------------------------------------------------
// Unit analysis — frequency, average points
// ---------------------------------------------------------------------------

function analyseUnits(parsedLists) {
  const unitData = {};
  const totalLists = parsedLists.length;

  for (const list of parsedLists) {
    const seen = new Set();

    for (const unit of list.parsed.units) {
      const key = unit.name;
      if (seen.has(key)) {
        if (unitData[key]) unitData[key].totalCopies++;
        continue;
      }
      seen.add(key);

      if (!unitData[key]) {
        unitData[key] = { name: key, appearances: 0, pointValues: [], totalCopies: 0 };
      }
      unitData[key].appearances++;
      unitData[key].totalCopies++;
      unitData[key].pointValues.push(unit.points);
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
// Co-occurrence analysis
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
// Per-detachment frequency analysis
// ---------------------------------------------------------------------------

function buildDetachmentFrequency(parsedLists) {
  // Group lists by detachment
  const byDet = {};
  for (const list of parsedLists) {
    const det = list.parsed.detachment || list.detachment || extractDetachment(list.armyListText) || 'Unknown';
    if (!byDet[det]) byDet[det] = [];
    byDet[det].push(list);
  }

  return Object.entries(byDet)
    .filter(([det]) => det !== 'Unknown')
    .sort((a, b) => b[1].length - a[1].length)
    .map(([detachment, detLists]) => {
      const totalInDet = detLists.length;

      // Unit frequency within this detachment
      const unitCounts = {};
      const enhCounts = {};
      for (const list of detLists) {
        const seen = new Set();
        for (const unit of list.parsed.units) {
          if (!seen.has(unit.name)) {
            unitCounts[unit.name] = (unitCounts[unit.name] || 0) + 1;
            seen.add(unit.name);
          }
        }
        for (const enh of list.parsed.enhancements) {
          enhCounts[enh] = (enhCounts[enh] || 0) + 1;
        }
      }

      const topUnits = Object.entries(unitCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => ({ name, count, frequency: pct(count, totalInDet) }));

      const topEnhancements = Object.entries(enhCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, CONFIG.TOP_ENHANCEMENTS)
        .map(([name, count]) => ({ name, count, frequency: pct(count, totalInDet) }));

      return { detachment, listCount: totalInDet, topUnits, topEnhancements };
    });
}

// ---------------------------------------------------------------------------
// Per-detachment variance analysis — contested tech choices
// ---------------------------------------------------------------------------

function buildVarianceAnalysis(parsedLists) {
  const byDet = {};
  for (const list of parsedLists) {
    const det = list.parsed.detachment || list.detachment || extractDetachment(list.armyListText) || 'Unknown';
    if (!byDet[det]) byDet[det] = [];
    byDet[det].push(list);
  }

  return Object.entries(byDet)
    .filter(([det, detLists]) => det !== 'Unknown' && detLists.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([detachment, detLists]) => {
      const totalInDet = detLists.length;

      const unitCounts = {};
      for (const list of detLists) {
        const seen = new Set();
        for (const unit of list.parsed.units) {
          if (!seen.has(unit.name)) {
            unitCounts[unit.name] = (unitCounts[unit.name] || 0) + 1;
            seen.add(unit.name);
          }
        }
      }

      // Contested = present in VARIANCE_MIN_PCT–VARIANCE_MAX_PCT of lists in this detachment
      const contested = Object.entries(unitCounts)
        .map(([name, count]) => ({ name, count, frequency: pct(count, totalInDet) }))
        .filter((u) => u.frequency >= CONFIG.VARIANCE_MIN_PCT && u.frequency <= CONFIG.VARIANCE_MAX_PCT)
        .sort((a, b) => b.count - a.count);

      return { detachment, listCount: totalInDet, contestedUnits: contested };
    })
    .filter((d) => d.contestedUnits.length > 0);
}

// ---------------------------------------------------------------------------
// Novelty flags — units/enhancements new since the previous crawl
// ---------------------------------------------------------------------------

function buildNoveltyFlags(parsedLists, previousLists) {
  // Build set of all unit/enhancement names from previous crawl
  const prevNames = new Set();
  for (const list of previousLists) {
    const parsed = parseArmyListText(list.armyListText);
    if (!parsed) continue;
    for (const u of parsed.units) prevNames.add(u.name.toLowerCase());
    for (const e of parsed.enhancements) prevNames.add(e.toLowerCase());
  }

  // Collect names from current crawl that weren't in previous
  const novelNames = new Set();
  const seen = new Set();
  const result = [];

  for (const list of parsedLists) {
    const det = list.parsed.detachment || list.detachment || 'Unknown';
    for (const u of list.parsed.units) {
      const lower = u.name.toLowerCase();
      if (!prevNames.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        result.push({ name: u.name, type: 'unit', detachment: det });
      }
    }
    for (const e of list.parsed.enhancements) {
      const lower = e.toLowerCase();
      if (!prevNames.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        result.push({ name: e, type: 'enhancement', detachment: det });
      }
    }
  }

  return result;
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
  lines.push('  ARMY LIST ANALYSIS');
  lines.push(hr);
  lines.push(`  Generated: ${result.meta.generatedAt}`);
  lines.push(`  Faction: ${result.meta.faction}`);
  lines.push(`  Lists analysed: ${result.meta.totalListsAnalysed} (${result.meta.parsedListsAnalysed} parsed)`);
  lines.push('');

  // Per-detachment frequency
  if (result.detachmentFrequencyAnalysis.length > 0) {
    lines.push(hr2);
    lines.push('  DETACHMENT FREQUENCY ANALYSIS');
    lines.push(hr2);
    for (const d of result.detachmentFrequencyAnalysis) {
      lines.push(`\n  [${d.detachment}] — ${d.listCount} lists`);
      lines.push('  Top Units:');
      for (const u of d.topUnits.slice(0, 8)) {
        lines.push(`    ${u.name.padEnd(40)} ${u.frequency}% (${u.count}/${d.listCount})`);
      }
      if (d.topEnhancements.length > 0) {
        lines.push('  Top Enhancements:');
        for (const e of d.topEnhancements) {
          lines.push(`    ${e.name.padEnd(40)} ${e.frequency}% (${e.count}/${d.listCount})`);
        }
      }
    }
    lines.push('');
  }

  // Variance
  if (result.varianceAnalysis.length > 0) {
    lines.push(hr2);
    lines.push('  CONTESTED TECH CHOICES (appear in 20-79% of detachment lists)');
    lines.push(hr2);
    for (const d of result.varianceAnalysis) {
      lines.push(`\n  [${d.detachment}] — ${d.listCount} lists`);
      for (const u of d.contestedUnits.slice(0, 6)) {
        lines.push(`    ${u.name.padEnd(40)} ${u.frequency}%`);
      }
    }
    lines.push('');
  }

  // Novelty flags
  if (result.noveltyFlags.length > 0) {
    lines.push(hr2);
    lines.push(`  NOVELTY FLAGS — ${result.noveltyFlags.length} new unit/enhancement name(s) since last crawl`);
    lines.push(hr2);
    for (const n of result.noveltyFlags.slice(0, 20)) {
      lines.push(`  [${n.type}] ${n.name} (${n.detachment})`);
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

  lines.push(hr);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
main();
