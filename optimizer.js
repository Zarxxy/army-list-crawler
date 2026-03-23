const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const listsFile = getArg(args, '--lists') || path.join(__dirname, 'output', 'army-lists-latest.json');
const reportFile = getArg(args, '--report') || path.join(__dirname, 'reports', 'meta-report-latest.json');
const outputDir = getArg(args, '--output') || path.join(__dirname, 'reports');
const game = getArg(args, '--game'); // "40k" or "aos" — optional filter
const format = getArg(args, '--format') || 'all'; // "json", "text", "all"

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(listsFile) || !fs.existsSync(reportFile)) {
    console.warn('Input files not found. Generating empty optimizer output.');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const empty = { generatedAt: new Date().toISOString(), totalLists: 0, rankings: [], insights: [] };
    if (format === 'json' || format === 'all') {
      fs.writeFileSync(path.join(outputDir, 'optimizer-latest.json'), JSON.stringify(empty, null, 2), 'utf-8');
    }
    if (format === 'text' || format === 'all') {
      fs.writeFileSync(path.join(outputDir, 'optimizer-latest.txt'), 'No army lists to optimize.\n', 'utf-8');
    }
    console.log('Empty optimizer output saved.');
    return;
  }

  const rawLists = JSON.parse(fs.readFileSync(listsFile, 'utf-8'));
  const metaReport = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));

  let lists = flattenLists(rawLists);

  // Optional game filter
  if (game) {
    const needle = game.toLowerCase();
    lists = lists.filter((l) => (l.section || '').toLowerCase().includes(needle));
  }

  if (lists.length === 0) {
    console.warn('No lists found. Generating empty optimizer output.');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const empty = { generatedAt: new Date().toISOString(), totalLists: 0, rankings: [], insights: [] };
    if (format === 'json' || format === 'all') {
      fs.writeFileSync(path.join(outputDir, 'optimizer-latest.json'), JSON.stringify(empty, null, 2), 'utf-8');
    }
    if (format === 'text' || format === 'all') {
      fs.writeFileSync(path.join(outputDir, 'optimizer-latest.txt'), 'No army lists to optimize.\n', 'utf-8');
    }
    console.log('Empty optimizer output saved.');
    return;
  }

  console.log(`Loaded ${lists.length} army lists and meta report.\n`);

  const result = optimize(lists, metaReport);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Console output (always)
  const textOutput = renderText(result);
  console.log(textOutput);

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
  for (const [sectionName, entries] of Object.entries(raw.sections || {})) {
    for (const entry of entries) {
      lists.push({ ...entry, section: sectionName });
    }
  }
  return lists;
}

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

function normaliseFaction(name) {
  if (!name) return 'Unknown';
  return name.trim().replace(/\s+/g, ' ');
}

