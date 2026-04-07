/**
 * ai-analysis.js
 *
 * Generates an AI-powered Death Guard meta analysis using Google Gemini Flash
 * (free tier — no credit card required). Uses the native fetch() API so no
 * extra npm package is needed.
 *
 * Free tier limits (google ai studio):
 *   gemini-2.0-flash  — 1,500 requests/day, 1M tokens/min
 *
 * Get a free API key at: https://aistudio.google.com/app/apikey
 *
 * The script exits with code 0 even if the API key is missing so the
 * GitHub Actions pipeline is never blocked by this step.
 *
 * Usage:
 *   node ai-analysis.js
 *   GEMINI_API_KEY=AIza... node ai-analysis.js
 *   node ai-analysis.js --lists ./output/army-lists-latest.json
 *   node ai-analysis.js --report ./reports/meta-report-latest.json
 *   node ai-analysis.js --optimizer ./reports/optimizer-latest.json
 *   node ai-analysis.js --output ./reports
 *   node ai-analysis.js --model gemini-1.5-flash
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const listsFile  = getArg('--lists')     || path.join(__dirname, 'output',  'army-lists-latest.json');
const reportFile = getArg('--report')    || path.join(__dirname, 'reports', 'meta-report-latest.json');
const optimFile  = getArg('--optimizer') || path.join(__dirname, 'reports', 'optimizer-latest.json');
const outputDir  = getArg('--output')    || path.join(__dirname, 'reports');
const modelId    = getArg('--model')     || 'gemini-2.0-flash-lite';  // free-tier optimised, high rate limits
const maxTokens  = parseInt(getArg('--max-tokens') || '4096', 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

function writeOutput(result, text) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  fs.writeFileSync(path.join(outputDir, `ai-analysis-${ts}.json`),   JSON.stringify(result, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'ai-analysis-latest.json'),  JSON.stringify(result, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outputDir, `ai-analysis-${ts}.txt`),    text, 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'ai-analysis-latest.txt'),   text, 'utf-8');
}

function emptyResult(faction, reason) {
  return {
    generatedAt: new Date().toISOString(),
    model: null,
    faction: faction || 'Death Guard',
    skipped: true,
    reason,
    metaSummary: null,
    detachmentTierList: [],
    bestListAnalysis: null,
    strategicAdvice: null,
    metaTrends: null,
  };
}

// ---------------------------------------------------------------------------
// Gemini REST call  (uses native fetch — available in Node ≥ 18)
// Retries up to 4 times on 429 (rate limit) with exponential backoff.
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1/models/${modelId}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.4,
    },
  };

  const MAX_RETRIES = 4;
  const BASE_DELAY_MS = 10_000; // 10 s — free tier resets quickly

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    const errText = await res.text();

    // 429 = rate limited — back off and retry
    if (res.status === 429 && attempt < MAX_RETRIES) {
      // Honour Retry-After header if present, otherwise use exponential backoff
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt);  // 10s, 20s, 40s, 80s
      console.warn(`Gemini 429 rate limit (attempt ${attempt + 1}/${MAX_RETRIES + 1}). Retrying in ${Math.round(waitMs / 1000)}s…`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Build the prompt
// ---------------------------------------------------------------------------

function buildPrompt(metaReport, optimizerReport) {
  const faction     = (metaReport.meta && metaReport.meta.faction) || 'Death Guard';
  const totalLists  = (metaReport.meta && metaReport.meta.totalLists) || 0;
  const detachments = (metaReport.detachmentBreakdown || []).filter(d => d.detachment !== 'Unknown');
  const topPlayers  = (metaReport.topPlayers || []).slice(0, 10);
  const undefeated  = (metaReport.undefeatedLists || []);

  const unitAnalysis  = optimizerReport?.unitAnalysis?.units        || [];
  const enhancements  = optimizerReport?.enhancementAnalysis?.enhancements || [];
  const coOccurrence  = optimizerReport?.coOccurrence               || [];
  const concreteList  = optimizerReport?.concreteList               || null;

  const lines = [];

  lines.push(`You are an expert Warhammer 40,000 competitive meta analyst specialising in ${faction}.`);
  lines.push(`You have been given real tournament data. Analyse it and produce an extensive, expert-level meta report.`);
  lines.push('');
  lines.push('=== TOURNAMENT DATA ===');
  lines.push(`Faction: ${faction}`);
  lines.push(`Total tournament lists analysed: ${totalLists}`);
  lines.push(`Undefeated finishes: ${undefeated.length}`);
  if (metaReport.meta?.crawledAt) lines.push(`Data crawled: ${metaReport.meta.crawledAt}`);
  lines.push('');

  if (detachments.length > 0) {
    lines.push('--- DETACHMENT BREAKDOWN ---');
    for (const d of detachments) {
      const wr = d.winRate != null ? `${d.winRate}% win rate` : 'win rate N/A';
      lines.push(`  ${d.detachment}: ${d.count} lists (${d.percentage}%), ${wr}, ${d.undefeatedCount} undefeated`);
    }
    lines.push('');
  }

  const topUnits = unitAnalysis.filter(u => u.appearances > 0).slice(0, 20);
  if (topUnits.length > 0) {
    lines.push('--- TOP UNITS (by frequency in tournament lists) ---');
    for (const u of topUnits) {
      lines.push(`  ${u.name}: ${u.frequency}% lists, win correlation ${u.winCorrelation}%, ~${u.typicalPoints}pts, avg copies: ${u.avgCopies}`);
    }
    lines.push('');
  }

  if (enhancements.length > 0) {
    lines.push('--- TOP ENHANCEMENTS ---');
    for (const e of enhancements.slice(0, 8)) {
      lines.push(`  ${e.name}: ${e.frequency}% usage (${e.appearances} times)`);
    }
    lines.push('');
  }

  if (coOccurrence.length > 0) {
    lines.push('--- UNIT SYNERGIES (most common pairings) ---');
    for (const c of coOccurrence.slice(0, 10)) {
      lines.push(`  ${c.pair}: appeared together ${c.count}x (${c.frequency}%)`);
    }
    lines.push('');
  }

  if (topPlayers.length > 0) {
    lines.push('--- TOP PLAYERS ---');
    for (const p of topPlayers.slice(0, 8)) {
      lines.push(`  ${p.player}: ${p.wins}W-${p.losses}L (${p.winRate}% WR), detachments: ${(p.detachments || []).join(', ')}`);
    }
    lines.push('');
  }

  if (undefeated.length > 0) {
    lines.push('--- UNDEFEATED LISTS ---');
    for (const u of undefeated.slice(0, 10)) {
      lines.push(`  ${u.player} — ${u.record} — ${u.detachment} — ${u.event}`);
    }
    lines.push('');
  }

  if (concreteList?.units?.length > 0) {
    lines.push('--- OPTIMIZER RECOMMENDED LIST ---');
    lines.push(`  Detachment: ${concreteList.detachment}`);
    lines.push(`  Total points: ${concreteList.totalPoints}pts`);
    if (concreteList.warlord) lines.push(`  Warlord: ${concreteList.warlord}`);
    if (concreteList.enhancements?.length) lines.push(`  Enhancements: ${concreteList.enhancements.join(', ')}`);
    lines.push('  Units:');
    for (const u of concreteList.units) {
      lines.push(`    ${u.name} — ${u.points}pts (${u.metaFrequency}% meta, tier: ${u.tier})`);
    }
    lines.push('');
  }

  lines.push('=== END DATA ===');
  lines.push('');
  lines.push('Produce a comprehensive Death Guard meta analysis. Be detailed, specific, and reference the actual data.');
  lines.push('');
  lines.push('Respond with ONLY valid JSON — no markdown fences, no extra text. Use this exact structure:');
  lines.push(JSON.stringify({
    generatedAt: '<ISO timestamp>',
    model: '<model name>',
    faction: faction,
    metaSummary: '<2-4 paragraph narrative overview referencing key statistics>',
    detachmentTierList: [
      { tier: 'S', detachment: '<name>', reasoning: '<why this tier>', winRate: '<pct>', listCount: '<n>', undefeated: '<n>' },
    ],
    bestListAnalysis: {
      detachment: '<name>',
      overview: '<2-3 paragraphs on why this is the best archetype>',
      keyUnits: [{ name: '<unit>', role: '<why key>', frequency: '<meta %>'}],
      keySynergies: [{ units: '<unit1 + unit2>', explanation: '<why these work together>'}],
      enhancements: '<which enhancements and why>',
      fullRecommendedList: '<full 2000pt roster with unit names and points>',
    },
    strategicAdvice: {
      overview: '<how to play Death Guard in the current meta>',
      tips: ['<tip>', '<tip>', '<tip>', '<tip>', '<tip>'],
      matchupAdvice: '<favourable/unfavourable matchups>',
    },
    metaTrends: '<what is rising/falling, what to expect next>',
  }, null, 2));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

function renderText(result) {
  const hr = '='.repeat(74);
  const hr2 = '-'.repeat(74);
  const lines = [];

  lines.push(hr);
  lines.push(`  ${result.faction || 'DEATH GUARD'} — AI META ANALYSIS`);
  lines.push(hr);
  lines.push(`  Generated by: ${result.model || 'Gemini AI'}`);
  lines.push(`  Timestamp:    ${result.generatedAt || new Date().toISOString()}`);
  lines.push('');

  if (result.metaSummary) {
    lines.push(hr2);
    lines.push('  META SUMMARY');
    lines.push(hr2);
    lines.push('');
    for (const para of result.metaSummary.split('\n')) lines.push(`  ${para}`);
    lines.push('');
  }

  if (result.detachmentTierList?.length) {
    lines.push(hr2);
    lines.push('  DETACHMENT TIER LIST');
    lines.push(hr2);
    for (const d of result.detachmentTierList) {
      lines.push(`  [${d.tier}] ${d.detachment}  —  WR: ${d.winRate}  |  Lists: ${d.listCount}  |  Undefeated: ${d.undefeated}`);
      lines.push(`      ${d.reasoning}`);
      lines.push('');
    }
  }

  if (result.bestListAnalysis) {
    const bla = result.bestListAnalysis;
    lines.push(hr2);
    lines.push(`  BEST LIST ANALYSIS — ${bla.detachment || ''}`);
    lines.push(hr2);
    lines.push('');
    for (const para of (bla.overview || '').split('\n')) lines.push(`  ${para}`);
    lines.push('');

    if (bla.keyUnits?.length) {
      lines.push('  Key Units:');
      for (const u of bla.keyUnits) lines.push(`    ${(u.name || '').padEnd(35)} [${u.frequency}] — ${u.role}`);
      lines.push('');
    }
    if (bla.keySynergies?.length) {
      lines.push('  Key Synergies:');
      for (const s of bla.keySynergies) {
        lines.push(`    ${s.units}`);
        lines.push(`      ${s.explanation}`);
      }
      lines.push('');
    }
    if (bla.enhancements) { lines.push(`  Enhancements: ${bla.enhancements}`); lines.push(''); }
    if (bla.fullRecommendedList) {
      lines.push('  Recommended Army List:');
      for (const line of bla.fullRecommendedList.split('\n')) lines.push(`    ${line}`);
      lines.push('');
    }
  }

  if (result.strategicAdvice) {
    const sa = result.strategicAdvice;
    lines.push(hr2);
    lines.push('  STRATEGIC ADVICE');
    lines.push(hr2);
    lines.push('');
    if (sa.overview) { for (const p of sa.overview.split('\n')) lines.push(`  ${p}`); lines.push(''); }
    if (sa.tips?.length) {
      lines.push('  Tips:');
      for (const tip of sa.tips) lines.push(`    • ${tip}`);
      lines.push('');
    }
    if (sa.matchupAdvice) {
      lines.push('  Matchup Advice:');
      for (const p of sa.matchupAdvice.split('\n')) lines.push(`    ${p}`);
      lines.push('');
    }
  }

  if (result.metaTrends) {
    lines.push(hr2);
    lines.push('  META TRENDS');
    lines.push(hr2);
    lines.push('');
    for (const p of result.metaTrends.split('\n')) lines.push(`  ${p}`);
    lines.push('');
  }

  lines.push(hr);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set — skipping AI analysis. Writing empty placeholder.');
    console.warn('Get a free key at: https://aistudio.google.com/app/apikey');
    writeOutput(emptyResult('Death Guard', 'GEMINI_API_KEY not set'), 'AI analysis skipped: GEMINI_API_KEY not set.\n');
    process.exit(0);
  }

  const metaReport      = readJSON(reportFile);
  const optimizerReport = readJSON(optimFile);

  if (!metaReport) {
    console.warn(`Meta report not found at ${reportFile}.`);
    writeOutput(emptyResult('Death Guard', 'Meta report not found'), 'AI analysis skipped: meta report not found.\n');
    process.exit(0);
  }

  if ((metaReport.meta?.totalLists || 0) === 0) {
    console.warn('No army lists in meta report.');
    const faction = metaReport.meta?.faction || 'Death Guard';
    writeOutput(emptyResult(faction, 'No army lists found'), 'AI analysis skipped: no army lists found.\n');
    process.exit(0);
  }

  const faction = metaReport.meta?.faction || 'Death Guard';
  const prompt  = buildPrompt(metaReport, optimizerReport);

  console.log(`Sending prompt to ${modelId}…`);
  console.log(`Data: ${metaReport.meta?.totalLists || 0} lists, ${(metaReport.detachmentBreakdown || []).length} detachments`);

  let rawContent;
  try {
    rawContent = await callGemini(apiKey, prompt);
    console.log(`Gemini responded (${rawContent.length} chars).`);
  } catch (err) {
    console.error('Gemini API call failed:', err.message);
    writeOutput(emptyResult(faction, `API error: ${err.message}`), `AI analysis failed: ${err.message}\n`);
    process.exit(0);
  }

  // Strip markdown fences if the model wrapped the JSON anyway
  let jsonStr = rawContent.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let result;
  try {
    result = JSON.parse(jsonStr);
  } catch (err) {
    console.error('Failed to parse Gemini response as JSON:', err.message);
    console.error('Raw response (first 500 chars):', rawContent.slice(0, 500));
    result = {
      generatedAt: new Date().toISOString(),
      model: modelId,
      faction,
      parseError: true,
      metaSummary: rawContent,
      detachmentTierList: [],
      bestListAnalysis: null,
      strategicAdvice: null,
      metaTrends: null,
    };
  }

  result.generatedAt = result.generatedAt || new Date().toISOString();
  result.model       = result.model       || modelId;

  const textOutput = renderText(result);
  console.log('\n' + textOutput);
  writeOutput(result, textOutput);
  console.log(`\nAI analysis saved to ${path.join(outputDir, 'ai-analysis-latest.json')}`);
}

main().catch(err => {
  console.error('Unhandled error in ai-analysis.js:', err);
  process.exit(0); // Always exit 0 so the pipeline continues
});
