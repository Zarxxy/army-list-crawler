const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const inputFile = getArg(args, '--input') || path.join(__dirname, 'output', 'army-lists-latest.json');
const outputDir = getArg(args, '--output') || path.join(__dirname, 'reports');
const format = getArg(args, '--format') || 'all'; // "json", "html", "text", "all"
const topN = parseInt(getArg(args, '--top') || '20', 10);

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(inputFile)) {
    console.warn(`Input file not found: ${inputFile}. Crawler may not have found any data.`);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const emptyReport = {
      meta: { generatedAt: new Date().toISOString(), crawledAt: 'unknown', totalLists: 0 },
      factionBreakdown: [], eventBreakdown: [], recordDistribution: [],
      detachmentBreakdown: [], topPlayers: [], undefeatedLists: [],
      factionWinRates: {}, factionMatchups: {}, pointsAnalysis: {},
      sectionBreakdown: [],
    };
    if (format === 'json' || format === 'all') {
      fs.writeFileSync(path.join(outputDir, 'meta-report-latest.json'), JSON.stringify(emptyReport, null, 2), 'utf-8');
    }
    if (format === 'text' || format === 'all') {
      fs.writeFileSync(path.join(outputDir, 'meta-report-latest.txt'), 'No army lists found.\n', 'utf-8');
    }
    if (format === 'html' || format === 'all') {
      fs.writeFileSync(path.join(outputDir, 'meta-report-latest.html'), '<html><body><h1>No army lists found</h1></body></html>', 'utf-8');
    }
    console.log('Generated empty report files.');
    return;
  }

  const raw = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  const lists = flattenLists(raw);

  if (lists.length === 0) {
    console.warn('No army lists found in the input file. Generating empty report.');
    const emptyReport = {
      meta: { generatedAt: new Date().toISOString(), crawledAt: raw.crawledAt || 'unknown', totalLists: 0 },
      factionBreakdown: [], eventBreakdown: [], recordDistribution: [],
      detachmentBreakdown: [], topPlayers: [], undefeatedLists: [],
      factionWinRates: {}, factionMatchups: {}, pointsAnalysis: {},
      sectionBreakdown: [],
    };

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    if (format === 'json' || format === 'all') {
      const jsonPath = path.join(outputDir, 'meta-report-latest.json');
      fs.writeFileSync(jsonPath, JSON.stringify(emptyReport, null, 2), 'utf-8');
      console.log(`Empty JSON report saved to ${jsonPath}`);
    }
    if (format === 'text' || format === 'all') {
      const textPath = path.join(outputDir, 'meta-report-latest.txt');
      fs.writeFileSync(textPath, 'No army lists found.\n', 'utf-8');
      console.log(`Empty text report saved to ${textPath}`);
    }
    if (format === 'html' || format === 'all') {
      const htmlPath = path.join(outputDir, 'meta-report-latest.html');
      fs.writeFileSync(htmlPath, '<html><body><h1>No army lists found</h1></body></html>', 'utf-8');
      console.log(`Empty HTML report saved to ${htmlPath}`);
    }
    return;
  }

  console.log(`Loaded ${lists.length} army lists from ${inputFile}\n`);

  const report = buildReport(lists, raw.crawledAt);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Console output (always)
  const textReport = renderText(report);
  console.log(textReport);

  if (format === 'text' || format === 'all') {
    const textPath = path.join(outputDir, `meta-report-${timestamp}.txt`);
    fs.writeFileSync(textPath, textReport, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'meta-report-latest.txt'), textReport, 'utf-8');
    console.log(`\nText report saved to ${textPath}`);
  }

  if (format === 'json' || format === 'all') {
    const jsonPath = path.join(outputDir, `meta-report-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'meta-report-latest.json'), JSON.stringify(report, null, 2), 'utf-8');
    console.log(`JSON report saved to ${jsonPath}`);
  }

  if (format === 'html' || format === 'all') {
    const html = renderHTML(report);
    const htmlPath = path.join(outputDir, `meta-report-${timestamp}.html`);
    fs.writeFileSync(htmlPath, html, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'meta-report-latest.html'), html, 'utf-8');
    console.log(`HTML report saved to ${htmlPath}`);
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

function pct(n, total) {
  if (total === 0) return '0.0';
  return ((n / total) * 100).toFixed(1);
}

// ---------------------------------------------------------------------------
// Build report object
// ---------------------------------------------------------------------------

function buildReport(lists, crawledAt) {
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      crawledAt: crawledAt || 'unknown',
      totalLists: lists.length,
    },
    factionBreakdown: {},
    eventBreakdown: {},
    recordDistribution: {},
    detachmentBreakdown: {},
    topPlayers: [],
    undefeatedLists: [],
    factionWinRates: {},
    factionMatchups: {},
    pointsAnalysis: {},
    sectionBreakdown: {},
  };

  // ---- Faction Breakdown ----
  const factionCounts = {};
  const factionWins = {};
  const factionLosses = {};
  const factionDraws = {};
  const factionGames = {};
  const factionUndefeated = {};

  // ---- Event Breakdown ----
  const eventCounts = {};
  const eventFactions = {};

  // ---- Detachment Breakdown ----
  const detachmentCounts = {};
  const detachmentFactions = {};

  // ---- Player stats ----
  const playerStats = {};

  // ---- Section breakdown ----
  const sectionCounts = {};

  // ---- Record distribution ----
  const recordCounts = {};

  for (const list of lists) {
    const faction = normaliseFaction(list.faction);
    const event = list.event || 'Unknown Event';
    const detachment = list.detachment || extractDetachment(list.armyListText) || 'Unknown';
    const player = list.playerName || list.player || 'Unknown';
    const section = list.section || 'Unknown';
    const record = parseRecord(list.record);

    // Faction counts
    factionCounts[faction] = (factionCounts[faction] || 0) + 1;

    // Section
    sectionCounts[section] = (sectionCounts[section] || 0) + 1;

    // Event
    eventCounts[event] = (eventCounts[event] || 0) + 1;
    if (!eventFactions[event]) eventFactions[event] = {};
    eventFactions[event][faction] = (eventFactions[event][faction] || 0) + 1;

    // Detachment
    detachmentCounts[detachment] = (detachmentCounts[detachment] || 0) + 1;
    if (!detachmentFactions[detachment]) detachmentFactions[detachment] = {};
    detachmentFactions[detachment][faction] = (detachmentFactions[detachment][faction] || 0) + 1;

    // Record
    if (record) {
      const recStr = `${record.wins}-${record.losses}${record.draws ? `-${record.draws}` : ''}`;
      recordCounts[recStr] = (recordCounts[recStr] || 0) + 1;

      factionWins[faction] = (factionWins[faction] || 0) + record.wins;
      factionLosses[faction] = (factionLosses[faction] || 0) + record.losses;
      factionDraws[faction] = (factionDraws[faction] || 0) + record.draws;
      factionGames[faction] = (factionGames[faction] || 0) + record.wins + record.losses + record.draws;

      if (record.losses === 0 && record.wins > 0) {
        factionUndefeated[faction] = (factionUndefeated[faction] || 0) + 1;
        report.undefeatedLists.push({
          player,
          faction,
          event,
          record: recStr,
          detachment,
        });
      }

      // Player stats
      if (!playerStats[player]) {
        playerStats[player] = { player, wins: 0, losses: 0, draws: 0, games: 0, factions: new Set(), events: new Set(), lists: 0 };
      }
      playerStats[player].wins += record.wins;
      playerStats[player].losses += record.losses;
      playerStats[player].draws += record.draws;
      playerStats[player].games += record.wins + record.losses + record.draws;
      playerStats[player].factions.add(faction);
      playerStats[player].events.add(event);
      playerStats[player].lists += 1;
    }
  }

  // ---- Assemble faction breakdown (sorted by count desc) ----
  report.factionBreakdown = Object.entries(factionCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([faction, count]) => ({
      faction,
      count,
      percentage: pct(count, lists.length),
      wins: factionWins[faction] || 0,
      losses: factionLosses[faction] || 0,
      draws: factionDraws[faction] || 0,
      totalGames: factionGames[faction] || 0,
      winRate: factionGames[faction] ? pct(factionWins[faction] || 0, factionGames[faction]) : 'N/A',
      undefeatedCount: factionUndefeated[faction] || 0,
    }));

  // ---- Faction win rates (sorted by win rate desc) ----
  report.factionWinRates = Object.entries(factionCounts)
    .filter(([f]) => factionGames[f] > 0)
    .map(([faction]) => ({
      faction,
      listCount: factionCounts[faction],
      wins: factionWins[faction] || 0,
      losses: factionLosses[faction] || 0,
      draws: factionDraws[faction] || 0,
      totalGames: factionGames[faction],
      winRate: parseFloat(pct(factionWins[faction] || 0, factionGames[faction])),
      undefeatedCount: factionUndefeated[faction] || 0,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  // ---- Event breakdown (sorted by count desc) ----
  report.eventBreakdown = Object.entries(eventCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([event, count]) => ({
      event,
      listCount: count,
      factions: sortObj(eventFactions[event]),
      topFaction: topKey(eventFactions[event]),
    }));

  // ---- Detachment breakdown (sorted by count desc) ----
  report.detachmentBreakdown = Object.entries(detachmentCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([detachment, count]) => ({
      detachment,
      count,
      percentage: pct(count, lists.length),
      factions: sortObj(detachmentFactions[detachment]),
    }));

  // ---- Record distribution (sorted by wins desc) ----
  report.recordDistribution = Object.entries(recordCounts)
    .sort((a, b) => {
      const ra = parseRecord(a[0]);
      const rb = parseRecord(b[0]);
      if (!ra || !rb) return 0;
      return rb.wins - ra.wins || ra.losses - rb.losses;
    })
    .map(([record, count]) => ({ record, count, percentage: pct(count, lists.length) }));

  // ---- Top players (sorted by win rate then total wins) ----
  report.topPlayers = Object.values(playerStats)
    .filter((p) => p.player !== 'Unknown' && p.games > 0)
    .map((p) => ({
      player: p.player,
      wins: p.wins,
      losses: p.losses,
      draws: p.draws,
      games: p.games,
      winRate: parseFloat(pct(p.wins, p.games)),
      lists: p.lists,
      factions: [...p.factions],
      events: [...p.events],
    }))
    .sort((a, b) => b.winRate - a.winRate || b.wins - a.wins)
    .slice(0, topN);

  // ---- Section breakdown ----
  report.sectionBreakdown = Object.entries(sectionCounts).map(([section, count]) => ({
    section,
    count,
  }));

  // ---- Points analysis (if we can extract points from list text) ----
  const pointValues = lists
    .map((l) => extractPoints(l.armyListText || l.points))
    .filter((p) => p !== null);
  if (pointValues.length > 0) {
    pointValues.sort((a, b) => a - b);
    report.pointsAnalysis = {
      sampleSize: pointValues.length,
      min: pointValues[0],
      max: pointValues[pointValues.length - 1],
      median: pointValues[Math.floor(pointValues.length / 2)],
      mean: Math.round(pointValues.reduce((s, v) => s + v, 0) / pointValues.length),
      distribution: buildHistogram(pointValues, 100),
    };
  }

  return report;
}

function extractDetachment(text) {
  if (!text) return null;
  const m = text.match(/Detachment:\s*(.+?)(?:\n|$)/i) ||
            text.match(/Detachment\s*[-–:]\s*(.+?)(?:\n|$)/i);
  return m ? m[1].trim() : null;
}

function extractPoints(text) {
  if (!text) return null;
  // Try patterns like "[2000pts]", "2000 points", "2000pts"
  const m = text.match(/\[?\s*(\d{3,5})\s*(?:pts|points)\s*\]?/i);
  return m ? parseInt(m[1], 10) : null;
}

function sortObj(obj) {
  if (!obj) return [];
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function topKey(obj) {
  if (!obj) return 'N/A';
  let max = 0;
  let top = 'N/A';
  for (const [k, v] of Object.entries(obj)) {
    if (v > max) { max = v; top = k; }
  }
  return top;
}

function buildHistogram(values, bucketSize) {
  const hist = {};
  for (const v of values) {
    const bucket = Math.floor(v / bucketSize) * bucketSize;
    const label = `${bucket}-${bucket + bucketSize - 1}`;
    hist[label] = (hist[label] || 0) + 1;
  }
  return Object.entries(hist).map(([range, count]) => ({ range, count }));
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

function renderText(report) {
  const lines = [];
  const hr = '='.repeat(70);
  const hr2 = '-'.repeat(70);

  lines.push(hr);
  lines.push('  LISTHAMMER META REPORT');
  lines.push(hr);
  lines.push(`  Generated: ${report.meta.generatedAt}`);
  lines.push(`  Data from: ${report.meta.crawledAt}`);
  lines.push(`  Total lists analysed: ${report.meta.totalLists}`);
  lines.push('');

  // Faction Breakdown
  lines.push(hr2);
  lines.push('  FACTION REPRESENTATION');
  lines.push(hr2);
  lines.push(padRow(['Faction', 'Count', '%', 'Win Rate', 'Undefeated']));
  lines.push(padRow(['-------', '-----', '-', '--------', '----------']));
  for (const f of report.factionBreakdown) {
    lines.push(padRow([f.faction, f.count, `${f.percentage}%`, `${f.winRate}%`, f.undefeatedCount]));
  }
  lines.push('');

  // Win Rates
  lines.push(hr2);
  lines.push('  FACTION WIN RATES (sorted by win rate)');
  lines.push(hr2);
  lines.push(padRow(['Faction', 'W', 'L', 'D', 'Games', 'Win%']));
  lines.push(padRow(['-------', '-', '-', '-', '-----', '----']));
  for (const f of report.factionWinRates) {
    lines.push(padRow([f.faction, f.wins, f.losses, f.draws, f.totalGames, `${f.winRate}%`]));
  }
  lines.push('');

  // Undefeated Lists
  if (report.undefeatedLists.length > 0) {
    lines.push(hr2);
    lines.push(`  UNDEFEATED LISTS (${report.undefeatedLists.length})`);
    lines.push(hr2);
    lines.push(padRow(['Player', 'Faction', 'Record', 'Event']));
    lines.push(padRow(['------', '-------', '------', '-----']));
    for (const u of report.undefeatedLists) {
      lines.push(padRow([u.player, u.faction, u.record, u.event]));
    }
    lines.push('');
  }

  // Record Distribution
  if (report.recordDistribution.length > 0) {
    lines.push(hr2);
    lines.push('  RECORD DISTRIBUTION');
    lines.push(hr2);
    for (const r of report.recordDistribution) {
      const bar = '#'.repeat(Math.max(1, Math.round(parseFloat(r.percentage))));
      lines.push(`  ${r.record.padEnd(10)} ${String(r.count).padStart(4)}  (${r.percentage.padStart(5)}%)  ${bar}`);
    }
    lines.push('');
  }

  // Top Players
  if (report.topPlayers.length > 0) {
    lines.push(hr2);
    lines.push(`  TOP PLAYERS (by win rate, top ${report.topPlayers.length})`);
    lines.push(hr2);
    lines.push(padRow(['Player', 'W-L-D', 'Win%', 'Factions']));
    lines.push(padRow(['------', '-----', '----', '--------']));
    for (const p of report.topPlayers) {
      const rec = `${p.wins}-${p.losses}-${p.draws}`;
      lines.push(padRow([p.player, rec, `${p.winRate}%`, p.factions.join(', ')]));
    }
    lines.push('');
  }

  // Detachment Breakdown
  const realDetachments = report.detachmentBreakdown.filter((d) => d.detachment !== 'Unknown');
  if (realDetachments.length > 0) {
    lines.push(hr2);
    lines.push('  DETACHMENT POPULARITY');
    lines.push(hr2);
    lines.push(padRow(['Detachment', 'Count', '%']));
    lines.push(padRow(['----------', '-----', '-']));
    for (const d of realDetachments) {
      lines.push(padRow([d.detachment, d.count, `${d.percentage}%`]));
    }
    lines.push('');
  }

  // Event Breakdown
  if (report.eventBreakdown.length > 0) {
    lines.push(hr2);
    lines.push('  EVENT BREAKDOWN');
    lines.push(hr2);
    for (const e of report.eventBreakdown) {
      lines.push(`  ${e.event} (${e.listCount} lists, top faction: ${e.topFaction})`);
      const topFactions = e.factions.slice(0, 5);
      for (const f of topFactions) {
        lines.push(`    - ${f.name}: ${f.count}`);
      }
    }
    lines.push('');
  }

  // Points Analysis
  if (report.pointsAnalysis.sampleSize) {
    lines.push(hr2);
    lines.push('  POINTS ANALYSIS');
    lines.push(hr2);
    const pa = report.pointsAnalysis;
    lines.push(`  Sample size: ${pa.sampleSize}`);
    lines.push(`  Min: ${pa.min}  Max: ${pa.max}  Median: ${pa.median}  Mean: ${pa.mean}`);
    if (pa.distribution.length > 0) {
      lines.push('  Distribution:');
      for (const b of pa.distribution) {
        lines.push(`    ${b.range.padEnd(12)} ${String(b.count).padStart(4)}`);
      }
    }
    lines.push('');
  }

  lines.push(hr);
  lines.push('  End of report');
  lines.push(hr);

  return lines.join('\n');
}

function padRow(cols) {
  const widths = [28, 8, 8, 8, 8, 20];
  return '  ' + cols.map((c, i) => String(c).padEnd(widths[i] || 20)).join('');
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

function renderHTML(report) {
  const factionRows = report.factionBreakdown
    .map(
      (f) =>
        `<tr><td>${esc(f.faction)}</td><td>${f.count}</td><td>${f.percentage}%</td><td>${f.winRate}%</td><td>${f.undefeatedCount}</td></tr>`
    )
    .join('\n');

  const winRateRows = report.factionWinRates
    .map(
      (f) =>
        `<tr><td>${esc(f.faction)}</td><td>${f.wins}</td><td>${f.losses}</td><td>${f.draws}</td><td>${f.totalGames}</td><td>${f.winRate}%</td></tr>`
    )
    .join('\n');

  const undefeatedRows = report.undefeatedLists
    .map(
      (u) =>
        `<tr><td>${esc(u.player)}</td><td>${esc(u.faction)}</td><td>${u.record}</td><td>${esc(u.event)}</td></tr>`
    )
    .join('\n');

  const playerRows = report.topPlayers
    .map(
      (p) =>
        `<tr><td>${esc(p.player)}</td><td>${p.wins}-${p.losses}-${p.draws}</td><td>${p.winRate}%</td><td>${esc(p.factions.join(', '))}</td></tr>`
    )
    .join('\n');

  const recordRows = report.recordDistribution
    .map((r) => `<tr><td>${r.record}</td><td>${r.count}</td><td>${r.percentage}%</td></tr>`)
    .join('\n');

  const detachmentRows = report.detachmentBreakdown
    .filter((d) => d.detachment !== 'Unknown')
    .map((d) => `<tr><td>${esc(d.detachment)}</td><td>${d.count}</td><td>${d.percentage}%</td></tr>`)
    .join('\n');

  const eventBlocks = report.eventBreakdown
    .map((e) => {
      const factionList = e.factions
        .slice(0, 5)
        .map((f) => `<li>${esc(f.name)}: ${f.count}</li>`)
        .join('');
      return `<div class="event-card"><h4>${esc(e.event)} <small>(${e.listCount} lists)</small></h4><p>Top faction: <strong>${esc(e.topFaction)}</strong></p><ul>${factionList}</ul></div>`;
    })
    .join('\n');

  // Faction chart data for simple CSS bar chart
  const maxCount = report.factionBreakdown.length > 0 ? report.factionBreakdown[0].count : 1;
  const factionBars = report.factionBreakdown
    .map((f) => {
      const width = Math.max(2, Math.round((f.count / maxCount) * 100));
      return `<div class="bar-row"><span class="bar-label">${esc(f.faction)}</span><div class="bar" style="width:${width}%">${f.count}</div></div>`;
    })
    .join('\n');

  const maxWR = 100;
  const winRateBars = report.factionWinRates
    .map((f) => {
      const width = Math.max(2, Math.round(f.winRate));
      const color = f.winRate >= 55 ? '#2ecc71' : f.winRate >= 45 ? '#f39c12' : '#e74c3c';
      return `<div class="bar-row"><span class="bar-label">${esc(f.faction)}</span><div class="bar" style="width:${width}%;background:${color}">${f.winRate}%</div></div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Listhammer Meta Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; line-height: 1.6; }
  h1 { color: #58a6ff; margin-bottom: 0.5rem; font-size: 2rem; }
  h2 { color: #58a6ff; margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #21262d; }
  h3 { color: #8b949e; margin: 1.5rem 0 0.5rem; }
  h4 { color: #c9d1d9; }
  .meta { color: #8b949e; margin-bottom: 2rem; }
  .meta span { margin-right: 2rem; }
  .summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
  .summary-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 1.2rem; text-align: center; }
  .summary-card .number { font-size: 2.5rem; font-weight: bold; color: #58a6ff; }
  .summary-card .label { color: #8b949e; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; background: #161b22; border-radius: 8px; overflow: hidden; }
  th, td { padding: 0.6rem 1rem; text-align: left; border-bottom: 1px solid #21262d; }
  th { background: #1c2128; color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 0.8rem; letter-spacing: 0.05em; }
  tr:hover { background: #1c2128; }
  .bar-chart { margin: 1rem 0; }
  .bar-row { display: flex; align-items: center; margin: 0.3rem 0; }
  .bar-label { width: 200px; min-width: 200px; text-align: right; padding-right: 1rem; font-size: 0.85rem; color: #8b949e; }
  .bar { background: #58a6ff; color: #fff; padding: 0.25rem 0.6rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; min-width: 30px; }
  .event-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 1rem; margin: 0.5rem 0; }
  .event-card ul { margin-left: 1.5rem; margin-top: 0.5rem; }
  .event-card li { color: #8b949e; }
  small { color: #8b949e; font-weight: normal; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
  @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } .bar-label { width: 120px; min-width: 120px; } }
</style>
</head>
<body>
<h1>Listhammer Meta Report</h1>
<div class="meta">
  <span>Generated: ${esc(report.meta.generatedAt)}</span>
  <span>Data: ${esc(report.meta.crawledAt)}</span>
</div>

<div class="summary-cards">
  <div class="summary-card"><div class="number">${report.meta.totalLists}</div><div class="label">Total Lists</div></div>
  <div class="summary-card"><div class="number">${report.factionBreakdown.length}</div><div class="label">Factions</div></div>
  <div class="summary-card"><div class="number">${report.undefeatedLists.length}</div><div class="label">Undefeated</div></div>
  <div class="summary-card"><div class="number">${report.eventBreakdown.length}</div><div class="label">Events</div></div>
</div>

<h2>Faction Representation</h2>
<div class="bar-chart">${factionBars}</div>
<table>
<thead><tr><th>Faction</th><th>Count</th><th>%</th><th>Win Rate</th><th>Undefeated</th></tr></thead>
<tbody>${factionRows}</tbody>
</table>

<h2>Faction Win Rates</h2>
<div class="bar-chart">${winRateBars}</div>
<table>
<thead><tr><th>Faction</th><th>W</th><th>L</th><th>D</th><th>Games</th><th>Win%</th></tr></thead>
<tbody>${winRateRows}</tbody>
</table>

${report.undefeatedLists.length > 0 ? `
<h2>Undefeated Lists (${report.undefeatedLists.length})</h2>
<table>
<thead><tr><th>Player</th><th>Faction</th><th>Record</th><th>Event</th></tr></thead>
<tbody>${undefeatedRows}</tbody>
</table>
` : ''}

<h2>Record Distribution</h2>
<table>
<thead><tr><th>Record</th><th>Count</th><th>%</th></tr></thead>
<tbody>${recordRows}</tbody>
</table>

<div class="grid-2">
<div>
<h2>Top Players</h2>
<table>
<thead><tr><th>Player</th><th>Record</th><th>Win%</th><th>Factions</th></tr></thead>
<tbody>${playerRows}</tbody>
</table>
</div>
<div>
${detachmentRows ? `
<h2>Detachment Popularity</h2>
<table>
<thead><tr><th>Detachment</th><th>Count</th><th>%</th></tr></thead>
<tbody>${detachmentRows}</tbody>
</table>
` : ''}
</div>
</div>

<h2>Events</h2>
${eventBlocks}

${report.pointsAnalysis.sampleSize ? `
<h2>Points Analysis</h2>
<p>Sample: ${report.pointsAnalysis.sampleSize} lists &mdash; Min: ${report.pointsAnalysis.min} / Max: ${report.pointsAnalysis.max} / Median: ${report.pointsAnalysis.median} / Mean: ${report.pointsAnalysis.mean}</p>
` : ''}

<p style="margin-top:3rem;color:#484f58;text-align:center">Generated from listhammer.info data</p>
</body>
</html>`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
main();