function extractDetachment(text) {
  if (!text) return null;
  const m =
    text.match(/Detachment:\s*(.+?)(?:\n|$)/i) ||
    text.match(/Detachment\s*[-–:]\s*(.+?)(?:\n|$)/i);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Army list text parsing — extract units, enhancements, warlord, etc.
// ---------------------------------------------------------------------------

function parseArmyListText(text) {
  if (!text) return null;

  const parsed = {
    units: [],
    enhancements: [],
    warlord: null,
    detachment: null,
    points: null,
    rawBlocks: [],
  };

  // Detachment
  const detMatch =
    text.match(/Detachment:\s*(.+?)(?:\n|$)/i) ||
    text.match(/Detachment\s*[-–:]\s*(.+?)(?:\n|$)/i);
  if (detMatch) parsed.detachment = detMatch[1].trim();

  // Points total
  const ptsMatch = text.match(/\[?\s*(\d{3,5})\s*(?:pts|points)\s*\]?/i);
  if (ptsMatch) parsed.points = parseInt(ptsMatch[1], 10);

  // Warlord
  const warlordMatch = text.match(/Warlord:\s*(.+?)(?:\n|$)/i) ||
    text.match(/\bWarlord\b[^:\n]*?[-–:]\s*(.+?)(?:\n|$)/i);
  if (warlordMatch) parsed.warlord = warlordMatch[1].trim();

  // Enhancements — look for "Enhancement: X" or "Enhancements: X"
  const enhRegex = /Enhancement[s]?:\s*(.+?)(?:\n|$)/gi;
  let enhMatch;
  while ((enhMatch = enhRegex.exec(text)) !== null) {
    const enh = enhMatch[1].trim();
    if (enh && enh.toLowerCase() !== 'none') parsed.enhancements.push(enh);
  }

  // Also catch inline enhancement markers like "• Enhancement: Name (Xpts)"
  const inlineEnhRegex = /[•·\-]\s*Enhancement[s]?\s*[-–:]?\s*(.+?)(?:\s*\(?\d+\s*pts?\)?)?(?:\n|$)/gi;
  while ((enhMatch = inlineEnhRegex.exec(text)) !== null) {
    const enh = enhMatch[1].trim().replace(/\s*\(?\d+\s*pts?\)?\s*$/, '');
    if (enh && enh.toLowerCase() !== 'none' && !parsed.enhancements.includes(enh)) {
      parsed.enhancements.push(enh);
    }
  }

  // Units — look for lines with point costs like "Unit Name [Xpts]" or "Unit Name (Xpts)"
  // Also match BattleScribe-style: "Unit Name . . . . Xpts"
  const unitRegex = /^[•·\-\s]*(.+?)\s*[\[(]\s*(\d+)\s*pts?\s*[\])]/gim;
  let unitMatch;
  while ((unitMatch = unitRegex.exec(text)) !== null) {
    const name = unitMatch[1]
      .trim()
      .replace(/^[x×]\d+\s+/i, '') // remove "x3 " prefix
      .replace(/\s*[-–:]\s*$/, '');
    const pts = parseInt(unitMatch[2], 10);
    if (name && pts > 0 && name.length < 80) {
      parsed.units.push({ name, points: pts });
    }
  }

  // Alternate pattern: "Name . . . Xpts" or "Name    Xpts"
  const altUnitRegex = /^[•·\-\s]*(.+?)\s{2,}\.{0,}?\s*(\d{2,4})\s*pts?\s*$/gim;
  while ((unitMatch = altUnitRegex.exec(text)) !== null) {
    const name = unitMatch[1].trim().replace(/\.+$/, '').trim();
    const pts = parseInt(unitMatch[2], 10);
    if (name && pts > 0 && name.length < 80 && !parsed.units.find((u) => u.name === name && u.points === pts)) {
      parsed.units.push({ name, points: pts });
    }
  }

  // Roster blocks: ++ HQ ++, ++ Troops ++, etc.
  const blockRegex = /\+\+\s*(.+?)\s*\+\+/g;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(text)) !== null) {
    parsed.rawBlocks.push(blockMatch[1].trim());
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Core optimizer logic
// ---------------------------------------------------------------------------

function optimize(lists, metaReport) {
  const factionWinRates = metaReport.factionWinRates || [];
  const factionBreakdown = metaReport.factionBreakdown || [];
  const undefeatedLists = metaReport.undefeatedLists || [];
  const detachmentBreakdown = metaReport.detachmentBreakdown || [];

  // ---- Step 1: Score every faction ----
  const factionScores = scoreFactions(factionWinRates, factionBreakdown, undefeatedLists);

  // ---- Step 2: Pick optimal faction ----
  const topFaction = factionScores[0];
  if (!topFaction) {
    return { error: 'No factions with enough data to optimize.' };
  }

  // ---- Step 3: Find best detachment for the faction ----
  const factionDetachments = analyseDetachments(lists, topFaction.faction, detachmentBreakdown);

  // ---- Step 4: Get all lists for the top faction ----
  const factionLists = lists.filter(
    (l) => normaliseFaction(l.faction) === topFaction.faction
  );

  // Separate winning lists (3+ wins, or undefeated)
  const winningLists = factionLists.filter((l) => {
    const rec = parseRecord(l.record);
    return rec && rec.wins >= 3 && rec.wins > rec.losses;
  });

  const undefeatedFactionLists = factionLists.filter((l) => {
    const rec = parseRecord(l.record);
    return rec && rec.losses === 0 && rec.wins > 0;
  });

  // ---- Step 5: Analyse unit and enhancement patterns ----
  const unitAnalysis = analyseUnits(winningLists.length > 0 ? winningLists : factionLists);
  const enhancementAnalysis = analyseEnhancements(winningLists.length > 0 ? winningLists : factionLists);

  // ---- Step 6: Build recommended army ----
  const recommendedArmy = buildRecommendedArmy(
    topFaction,
    factionDetachments,
    unitAnalysis,
    enhancementAnalysis,
    undefeatedFactionLists
  );

  // ---- Step 7: Generate reasoning ----
  const reasoning = generateReasoning(
    topFaction,
    factionScores,
    factionDetachments,
    unitAnalysis,
    enhancementAnalysis,
    undefeatedFactionLists,
    factionLists,
    metaReport
  );

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      dataSource: metaReport.meta,
      totalListsAnalysed: lists.length,
      factionListsAnalysed: factionLists.length,
      winningListsAnalysed: winningLists.length,
    },
    factionRankings: factionScores,
    recommendation: {
      faction: topFaction.faction,
      score: topFaction.score,
      winRate: topFaction.winRate,
      undefeatedCount: topFaction.undefeatedCount,
      representation: topFaction.representation,
      detachment: recommendedArmy.detachment,
      army: recommendedArmy,
    },
    detachmentAnalysis: factionDetachments,
    unitAnalysis,
    enhancementAnalysis,
    reasoning,
  };
}

