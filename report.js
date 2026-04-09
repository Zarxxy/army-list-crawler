const fs = require('fs');
const path = require('path');
const { getArg, parseRecord, extractDetachment, flattenLists } = require('./utils');

// Minimal army list text parser — needed for crawl diff tech extraction.
// Mirrors the unit-extraction logic in optimizer.js without pulling the whole module.
const UNIT_RE = /^[•·\-\s]*(.+?)\s*[\[(]\s*(\d+)\s*pts?\s*[\])]/gim;
function extractUnitsFromText(text) {
  if (!text) return [];
  const names = new Set();
  UNIT_RE.lastIndex = 0;
  let m;
  while ((m = UNIT_RE.exec(text)) !== null) {
    const name = m[1].trim().replace(/^[x×]\d+\s+/i, '').replace(/\s*[-–:]\s*$/, '');
    if (name && name.length < 80) names.add(name);
  }
  // Enhancements
  const enhRe = /Enhancement[s]?:\s*(.+?)(?:\n|$)/gi;
  let e;
  while ((e = enhRe.exec(text)) !== null) {
    const enh = e[1].trim();
    if (enh && enh.toLowerCase() !== 'none') names.add(enh);
  }
  return [...names];
}

const args = process.argv.slice(2);
const inputFile    = getArg(args, '--input')    || path.join(__dirname, 'output', 'army-lists-latest.json');
const previousFile = getArg(args, '--previous') || path.join(__dirname, 'output', 'army-lists-previous.json');
const outputDir    = getArg(args, '--output')   || path.join(__dirname, 'reports');
const format       = getArg(args, '--format')   || 'all'; // "json", "text", "all"

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

  const raw = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  const lists = flattenLists(raw);

  if (lists.length === 0) {
    console.warn('No army lists found in the input file. Generating empty report.');
    emptyReport.meta.crawledAt = raw.crawledAt || 'unknown';
    writeReports(emptyReport);
    return;
  }

  console.log(`Loaded ${lists.length} army lists from ${inputFile}\n`);

  // Load previous crawl for diff computation (optional)
  let previousLists = [];
  if (fs.existsSync(previousFile)) {
    try {
      const prevRaw = JSON.parse(fs.readFileSync(previousFile, 'utf-8'));
      previousLists = flattenLists(prevRaw);
      console.log(`Loaded ${previousLists.length} previous lists for diff from ${previousFile}`);
    } catch { /* ignore */ }
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
  // Detect the faction (should be the same for all lists)
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
  const detUndefeated = {};

  const eventCounts = {};
  const eventDetachments = {};
  const eventSizes = {};   // player count per event (for "event size" sort)

  const recordCounts = {};

  // listsByDetachment accumulator
  const listsByDet = {};

  for (const list of lists) {
    const detachment = list.detachment || extractDetachment(list.armyListText) || extractDetachment(list.rawText) || 'Unknown';
    const event = (list.event && list.event.length < 200) ? list.event : 'Unknown Event';
    const record = parseRecord(list.record);

    // Detachment
    detCounts[detachment] = (detCounts[detachment] || 0) + 1;

    // Group lists by detachment (with full text for expandable cards)
    if (!listsByDet[detachment]) listsByDet[detachment] = [];
    listsByDet[detachment].push({
      playerName: list.playerName || list.player || 'Unknown',
      detachment,
      event,
      date: list.date || null,
      record: list.record || null,
      armyListText: list.armyListText || list.rawText || null,
      firstSeen: list.firstSeen || null,
      lastSeen: list.lastSeen || null,
    });

    // Event
    eventCounts[event] = (eventCounts[event] || 0) + 1;
    if (!eventDetachments[event]) eventDetachments[event] = {};
    eventDetachments[event][detachment] = (eventDetachments[event][detachment] || 0) + 1;

    if (record) {
      const recStr = `${record.wins}-${record.losses}${record.draws ? `-${record.draws}` : ''}`;
      recordCounts[recStr] = (recordCounts[recStr] || 0) + 1;

      if (record.losses === 0 && record.wins > 0) {
        detUndefeated[detachment] = (detUndefeated[detachment] || 0) + 1;
      }
    }
  }

  // ---- Detachment Breakdown (primary analysis — no win rate) ----
  report.detachmentBreakdown = Object.entries(detCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([detachment, count]) => ({
      detachment,
      count,
      percentage: pct(count, lists.length),
      undefeatedCount: detUndefeated[detachment] || 0,
    }));

  // ---- Lists by Detachment ----
  report.listsByDetachment = listsByDet;

  // ---- Event Breakdown (kept as metadata for list cards) ----
  report.eventBreakdown = Object.entries(eventCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([event, count]) => ({
      event,
      listCount: count,
      detachments: sortObj(eventDetachments[event]),
      topDetachment: topKey(eventDetachments[event]),
    }));

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
  if (previousLists && previousLists.length > 0) {
    report.crawlDiff = buildCrawlDiff(lists, previousLists);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Crawl diff — what's new vs the previous crawl
// ---------------------------------------------------------------------------

function buildCrawlDiff(currentLists, previousLists) {
  const prevKeys = new Set(
    previousLists.map((l) => [l.playerName || l.player, l.event, l.date].join('|'))
  );
  const currKeys = new Set(
    currentLists.map((l) => [l.playerName || l.player, l.event, l.date].join('|'))
  );

  const newLists = currentLists
    .filter((l) => !prevKeys.has([l.playerName || l.player, l.event, l.date].join('|')))
    .map((l) => ({
      playerName: l.playerName || l.player || 'Unknown',
      detachment: l.detachment || extractDetachment(l.armyListText) || 'Unknown',
      event: l.event || 'Unknown Event',
      date: l.date || null,
    }));

  const droppedLists = previousLists
    .filter((l) => !currKeys.has([l.playerName || l.player, l.event, l.date].join('|')))
    .map((l) => ({
      playerName: l.playerName || l.player || 'Unknown',
      detachment: l.detachment || extractDetachment(l.armyListText) || 'Unknown',
      event: l.event || 'Unknown Event',
    }));

  // New tech: unit/enhancement names appearing in current that weren't in any previous list
  const prevTech = new Set();
  for (const l of previousLists) {
    for (const name of extractUnitsFromText(l.armyListText || l.rawText)) {
      prevTech.add(name.toLowerCase());
    }
  }
  const newTechChoices = [];
  const seenNew = new Set();
  for (const l of currentLists) {
    for (const name of extractUnitsFromText(l.armyListText || l.rawText)) {
      if (!prevTech.has(name.toLowerCase()) && !seenNew.has(name.toLowerCase())) {
        seenNew.add(name.toLowerCase());
        newTechChoices.push(name);
      }
    }
  }

  return { newLists, droppedLists, newTechChoices };
}

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

  // Detachment Breakdown (no win rate)
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

  // Crawl diff
  if (report.crawlDiff) {
    const d = report.crawlDiff;
    lines.push(hr2);
    lines.push('  CRAWL DIFF');
    lines.push(hr2);
    lines.push(`  New lists: ${d.newLists.length}  |  Dropped: ${d.droppedLists.length}  |  New tech choices: ${d.newTechChoices.length}`);
    if (d.newLists.length > 0) {
      lines.push('  New:');
      for (const l of d.newLists.slice(0, 10)) lines.push(`    + ${l.playerName} (${l.detachment}) — ${l.event}`);
    }
    if (d.newTechChoices.length > 0) {
      lines.push(`  New tech: ${d.newTechChoices.slice(0, 10).join(', ')}`);
    }
    lines.push('');
  }

  // Event Breakdown summary
  if (report.eventBreakdown.length > 0) {
    lines.push(hr2);
    lines.push('  EVENTS');
    lines.push(hr2);
    for (const e of report.eventBreakdown) {
      lines.push(`  ${e.event} (${e.listCount} lists, top detachment: ${e.topDetachment})`);
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
main();
