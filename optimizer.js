const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const listsFile = getArg(args, '--lists') || path.join(__dirname, 'output', 'army-lists-latest.json');
const reportFile = getArg(args, '--report') || path.join(__dirname, 'reports', 'meta-report-latest.json');
const outputDir = getArg(args, '--output') || path.join(__dirname, 'reports');
const format = getArg(args, '--format') || 'all';
const TARGET_POINTS = parseInt(getArg(args, '--points') || '2000', 10);

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const emptyResult = { generatedAt: new Date().toISOString(), totalLists: 0, rankings: [], insights: [] };

  if (!fs.existsSync(listsFile) || !fs.existsSync(reportFile)) {
    console.warn('Input files not found. Generating empty optimizer output.');
    writeOutput(emptyResult, 'No army lists to optimize.\n');
    return;
  }

  const rawLists = JSON.parse(fs.readFileSync(listsFile, 'utf-8'));
  const metaReport = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
  const lists = flattenLists(rawLists);

  if (lists.length === 0) {
    console.warn('No lists found. Generating empty optimizer output.');
    writeOutput(emptyResult, 'No army lists to optimize.\n');
    return;
  }

  console.log(`Loaded ${lists.length} army lists and meta report.\n`);

  const result = optimize(lists, metaReport);
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

function parseRecord(record) {
  if (!record) return null;
  const m = record.match(/(\d+)\s*[-–]\s*(\d+)(?:\s*[-–]\s*(\d+))?/);
  if (!m) return null;
  return { wins: parseInt(m[1], 10), losses: parseInt(m[2], 10), draws: m[3] ? parseInt(m[3], 10) : 0 };
}