// ---------------------------------------------------------------------------
// Faction scoring
// ---------------------------------------------------------------------------

function scoreFactions(winRates, breakdown, undefeated) {
  // Build undefeated count per faction
  const undefeatedMap = {};
  for (const u of undefeated) {
    const f = normaliseFaction(u.faction);
    undefeatedMap[f] = (undefeatedMap[f] || 0) + 1;
  }

  // Build representation map
  const repMap = {};
  for (const f of breakdown) {
    repMap[normaliseFaction(f.faction)] = {
      count: f.count,
      percentage: parseFloat(f.percentage) || 0,
    };
  }

  const scored = winRates
    .filter((f) => f.totalGames >= 5) // minimum sample size
    .map((f) => {
      const faction = normaliseFaction(f.faction);
      const wr = f.winRate;
      const ud = undefeatedMap[faction] || 0;
      const rep = repMap[faction] || { count: 0, percentage: 0 };

      // Composite score:
      //   - Win rate is king (0-100, weighted x3)
      //   - Undefeated count rewards proven dominance (weighted x10)
      //   - Representation is a mild bonus (popular = more data = more trust)
      //     but not too much — we don't want to just pick the most played faction
      const score =
        wr * 3 +
        ud * 10 +
        Math.min(rep.percentage, 15) * 0.5; // cap rep bonus at 15%

      return {
        faction,
        score: Math.round(score * 10) / 10,
        winRate: wr,
        undefeatedCount: ud,
        representation: rep.percentage,
        listCount: rep.count,
        wins: f.wins,
        losses: f.losses,
        draws: f.draws,
        totalGames: f.totalGames,
      };
    })
    .sort((a, b) => b.score - a.score);

  return scored;
}

// ---------------------------------------------------------------------------
// Detachment analysis for the chosen faction
// ---------------------------------------------------------------------------

