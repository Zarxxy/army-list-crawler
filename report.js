const fs = require('fs');
const path = require('path');
const { getArg, parseRecord, extractDetachment, flattenLists } = require('./utils');

const args = process.argv.slice(2);
const inputFile = getArg(args, '--input') || path.join(__dirname, 'output', 'army-lists-latest.json');
const previousFile = getArg(args, '--previous') || path.join(__dirname, 'output', 'army-lists-previous.json');
const outputDir = getArg(args, '--output') || path.join(__dirname, 'reports');
const format = getArg(args, '--format') || 'all'; // "json", "text", "all"

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const emptyReport = {
    meta: { generatedAt: new Date().toISOString(), crawledAt: 'unknown', totalLists: 0, faction: null },
    detachmentBreakdown: [], eventBreakdown: [], recordDistribution: [],
    pointsAnalysis: {}, crawlDiff: null, listsByDetachment: {},
  };

  if (!fs.existsSync(inputFile)) {
    console.error(`ERROR: Input file not found: ${inputFile}`);
    console.error('Run "npm run crawl:dg" first to generate the army lists data.');
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  } catch (err) {
    console.error(`ERROR: Failed to parse input file "${inputFile}": ${err.message}`);
    process.exit(1);
  }
  const lists = flattenLists(raw);

  if (lists.length === 0) {
    console.warn('No army lists found in the input file. Generating empty report.');
    emptyReport.meta.crawledAt = raw.crawledAt || 'unknown';
    writeReports(emptyReport);
    return;
  }

  console.log(`Loaded ${lists.length} army lists from ${inputFile}\n`);

  let previousLists = null;
  if (fs.existsSync(previousFile)) {
    try {
      const prevRaw = JSON.parse(fs.readFileSync(previousFile, 'utf-8'));
      previousLists = flattenLists(prevRaw);
      console.log(`Loaded ${previousLists.length} previous army lists from ${previousFile}`);
    } catch (err) {
      console.warn(`Could not load previous file: ${err.message}`);
    }
  }

  const report = buildReport(lists, raw.crawledAt, previousLists);
  const textReport = renderText(report);
  console.log(textReport);

  writeReports(report, textReport);
}