function extractDetachment(text) {
  if (!text) return null;
  const m = text.match(/Detachment:\s*(.+?)(?:\n|$)/i) ||
            text.match(/Detachment\s*[-–:]\s*(.+?)(?:\n|$)/i);
  return m ? m[1].trim() : null;
}

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Army list text parsing
// ---------------------------------------------------------------------------

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
  const unitRegex = /^[•·\-\s]*(.+?)\s*[\[(]\s*(\d+)\s*pts?\s*[\])]/gim;
  let unitMatch;
  while ((unitMatch = unitRegex.exec(text)) !== null) {
    const name = unitMatch[1].trim().replace(/^[x×]\d+\s+/i, '').replace(/\s*[-–:]\s*$/, '');
    const pts = parseInt(unitMatch[2], 10);
    if (name && pts > 0 && name.length < 80) {
      parsed.units.push({ name, points: pts });
    }
  }

  // Alternate: "Name    Xpts"
  const altUnitRegex = /^[•·\-\s]*(.+?)\s{2,}\.{0,}?\s*(\d{2,4})\s*pts?\s*$/gim;
  while ((unitMatch = altUnitRegex.exec(text)) !== null) {
    const name = unitMatch[1].trim().replace(/\.+$/, '').trim();
    const pts = parseInt(unitMatch[2], 10);
    if (name && pts > 0 && name.length < 80 && !parsed.units.find((u) => u.name === name && u.points === pts)) {
      parsed.units.push({ name, points: pts });
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Core optimizer
// ---------------------------------------------------------------------------

function optimize(lists, metaReport) {
  const detachmentBreakdown = metaReport.detachmentBreakdown || [];
  const faction = (metaReport.meta && metaReport.meta.faction) || 'Unknown';

  // Detachment stats from meta report
  const detachmentStats = detachmentBreakdown
    .filter((d) => d.detachment !== 'Unknown')
    .map((d) => ({
      detachment: d.detachment,
      count: d.count,
      wins: d.wins || 0,
      losses: d.losses || 0,
      draws: d.draws || 0,
      totalGames: d.totalGames || 0,
      winRate: d.winRate != null ? d.winRate : 0,
      undefeated: d.undefeatedCount || 0,
    }))
    .sort((a, b) => b.winRate - a.winRate || b.undefeated - a.undefeated || b.count - a.count);

  if (detachmentStats.length === 0) {
    return { error: 'No detachment data available to optimize.' };
  }

  // Overall faction stats
  const totalWins = detachmentBreakdown.reduce((s, d) => s + (d.wins || 0), 0);
  const totalGames = detachmentBreakdown.reduce((s, d) => s + (d.totalGames || 0), 0);
  const totalUndefeated = (metaReport.undefeatedLists || []).length;
  const overallWinRate = pct(totalWins, totalGames);

  // Best detachment = highest win rate with at least 2 appearances
  const bestDetachment = detachmentStats.find((d) => d.count >= 2) || detachmentStats[0];

  // Categorise lists by performance
  const winningLists = lists.filter((l) => {
    const rec = parseRecord(l.record);
    return rec && rec.wins >= 3 && rec.wins > rec.losses;
  });
  const undefeatedLists = lists.filter((l) => {
    const rec = parseRecord(l.record);
    return rec && rec.losses === 0 && rec.wins > 0;
  });

  // Parse all army list texts
  const parsedLists = lists
    .map((l) => ({ ...l, parsed: parseArmyListText(l.armyListText), record: parseRecord(l.record) }))
    .filter((l) => l.parsed && l.parsed.units.length > 0);

  const parsedWinning = parsedLists.filter((l) => l.record && l.record.wins >= 3 && l.record.wins > l.record.losses);
  const parsedUndefeated = parsedLists.filter((l) => l.record && l.record.losses === 0 && l.record.wins > 0);

  // Use winning lists for analysis, fall back to all
  const analysisSet = parsedWinning.length >= 3 ? parsedWinning : parsedLists;

  // Unit analysis
  const unitAnalysis = analyseUnits(analysisSet);

  // Enhancement analysis
  const enhancementAnalysis = analyseEnhancements(analysisSet);

  // Build the concrete army list
  const concreteList = buildConcreteArmy(analysisSet, parsedUndefeated, bestDetachment, unitAnalysis);

  // Co-occurrence analysis — which units tend to appear together in winning lists
  const coOccurrence = analyseCoOccurrence(analysisSet);

  // Reasoning
  const reasoning = generateReasoning(faction, bestDetachment, detachmentStats, unitAnalysis, enhancementAnalysis, undefeatedLists, lists, metaReport);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      dataSource: metaReport.meta,
      totalListsAnalysed: lists.length,
      parsedListsAnalysed: parsedLists.length,
      winningListsAnalysed: parsedWinning.length,
      targetPoints: TARGET_POINTS,
    },
    recommendation: {
      faction,
      detachment: bestDetachment.detachment,
      detachmentWinRate: bestDetachment.winRate,
      winRate: overallWinRate,
      undefeatedCount: totalUndefeated,
      score: Math.round(overallWinRate * 3 + totalUndefeated * 10),
    },
    concreteList,
    detachmentAnalysis: detachmentStats,
    unitAnalysis,
    enhancementAnalysis,
    coOccurrence: coOccurrence.slice(0, 15),
    reasoning,
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
// Co-occurrence analysis — which units appear together in winning lists?
// ---------------------------------------------------------------------------

function analyseCoOccurrence(parsedLists) {
  const pairCounts = {};
  const minFrequency = 2;

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
// Build a concrete recommended army list (~2000pts)
// ---------------------------------------------------------------------------

function buildConcreteArmy(parsedLists, parsedUndefeated, bestDetachment, unitAnalysis) {
  // Strategy: Find the most "average" winning list composition.
  // 1. Score each parsed list by how well it represents the meta (sum of unit frequencies)
  // 2. Use the highest-scoring list as the template
  // 3. Alternatively, if we have undefeated lists, prefer those

  const candidates = parsedUndefeated.length > 0 ? parsedUndefeated : parsedLists;

  // Build a frequency map from unit analysis for quick lookup
  const freqMap = {};
  for (const u of unitAnalysis.units) {
    freqMap[u.name] = u.frequency;
  }

  // Score each list: sum of unit frequencies (higher = more "meta-representative")
  let bestList = null;
  let bestScore = -1;

  for (const list of candidates) {
    const unitNames = [...new Set(list.parsed.units.map((u) => u.name))];
    const score = unitNames.reduce((s, name) => s + (freqMap[name] || 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestList = list;
    }
  }

  if (!bestList) {
    return buildSyntheticArmy(unitAnalysis, bestDetachment);
  }

  // Build the concrete list from the template
  const templateUnits = bestList.parsed.units.map((u) => {
    const analysis = unitAnalysis.units.find((a) => a.name === u.name);
    return {
      name: u.name,
      points: u.points,
      metaFrequency: analysis ? analysis.frequency : 0,
      tier: analysis ? (analysis.frequency >= 40 ? 'core' : analysis.frequency >= 20 ? 'common' : 'flex') : 'flex',
    };
  });

  const totalPoints = templateUnits.reduce((s, u) => s + u.points, 0);

  return {
    source: bestList.record && bestList.record.losses === 0 ? 'undefeated' : 'top-performing',
    sourcePlayer: bestList.playerName || bestList.player || 'Unknown',
    sourceEvent: bestList.event || 'Unknown',
    sourceRecord: bestList.record ? `${bestList.record.wins}-${bestList.record.losses}-${bestList.record.draws}` : 'N/A',
    detachment: bestList.parsed.detachment || bestDetachment.detachment,
    enhancements: bestList.parsed.enhancements,
    warlord: bestList.parsed.warlord,
    units: templateUnits,
    totalPoints,
    metaScore: Math.round(bestScore),
  };
}

// Fallback: synthesise a list from the most popular units
function buildSyntheticArmy(unitAnalysis, bestDetachment) {
  const units = [];
  let points = 0;

  for (const u of unitAnalysis.units) {
    if (points + u.typicalPoints > TARGET_POINTS + 50) continue;
    const copies = Math.min(Math.round(u.avgCopies), u.typicalPoints > 0 ? Math.floor((TARGET_POINTS - points) / u.typicalPoints) : 1);
    for (let i = 0; i < Math.max(1, copies); i++) {
      if (points + u.typicalPoints > TARGET_POINTS + 50) break;
      units.push({
        name: u.name,
        points: u.typicalPoints,
        metaFrequency: u.frequency,
        tier: u.frequency >= 40 ? 'core' : u.frequency >= 20 ? 'common' : 'flex',
      });
      points += u.typicalPoints;
    }
    if (points >= TARGET_POINTS - 100) break;
  }

  return {
    source: 'synthetic',
    sourcePlayer: null,
    sourceEvent: null,
    sourceRecord: null,
    detachment: bestDetachment.detachment,
    enhancements: [],
    warlord: null,
    units,
    totalPoints: points,
    metaScore: 0,
  };
}

// ---------------------------------------------------------------------------
// Reasoning generator
// ---------------------------------------------------------------------------

function generateReasoning(faction, bestDet, allDets, unitAnalysis, enhancementAnalysis, undefeatedLists, allLists, metaReport) {
  const sections = [];

  // Faction overview
  const events = (metaReport.eventBreakdown || []).length;
  const totalGames = allDets.reduce((s, d) => s + d.totalGames, 0);
  const overallWR = pct(allDets.reduce((s, d) => s + d.wins, 0), totalGames);
  sections.push({
    title: 'Faction Overview',
    text: `Analysing ${faction} across ${allLists.length} tournament lists and ${totalGames} recorded games. ` +
      `Overall ${overallWR}% win rate with ${undefeatedLists.length} undefeated finishes.` +
      (events > 0 ? ` Data spans ${events} events.` : ''),
  });

  // Detachment choice
  if (bestDet) {
    let text = `The recommended detachment is "${bestDet.detachment}" with a ${bestDet.winRate}% win rate across ${bestDet.totalGames} games (${bestDet.count} lists).`;
    if (bestDet.undefeated > 0) text += ` ${bestDet.undefeated} undefeated finishes used this detachment.`;
    const others = allDets.filter((d) => d.detachment !== bestDet.detachment).slice(0, 3);
    if (others.length > 0) {
      text += ` Other options: ${others.map((d) => `${d.detachment} (${d.winRate}% WR, ${d.count} lists)`).join(', ')}.`;
    }
    sections.push({ title: 'Detachment Choice', text });
  }

  // Unit choices
  if (unitAnalysis.parsedLists > 0) {
    const core = unitAnalysis.units.filter((u) => u.frequency >= 40);
    const common = unitAnalysis.units.filter((u) => u.frequency >= 20 && u.frequency < 40);
    let text = `Analysed ${unitAnalysis.parsedLists} army lists with parseable unit data.`;
    if (core.length > 0) {
      text += `\n\nCore units (40%+ of lists):\n` + core.map((u) => `  - ${u.name}: ${u.frequency}% appearance, ~${u.typicalPoints}pts`).join('\n');
    }
    if (common.length > 0) {
      text += `\n\nCommon picks (20-39%):\n` + common.map((u) => `  - ${u.name}: ${u.frequency}% appearance, ~${u.typicalPoints}pts`).join('\n');
    }
    sections.push({ title: 'Unit Choices', text });
  }

  // Enhancements
  if (enhancementAnalysis.enhancements.length > 0) {
    const top = enhancementAnalysis.enhancements.slice(0, 5);
    sections.push({
      title: 'Enhancement Picks',
      text: `Top enhancements among winning lists:\n` + top.map((e) => `  - ${e.name}: ${e.frequency}% usage (${e.appearances}x)`).join('\n'),
    });
  }

  // Strategy
  const core = unitAnalysis.units.filter((u) => u.frequency >= 40);
  let strat = `Playing ${faction} means leveraging a faction with proven competitive results.`;
  if (bestDet) strat += ` The ${bestDet.detachment} detachment is the data-backed choice.`;
  if (core.length > 0) strat += ` Build around: ${core.map((u) => u.name).join(', ')}.`;
  if (undefeatedLists.length > 0) strat += ` ${undefeatedLists.length} undefeated finishes confirm the ceiling is high.`;
  sections.push({ title: 'Strategy', text: strat });

  return sections;
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
  lines.push('  ARMY OPTIMIZER — RECOMMENDED BUILD');
  lines.push(hr);
  lines.push(`  Generated: ${result.meta.generatedAt}`);
  lines.push(`  Lists analysed: ${result.meta.totalListsAnalysed} (${result.meta.parsedListsAnalysed} parsed, ${result.meta.winningListsAnalysed} winning)`);
  lines.push(`  Target: ${result.meta.targetPoints}pts`);
  lines.push('');

  // Recommendation summary
  const rec = result.recommendation;
  lines.push(hr2);
  lines.push(`  ${rec.faction} — ${rec.detachment}`);
  lines.push(hr2);
  lines.push(`  Win Rate: ${rec.winRate}%  |  Undefeated: ${rec.undefeatedCount}  |  Score: ${rec.score}`);
  lines.push('');

  // Concrete army list
  const cl = result.concreteList;
  if (cl) {
    lines.push(hr2);
    lines.push('  RECOMMENDED ARMY LIST');
    lines.push(hr2);
    if (cl.source !== 'synthetic') {
      lines.push(`  Based on: ${cl.sourcePlayer} (${cl.sourceRecord}) at ${cl.sourceEvent}`);
      lines.push(`  Source: ${cl.source === 'undefeated' ? 'Undefeated list' : 'Top-performing list'}`);
    } else {
      lines.push(`  Source: Synthesised from most common units`);
    }
    lines.push(`  Detachment: ${cl.detachment}`);
    if (cl.warlord) lines.push(`  Warlord: ${cl.warlord}`);
    if (cl.enhancements.length > 0) lines.push(`  Enhancements: ${cl.enhancements.join(', ')}`);
    lines.push(`  Total: ${cl.totalPoints}pts`);
    lines.push('');

    // Group units by tier
    const tiers = { core: [], common: [], flex: [] };
    for (const u of cl.units) {
      (tiers[u.tier] || tiers.flex).push(u);
    }

    for (const [tier, units] of Object.entries(tiers)) {
      if (units.length === 0) continue;
      const label = tier === 'core' ? 'Core Units' : tier === 'common' ? 'Common Picks' : 'Flex Slots';
      lines.push(`  ${label}:`);
      for (const u of units) {
        lines.push(`    ${u.name.padEnd(40)} ${String(u.points).padStart(4)}pts  (${u.metaFrequency}% meta)`);
      }
      lines.push('');
    }
  }

  // Detachment comparison
  if (result.detachmentAnalysis.length > 0) {
    lines.push(hr2);
    lines.push('  DETACHMENT COMPARISON');
    lines.push(hr2);
    lines.push(padRow(['Detachment', 'Lists', 'WR%', 'Undefeated']));
    lines.push(padRow(['----------', '-----', '---', '----------']));
    for (const d of result.detachmentAnalysis) {
      lines.push(padRow([d.detachment, d.count, `${d.winRate}%`, d.undefeated]));
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

  // Reasoning
  lines.push(hr2);
  lines.push('  ANALYSIS');
  lines.push(hr2);
  for (const section of result.reasoning) {
    lines.push('');
    lines.push(`  ## ${section.title}`);
    lines.push('');
    for (const line of section.text.split('\n')) {
      lines.push(line.startsWith('  ') ? line : `  ${line}`);
    }
  }

  lines.push('');
  lines.push(hr);
  return lines.join('\n');
}

function padRow(cols) {
  const widths = [28, 8, 8, 12];
  return '  ' + cols.map((c, i) => String(c).padEnd(widths[i] || 12)).join('');
}

// ---------------------------------------------------------------------------
main();