function analyseDetachments(lists, faction, detachmentBreakdown) {
  // Get all lists for this faction that have army text
  const factionLists = lists.filter(
    (l) => normaliseFaction(l.faction) === faction
  );

  // Count detachments among winning lists
  const detachmentStats = {};

  for (const list of factionLists) {
    const det = list.detachment || extractDetachment(list.armyListText) || 'Unknown';
    const rec = parseRecord(list.record);

    if (!detachmentStats[det]) {
      detachmentStats[det] = { count: 0, wins: 0, losses: 0, draws: 0, games: 0, undefeated: 0 };
    }
    detachmentStats[det].count++;

    if (rec) {
      detachmentStats[det].wins += rec.wins;
      detachmentStats[det].losses += rec.losses;
      detachmentStats[det].draws += rec.draws;
      detachmentStats[det].games += rec.wins + rec.losses + rec.draws;
      if (rec.losses === 0 && rec.wins > 0) detachmentStats[det].undefeated++;
    }
  }

  return Object.entries(detachmentStats)
    .map(([detachment, stats]) => ({
      detachment,
      count: stats.count,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      totalGames: stats.games,
      winRate: stats.games > 0 ? Math.round((stats.wins / stats.games) * 1000) / 10 : 0,
      undefeated: stats.undefeated,
    }))
    .sort((a, b) => b.winRate - a.winRate || b.undefeated - a.undefeated || b.count - a.count);
}

// ---------------------------------------------------------------------------
// Unit analysis — what units show up in winning lists?
// ---------------------------------------------------------------------------

function analyseUnits(lists) {
  const unitCounts = {};
  const unitPoints = {};
  let parsedListCount = 0;

  for (const list of lists) {
    const parsed = parseArmyListText(list.armyListText);
    if (!parsed || parsed.units.length === 0) continue;
    parsedListCount++;

    const seen = new Set(); // dedupe within a single list
    for (const unit of parsed.units) {
      const key = unit.name;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!unitCounts[key]) unitCounts[key] = 0;
      unitCounts[key]++;

      if (!unitPoints[key]) unitPoints[key] = [];
      unitPoints[key].push(unit.points);
    }
  }

  const results = Object.entries(unitCounts)
    .map(([name, count]) => {
      const pts = unitPoints[name] || [];
      const avgPts = pts.length > 0 ? Math.round(pts.reduce((s, v) => s + v, 0) / pts.length) : 0;
      return {
        name,
        appearances: count,
        frequency: parsedListCount > 0 ? Math.round((count / parsedListCount) * 1000) / 10 : 0,
        avgPoints: avgPts,
      };
    })
    .sort((a, b) => b.frequency - a.frequency || b.appearances - a.appearances);

  return {
    parsedLists: parsedListCount,
    totalLists: lists.length,
    units: results,
  };
}

// ---------------------------------------------------------------------------
// Enhancement analysis
// ---------------------------------------------------------------------------