function writeReports(report, textReport) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'json' || format === 'all') {
    const jsonPath = path.join(outputDir, `meta-report-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'meta-report-latest.json'), JSON.stringify(report, null, 2), 'utf-8');
    console.log(`JSON report saved to ${jsonPath}`);
  }
  if (format === 'text' || format === 'all') {
    const text = textReport || 'No army lists found.\n';
    const textPath = path.join(outputDir, `meta-report-${timestamp}.txt`);
    fs.writeFileSync(textPath, text, 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'meta-report-latest.txt'), text, 'utf-8');
    console.log(`Text report saved to ${textPath}`);
  }
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function pct(n, total) {
  if (total === 0) return '0.0';
  return ((n / total) * 100).toFixed(1);
}

// ---------------------------------------------------------------------------
// Build report — single-faction focused
// ---------------------------------------------------------------------------

function buildReport(lists, crawledAt, previousLists) {
  const factionName = detectFaction(lists);

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      crawledAt: crawledAt || 'unknown',
      totalLists: lists.length,
      faction: factionName,
    },
    detachmentBreakdown: [],
    eventBreakdown: [],
    recordDistribution: [],
    pointsAnalysis: {},
    crawlDiff: null,
    listsByDetachment: {},
  };

  // ---- Accumulators ----
  const detCounts = {};
  const detWins = {};
  const detLosses = {};
  const detDraws = {};
  const detGames = {};
  const detUndefeated = {};

  const eventCounts = {};
  const eventDetachments = {};
  const eventRecords = {};

  const recordCounts = {};

  for (const list of lists) {
    const detachment = list.detachment || extractDetachment(list.armyListText) || extractDetachment(list.rawText) || 'Unknown';
    const event = (list.event && list.event.length < 200) ? list.event : 'Unknown Event';
    const record = parseRecord(list.record);

    // Detachment
    detCounts[detachment] = (detCounts[detachment] || 0) + 1;

    // Event
    eventCounts[event] = (eventCounts[event] || 0) + 1;
    if (!eventDetachments[event]) eventDetachments[event] = {};
    eventDetachments[event][detachment] = (eventDetachments[event][detachment] || 0) + 1;

    if (record) {
      const recStr = `${record.wins}-${record.losses}${record.draws ? `-${record.draws}` : ''}`;
      recordCounts[recStr] = (recordCounts[recStr] || 0) + 1;

      detWins[detachment] = (detWins[detachment] || 0) + record.wins;
      detLosses[detachment] = (detLosses[detachment] || 0) + record.losses;
      detDraws[detachment] = (detDraws[detachment] || 0) + record.draws;
      detGames[detachment] = (detGames[detachment] || 0) + record.wins + record.losses + record.draws;

      // Event record tracking
      if (!eventRecords[event]) eventRecords[event] = { wins: 0, losses: 0, draws: 0 };
      eventRecords[event].wins += record.wins;
      eventRecords[event].losses += record.losses;
      eventRecords[event].draws += record.draws;

      if (record.losses === 0 && record.wins > 0) {
        detUndefeated[detachment] = (detUndefeated[detachment] || 0) + 1;
      }
    }
  }

  // ---- Detachment Breakdown (primary analysis) ----
  report.detachmentBreakdown = Object.entries(detCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([detachment, count]) => ({
      detachment,
      count,
      percentage: pct(count, lists.length),
      wins: detWins[detachment] || 0,
      losses: detLosses[detachment] || 0,
      draws: detDraws[detachment] || 0,
      totalGames: detGames[detachment] || 0,
      undefeatedCount: detUndefeated[detachment] || 0,
    }));

  // ---- Event Breakdown ----
  report.eventBreakdown = Object.entries(eventCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([event, count]) => {
      const rec = eventRecords[event];
      return {
        event,
        listCount: count,
        detachments: sortObj(eventDetachments[event]),
        topDetachment: topKey(eventDetachments[event]),
        wins: rec ? rec.wins : 0,
        losses: rec ? rec.losses : 0,
      };
    });

  // ---- Record Distribution ----
  report.recordDistribution = Object.entries(recordCounts)
    .sort((a, b) => {
      const ra = parseRecord(a[0]);
      const rb = parseRecord(b[0]);
      if (!ra || !rb) return 0;
      return rb.wins - ra.wins || ra.losses - rb.losses;
    })
    .map(([record, count]) => ({ record, count, percentage: pct(count, lists.length) }));

  // ---- Points Analysis ----
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

  // ---- Crawl Diff ----
  report.crawlDiff = buildCrawlDiff(lists, previousLists);

  // ---- Lists by Detachment ----
  report.listsByDetachment = buildListsByDetachment(lists);

  return report;
}

// ---------------------------------------------------------------------------
// Crawl diff — what changed since last crawl
// ---------------------------------------------------------------------------

function buildCrawlDiff(currentLists, previousLists) {
  if (!previousLists || previousLists.length === 0) return null;

  function listKey(l) {
    return `${l.playerName || l.player || ''}|${l.event || ''}|${l.date || ''}`;
  }

  const prevKeys = new Set(previousLists.map(listKey));
  const currKeys = new Set(currentLists.map(listKey));

  const newLists = currentLists
    .filter((l) => !prevKeys.has(listKey(l)))
    .map((l) => ({ player: l.playerName || l.player, event: l.event, date: l.date, detachment: l.detachment }));

  const droppedLists = previousLists
    .filter((l) => !currKeys.has(listKey(l)))
    .map((l) => ({ player: l.playerName || l.player, event: l.event, date: l.date, detachment: l.detachment }));

  // newTechChoices: unit/enhancement names in current not seen in any previous list
  const prevTech = new Set();
  for (const l of previousLists) {
    for (const n of extractTechNames(l.armyListText)) prevTech.add(n);
  }

  const newTechChoices = [];
  const seenNew = new Set();
  for (const l of currentLists) {
    for (const n of extractTechNames(l.armyListText)) {
      if (!prevTech.has(n) && !seenNew.has(n)) {
        seenNew.add(n);
        newTechChoices.push(n);
      }
    }
  }

  return { newLists, droppedLists, newTechChoices };
}

// Lightweight unit/enhancement name extractor for diff purposes
function extractTechNames(armyListText) {
  if (!armyListText) return [];
  const names = [];

  // Enhancements
  const enhRegex = /Enhancement[s]?:\s*(.+?)(?:\n|$)/gi;
  let m;
  while ((m = enhRegex.exec(armyListText)) !== null) {
    const enh = m[1].trim();
    if (enh && enh.toLowerCase() !== 'none') names.push(enh);
  }

  // Units with points
  const unitRegex = /^[•·\-\s]*(.+?)\s*[\[(]\s*(\d+)\s*pts?\s*[\])]/gim;
  unitRegex.lastIndex = 0;
  while ((m = unitRegex.exec(armyListText)) !== null) {
    const name = m[1].trim().replace(/^[x×]\d+\s+/i, '').replace(/\s*[-–:]\s*$/, '');
    if (name && name.length < 80) names.push(name);
  }

  return names;
}

// ---------------------------------------------------------------------------
// Lists by detachment
// ---------------------------------------------------------------------------

function buildListsByDetachment(lists) {
  const result = {};
  for (const list of lists) {
    const det = list.detachment || extractDetachment(list.armyListText) || extractDetachment(list.rawText) || 'Unknown';
    if (!result[det]) result[det] = [];
    result[det].push(list);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectFaction(lists) {
  const counts = {};
  for (const l of lists) {
    const f = (l.faction || '').trim();
    if (f) counts[f] = (counts[f] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : 'Unknown';
}

function extractPoints(text) {
  if (!text) return null;
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
  lines.push(`  ${report.meta.faction || 'ARMY'} — META REPORT`);
  lines.push(hr);
  lines.push(`  Generated: ${report.meta.generatedAt}`);
  lines.push(`  Data from: ${report.meta.crawledAt}`);
  lines.push(`  Total lists analysed: ${report.meta.totalLists}`);
  lines.push('');

  // Detachment Breakdown
  lines.push(hr2);
  lines.push('  DETACHMENT BREAKDOWN');
  lines.push(hr2);
  lines.push(padRow(['Detachment', 'Count', '%', 'Undefeated']));
  lines.push(padRow(['----------', '-----', '-', '----------']));
  for (const d of report.detachmentBreakdown) {
    lines.push(padRow([d.detachment, d.count, `${d.percentage}%`, d.undefeatedCount]));
  }
  lines.push('');

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

  // Event Breakdown
  if (report.eventBreakdown.length > 0) {
    lines.push(hr2);
    lines.push('  EVENT BREAKDOWN');
    lines.push(hr2);
    for (const e of report.eventBreakdown) {
      lines.push(`  ${e.event} (${e.listCount} lists, top detachment: ${e.topDetachment})`);
      for (const d of e.detachments.slice(0, 5)) {
        lines.push(`    - ${d.name}: ${d.count}`);
      }
    }
    lines.push('');
  }

  // Crawl Diff
  if (report.crawlDiff) {
    lines.push(hr2);
    lines.push('  CRAWL DIFF');
    lines.push(hr2);
    lines.push(`  New lists: ${report.crawlDiff.newLists.length}`);
    lines.push(`  Dropped lists: ${report.crawlDiff.droppedLists.length}`);
    lines.push(`  New tech choices: ${report.crawlDiff.newTechChoices.slice(0, 10).join(', ') || 'none'}`);
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
if (require.main === module) {
  main();
} else {
  module.exports = { buildReport, buildCrawlDiff, buildListsByDetachment, extractTechNames };
}