function analyseEnhancements(lists) {
  const enhCounts = {};
  let parsedListCount = 0;

  for (const list of lists) {
    const parsed = parseArmyListText(list.armyListText);
    if (!parsed) continue;
    if (parsed.enhancements.length > 0) parsedListCount++;

    for (const enh of parsed.enhancements) {
      enhCounts[enh] = (enhCounts[enh] || 0) + 1;
    }
  }

  const results = Object.entries(enhCounts)
    .map(([name, count]) => ({
      name,
      appearances: count,
      frequency: parsedListCount > 0 ? Math.round((count / parsedListCount) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.frequency - a.frequency || b.appearances - a.appearances);

  return {
    parsedLists: parsedListCount,
    enhancements: results,
  };
}

// ---------------------------------------------------------------------------
// Build recommended army
// ---------------------------------------------------------------------------

function buildRecommendedArmy(topFaction, detachments, unitAnalysis, enhancementAnalysis, undefeatedLists) {
  // Best detachment = highest win rate with at least 2 appearances
  const bestDetachment = detachments.find((d) => d.detachment !== 'Unknown' && d.count >= 2) ||
    detachments.find((d) => d.detachment !== 'Unknown') ||
    { detachment: 'Unknown', winRate: 0 };

  // Core units = units appearing in 40%+ of winning lists
  const coreUnits = unitAnalysis.units.filter((u) => u.frequency >= 40);

  // Common units = 20-39%
  const commonUnits = unitAnalysis.units.filter((u) => u.frequency >= 20 && u.frequency < 40);

  // Flex picks = 10-19%
  const flexUnits = unitAnalysis.units.filter((u) => u.frequency >= 10 && u.frequency < 20);

  // Top enhancements
  const topEnhancements = enhancementAnalysis.enhancements.slice(0, 5);

  // Estimated total points from core + common units
  const estimatedPoints = [...coreUnits, ...commonUnits].reduce((sum, u) => sum + u.avgPoints, 0);

  return {
    faction: topFaction.faction,
    detachment: bestDetachment.detachment,
    detachmentWinRate: bestDetachment.winRate,
    coreUnits,
    commonUnits,
    flexUnits,
    enhancements: topEnhancements,
    estimatedCorePoints: estimatedPoints,
    basedOnLists: unitAnalysis.parsedLists,
    basedOnUndefeated: undefeatedLists.length,
  };
}

// ---------------------------------------------------------------------------
// Reasoning generator
// ---------------------------------------------------------------------------

function generateReasoning(
  topFaction,
  factionScores,
  detachments,
  unitAnalysis,
  enhancementAnalysis,
  undefeatedLists,
  factionLists,
  metaReport
) {
  const sections = [];

  // ---- 1. Meta position ----
  const rank = factionScores.findIndex((f) => f.faction === topFaction.faction) + 1;
  const totalFactions = factionScores.length;
  const runner = factionScores[1];

  sections.push({
    title: 'Meta Position',
    text: buildMetaPositionText(topFaction, rank, totalFactions, runner, metaReport),
  });

  // ---- 2. Why this faction ----
  sections.push({
    title: 'Why This Faction',
    text: buildWhyFactionText(topFaction, factionScores),
  });

  // ---- 3. Detachment synergies ----
  const bestDet = detachments.find((d) => d.detachment !== 'Unknown') || detachments[0];
  if (bestDet) {
    sections.push({
      title: 'Detachment Choice',
      text: buildDetachmentText(bestDet, detachments, topFaction),
    });
  }

  // ---- 4. Unit choices ----
  sections.push({
    title: 'Unit Choices',
    text: buildUnitText(unitAnalysis),
  });

  // ---- 5. Enhancement picks ----
  if (enhancementAnalysis.enhancements.length > 0) {
    sections.push({
      title: 'Enhancement Picks',
      text: buildEnhancementText(enhancementAnalysis),
    });
  }

  // ---- 6. Strategy summary ----
  sections.push({
    title: 'Strategy',
    text: buildStrategyText(topFaction, bestDet, unitAnalysis, undefeatedLists),
  });

  return sections;
}

function buildMetaPositionText(faction, rank, total, runner, report) {
  const lines = [];
  lines.push(
    `${faction.faction} currently holds the #${rank} position out of ${total} factions with competitive data.`
  );
  lines.push(
    `With a ${faction.winRate}% win rate across ${faction.totalGames} games and ${faction.undefeatedCount} undefeated finishes, this faction is performing above the field.`
  );
  if (runner) {
    const gap = Math.round((faction.score - runner.score) * 10) / 10;
    lines.push(
      `The next closest faction is ${runner.faction} (${runner.winRate}% WR, score gap: ${gap}).`
    );
  }
  lines.push(
    `Representation sits at ${faction.representation}% of the meta (${faction.listCount} lists), which means ${
      faction.representation > 10
        ? 'the data is well-supported with a healthy sample size.'
        : 'the sample is smaller, but the results are strong enough to act on.'
    }`
  );
  return lines.join(' ');
}

function buildWhyFactionText(faction, scores) {
  const lines = [];
  lines.push(
    `The optimizer scores factions using a weighted composite: win rate (×3), undefeated finishes (×10 each), and a capped representation bonus.`
  );
  lines.push(
    `${faction.faction} scored ${faction.score}, driven primarily by its ${faction.winRate}% win rate` +
    (faction.undefeatedCount > 0
      ? ` and ${faction.undefeatedCount} undefeated tournament run${faction.undefeatedCount > 1 ? 's' : ''}.`
      : '.')
  );

  // Compare to average
  const avgWR =
    scores.length > 0
      ? Math.round((scores.reduce((s, f) => s + f.winRate, 0) / scores.length) * 10) / 10
      : 50;
  const delta = Math.round((faction.winRate - avgWR) * 10) / 10;
  if (delta > 0) {
    lines.push(`This is ${delta} percentage points above the field average of ${avgWR}%.`);
  }

  return lines.join(' ');
}

function buildDetachmentText(bestDet, allDets, faction) {
  const lines = [];
  lines.push(
    `The recommended detachment is "${bestDet.detachment}" with a ${bestDet.winRate}% win rate across ${bestDet.totalGames} games (${bestDet.count} lists).`
  );
  if (bestDet.undefeated > 0) {
    lines.push(
      `${bestDet.undefeated} of the faction's undefeated finishes used this detachment.`
    );
  }
  const others = allDets.filter((d) => d.detachment !== 'Unknown' && d.detachment !== bestDet.detachment);
  if (others.length > 0) {
    const otherStr = others
      .slice(0, 3)
      .map((d) => `${d.detachment} (${d.winRate}% WR, ${d.count} lists)`)
      .join(', ');
    lines.push(`Other detachments seen: ${otherStr}.`);
  }
  return lines.join(' ');
}

function buildUnitText(unitAnalysis) {
  const lines = [];

  if (unitAnalysis.parsedLists === 0) {
    return 'No army list text was available for unit-level analysis. Run the crawler with detail page scraping to enable this feature.';
  }

  lines.push(
    `Analysed ${unitAnalysis.parsedLists} army lists with parseable unit data (out of ${unitAnalysis.totalLists} total).`
  );

  const core = unitAnalysis.units.filter((u) => u.frequency >= 40);
  if (core.length > 0) {
    lines.push(
      `\nCore units (40%+ of winning lists):\n` +
      core.map((u) => `  - ${u.name}: ${u.frequency}% appearance rate, ~${u.avgPoints}pts`).join('\n')
    );
  }

  const common = unitAnalysis.units.filter((u) => u.frequency >= 20 && u.frequency < 40);
  if (common.length > 0) {
    lines.push(
      `\nCommon picks (20-39%):\n` +
      common.map((u) => `  - ${u.name}: ${u.frequency}% appearance rate, ~${u.avgPoints}pts`).join('\n')
    );
  }

  const flex = unitAnalysis.units.filter((u) => u.frequency >= 10 && u.frequency < 20);
  if (flex.length > 0) {
    lines.push(
      `\nFlex slots (10-19%):\n` +
      flex.map((u) => `  - ${u.name}: ${u.frequency}% appearance rate, ~${u.avgPoints}pts`).join('\n')
    );
  }

  return lines.join('\n');
}

function buildEnhancementText(enhancementAnalysis) {
  const lines = [];
  const top = enhancementAnalysis.enhancements.slice(0, 5);

  if (top.length === 0) return 'No enhancement data found in the army lists.';

  lines.push(`Top enhancements among winning lists:`);
  for (const e of top) {
    lines.push(`  - ${e.name}: used in ${e.frequency}% of lists (${e.appearances} appearances)`);
  }

  return lines.join('\n');
}

function buildStrategyText(faction, bestDet, unitAnalysis, undefeatedLists) {
  const lines = [];

  lines.push(`Playing ${faction.faction} right now means leveraging a faction that is statistically outperforming the field.`);

  if (bestDet && bestDet.detachment !== 'Unknown') {
    lines.push(
      `The ${bestDet.detachment} detachment is the proven choice, backed by tournament results.`
    );
  }

  const core = unitAnalysis.units.filter((u) => u.frequency >= 40);
  if (core.length > 0) {
    lines.push(
      `Build your core around: ${core.map((u) => u.name).join(', ')}. These are the units that consistently show up in winning lists.`
    );
  }

  if (undefeatedLists.length > 0) {
    lines.push(
      `${undefeatedLists.length} player${undefeatedLists.length > 1 ? 's have' : ' has'} gone undefeated with this faction recently, confirming that the ceiling is high.`
    );
  }

  lines.push(
    `Focus on the units and enhancements highlighted above, adapt flex slots to your local meta, and trust the data.`
  );

  return lines.join(' ');
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
  lines.push(`  Lists analysed: ${result.meta.totalListsAnalysed} total, ${result.meta.factionListsAnalysed} for chosen faction`);
  lines.push(`  Winning lists studied: ${result.meta.winningListsAnalysed}`);
  lines.push('');

  // Faction Rankings
  lines.push(hr2);
  lines.push('  FACTION RANKINGS (top 10)');
  lines.push(hr2);
  lines.push(padRow(['#', 'Faction', 'Score', 'WR%', 'Undefeated', 'Lists']));
  lines.push(padRow(['-', '-------', '-----', '---', '----------', '-----']));
  const top10 = result.factionRankings.slice(0, 10);
  top10.forEach((f, i) => {
    lines.push(padRow([i + 1, f.faction, f.score, `${f.winRate}%`, f.undefeatedCount, f.listCount]));
  });
  lines.push('');

  // Recommendation
  const rec = result.recommendation;
  lines.push(hr2);
  lines.push(`  RECOMMENDED: ${rec.faction}`);
  lines.push(hr2);
  lines.push(`  Detachment:    ${rec.detachment}`);
  lines.push(`  Win Rate:      ${rec.winRate}%`);
  lines.push(`  Undefeated:    ${rec.undefeatedCount}`);
  lines.push(`  Meta Share:    ${rec.representation}%`);
  lines.push(`  Optimizer Score: ${rec.score}`);
  lines.push('');

  // Detachment Analysis
  if (result.detachmentAnalysis.length > 0) {
    lines.push(hr2);
    lines.push(`  DETACHMENTS FOR ${rec.faction.toUpperCase()}`);
    lines.push(hr2);
    lines.push(padRow(['Detachment', 'Count', 'WR%', 'Undefeated']));
    lines.push(padRow(['----------', '-----', '---', '----------']));
    for (const d of result.detachmentAnalysis) {
      lines.push(padRow([d.detachment, d.count, `${d.winRate}%`, d.undefeated]));
    }
    lines.push('');
  }

  // Recommended Army
  const army = rec.army;
  lines.push(hr2);
  lines.push('  RECOMMENDED ARMY BUILD');
  lines.push(hr2);

  if (army.coreUnits.length > 0) {
    lines.push('  Core Units (must-takes):');
    for (const u of army.coreUnits) {
      lines.push(`    * ${u.name} — ${u.frequency}% of lists, ~${u.avgPoints}pts`);
    }
    lines.push('');
  }

  if (army.commonUnits.length > 0) {
    lines.push('  Common Picks (strong includes):');
    for (const u of army.commonUnits) {
      lines.push(`    * ${u.name} — ${u.frequency}% of lists, ~${u.avgPoints}pts`);
    }
    lines.push('');
  }

  if (army.flexUnits.length > 0) {
    lines.push('  Flex Slots (meta-dependent):');
    for (const u of army.flexUnits) {
      lines.push(`    * ${u.name} — ${u.frequency}% of lists, ~${u.avgPoints}pts`);
    }
    lines.push('');
  }

  if (army.enhancements.length > 0) {
    lines.push('  Enhancements:');
    for (const e of army.enhancements) {
      lines.push(`    * ${e.name} — ${e.frequency}% usage (${e.appearances}x)`);
    }
    lines.push('');
  }

  if (army.estimatedCorePoints > 0) {
    lines.push(`  Estimated core cost: ~${army.estimatedCorePoints}pts`);
    lines.push('');
  }

  // Reasoning
  lines.push(hr2);
  lines.push('  ANALYSIS & REASONING');
  lines.push(hr2);
  for (const section of result.reasoning) {
    lines.push('');
    lines.push(`  ## ${section.title}`);
    lines.push('');
    // Indent each line of reasoning text
    const wrapped = section.text.split('\n').map((l) => (l.startsWith('  ') ? l : `  ${l}`));
    lines.push(...wrapped);
  }

  lines.push('');
  lines.push(hr);
  lines.push('  End of optimizer report');
  lines.push(hr);

  return lines.join('\n');
}

function padRow(cols) {
  const widths = [4, 28, 8, 8, 12, 8];
  return '  ' + cols.map((c, i) => String(c).padEnd(widths[i] || 12)).join('');
}

// ---------------------------------------------------------------------------
main();
