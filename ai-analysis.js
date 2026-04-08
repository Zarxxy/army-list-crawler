/**
 * ai-analysis.js
 *
 * Generates an AI-powered Death Guard meta analysis using the Anthropic API.
 * The model is configured via config.json (aiAnalysis.defaultModel) or --model flag.
 * Reads the crawled army lists, meta report, and optimizer
 * output, then asks Claude to produce:
 *
 *   - A meta summary
 *   - A detachment tier list (S / A / B / C) with reasoning
 *   - "Best list" breakdown — key units, synergies, enhancements, full roster
 *   - Strategic advice and meta trends
 *
 * Output: reports/ai-analysis-latest.json  (+ timestamped copy)
 *         reports/ai-analysis-latest.txt   (+ timestamped copy)
 *
 * The script exits with code 0 even if the API key is missing so the
 * GitHub Actions pipeline is never blocked by this step.
 *
 * Usage:
 *   node ai-analysis.js
 *   ANTHROPIC_API_KEY=sk-ant-... node ai-analysis.js
 *   node ai-analysis.js --lists ./output/army-lists-latest.json
 *   node ai-analysis.js --report ./reports/meta-report-latest.json
 *   node ai-analysis.js --optimizer ./reports/optimizer-latest.json
 *   node ai-analysis.js --output ./reports
 *   node ai-analysis.js --model claude-haiku-4-5
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const listsFile  = getArg('--lists')      || path.join(__dirname, 'output',  'army-lists-latest.json');
const reportFile = getArg('--report')     || path.join(__dirname, 'reports', 'meta-report-latest.json');
const optimFile  = getArg('--optimizer')  || path.join(__dirname, 'reports', 'optimizer-latest.json');
const outputDir  = getArg('--output')     || path.join(__dirname, 'reports');
const modelId    = getArg('--model')      || appConfig.aiAnalysis.defaultModel;
const maxTokens  = parseInt(getArg('--max-tokens') || String(appConfig.aiAnalysis.maxTokens), 10);

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

  fs.writeFileSync(path.join(outputDir, `ai-analysis-${ts}.json`),  JSON.stringify(result, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'ai-analysis-latest.json'), JSON.stringify(result, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outputDir, `ai-analysis-${ts}.txt`),   text, 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'ai-analysis-latest.txt'),  text, 'utf-8');
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
// Build the prompt
// ---------------------------------------------------------------------------

function buildPrompt(metaReport, optimizerReport) {
  const faction     = (metaReport.meta && metaReport.meta.faction) || 'Death Guard';
  const totalLists  = (metaReport.meta && metaReport.meta.totalLists) || 0;
  const detachments = (metaReport.detachmentBreakdown || []).filter(d => d.detachment !== 'Unknown');
  const topPlayers  = (metaReport.topPlayers || []).slice(0, 10);
  const undefeated  = (metaReport.undefeatedLists || []);

  const unitAnalysis = optimizerReport?.unitAnalysis?.units        || [];
  const enhancements = optimizerReport?.enhancementAnalysis?.enhancements || [];
  const coOccurrence = optimizerReport?.coOccurrence               || [];
  const concreteList = optimizerReport?.concreteList               || null;

  const lines = [];

  lines.push(`You are an expert Warhammer 40,000 competitive meta analyst specialising in ${faction}.`);
  lines.push(`You have been given real tournament data. Analyse it and produce an extensive, expert-level meta report.`);
  lines.push('');
  lines.push('=== ANALYSIS RULES — FOLLOW STRICTLY ===');
  lines.push('');
  lines.push('DATASET CONTEXT: This dataset contains ONLY top-finishing tournament lists (1st and 2nd');
  lines.push('place results). Win rates are artificially inflated and are NOT representative of general');
  lines.push('field performance.');
  lines.push('');
  lines.push('RULE 1 — MINIMUM SAMPLE THRESHOLD:');
  lines.push('Any detachment with listCount < 3 → tier = "Insufficient data", insufficientData = true.');
  lines.push('A single strong result is no signal at all.');
  lines.push('');
  lines.push('RULE 2 — TIERS ARE BASED ON POPULARITY AND UNDEFEATED RUNS ONLY:');
  lines.push('Do NOT use win rate to assign tiers. Tier is determined by:');
  lines.push('  • list count (how many top players chose this detachment)');
  lines.push('  • number of undefeated runs');
  lines.push('A detachment with 1 list and 100% WR is NOT tier-able. A detachment with 16 lists');
  lines.push('and 4 undefeated runs is S-tier regardless of its win rate.');
  lines.push('');
  lines.push('RULE 3 — TIER REASONING FORMAT:');
  lines.push('State: "<Tier> — <N> top-finishing lists, <U> undefeated runs[, brief tactical note]"');
  lines.push('NEVER mention win rate in tier reasoning or tier descriptions.');
  lines.push('Example: "S — 16 top-finishing lists, 4 undefeated runs — dominant presence across events."');
  lines.push('Example: "Insufficient data — n=1; a single list cannot be evaluated."');
  lines.push('');
  lines.push('RULE 4 — META SUMMARY FRAMING:');
  lines.push('Lead with player choice and undefeated runs, not win rates.');
  lines.push('Use: "X% of top-finishing lists used this detachment" and "produced Y undefeated runs".');
  lines.push('NEVER write "X wins Y% of games" or frame win rate as a measure of detachment quality.');
  lines.push('');
  lines.push('RULE 5 — KEY UNITS: INCLUSION RATE ONLY:');
  lines.push('For key units, use frequency (how often a unit appears across top-finishing lists).');
  lines.push('DO NOT reference win correlation — it is a circular metric in this dataset.');
  lines.push('Framing: "Appears in X% of top-finishing lists" not "correlated with wins."');
  lines.push('');
  lines.push('RULE 6 — META TRENDS: ONLY STATE WHAT THE DATA DIRECTLY SHOWS:');
  lines.push('ONLY make statements about list count distribution.');
  lines.push('Example: "Virulent Vectorium accounts for 64% of top-finishing lists, making it the');
  lines.push('dominant detachment by player choice." — That is all that can honestly be said.');
  lines.push('Do NOT speculate about "rising/falling" based on win rates or infer optimization trends.');
  lines.push('');
  lines.push('RULE 7 — SYNERGY DESCRIPTIONS: TACTICAL, NOT CAUSAL:');
  lines.push('Describe what paired units do together tactically.');
  lines.push('Say "top players frequently pair these units" — NOT "this pairing is why they win."');
  lines.push('');
  lines.push('=== END ANALYSIS RULES ===');
  lines.push('');
  lines.push('=== TOURNAMENT DATA ===');
  lines.push(`Faction: ${faction}`);
  lines.push(`Total tournament lists analysed: ${totalLists}`);
  lines.push(`Undefeated finishes: ${undefeated.length}`);
  if (metaReport.meta?.crawledAt) lines.push(`Data crawled: ${metaReport.meta.crawledAt}`);
  lines.push('');

  if (detachments.length > 0) {
    lines.push('--- DETACHMENT BREAKDOWN ---');
    lines.push('  [NOTE: All lists are top-finishing results — win rates are elevated vs. general field]');
    for (const d of detachments) {
      const wr = d.winRate !== null && d.winRate !== undefined ? `${d.winRate}% WR (n=${d.count})` : 'win rate N/A';
      lines.push(`  ${d.detachment}: ${d.count} lists (${d.percentage}%), ${wr}, ${d.undefeatedCount} undefeated`);
    }
    lines.push('');
  }

  const topUnits = unitAnalysis.filter(u => u.appearances > 0).slice(0, 20);
  if (topUnits.length > 0) {
    lines.push('--- TOP UNITS (by inclusion rate across top-finishing lists) ---');
    for (const u of topUnits) {
      lines.push(`  ${u.name}: ${u.frequency}% of top-finishing lists (n=${totalLists}), ~${u.typicalPoints}pts, avg copies: ${u.avgCopies}`);
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
  lines.push('IMPORTANT: Respond with ONLY valid JSON. No markdown fences, no preamble, no text before or after the JSON object. Start your response with { and end with }.');
  lines.push('');
  lines.push('Use this exact JSON structure (keep all string values concise — aim for the whole response to stay under 3000 tokens):');
  lines.push(JSON.stringify({
    generatedAt: '<ISO timestamp>',
    model: '<model name>',
    faction,
    metaSummary: '<2-3 paragraphs. Lead with player choice: "X% of top-finishing lists used this detachment" and "produced Y undefeated runs". Do NOT lead with win rates.>',
    detachmentTierList: [
      {
        tier: 'S|A|B|C|Insufficient data',
        detachment: '<name>',
        reasoning: '<tier based on list count and undefeated runs ONLY — NO win rate. Format: "S — 16 top-finishing lists, 4 undefeated runs — dominant presence across events.">',
        listCount: 0,
        undefeated: 0,
        insufficientData: false,
        sampleNote: '<required when listCount < 3: explain why this cannot be evaluated, null otherwise>',
      },
    ],
    bestListAnalysis: {
      detachment: '<name>',
      overview: '<1-2 paragraphs on why top players gravitate to this archetype — do NOT frame around win rate>',
      keyUnits: [{ name: '<unit>', role: '<tactical role — do NOT reference win correlation>', frequency: '<X% of top-finishing lists include this unit>' }],
      keySynergies: [{ units: '<unit1 + unit2>', explanation: '<what they do together tactically; note top players frequently pair them — do NOT say "this is why they win">' }],
      enhancements: '<key enhancements and why, 1-2 sentences>',
    },
    strategicAdvice: {
      overview: '<1-2 paragraphs on how to play Death Guard>',
      tips: ['<tip 1>', '<tip 2>', '<tip 3>', '<tip 4>', '<tip 5>'],
      matchupAdvice: '<1-2 sentences on favourable/unfavourable matchups>',
    },
    metaTrends: '<1-2 sentences on list count distribution ONLY — e.g. "Virulent Vectorium accounts for X% of top-finishing lists." No speculation about win rate trends or optimization.>',
  }, null, 2));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

function renderText(result) {
  const hr  = '='.repeat(74);
  const hr2 = '-'.repeat(74);
  const lines = [];

  lines.push(hr);
  lines.push(`  ${result.faction || 'DEATH GUARD'} — AI META ANALYSIS`);
  lines.push(hr);
  lines.push(`  Generated by: ${result.model || 'Claude AI'}`);
  lines.push(`  Timestamp:    ${result.generatedAt || new Date().toISOString()}`);
  lines.push('');

  if (result.metaSummary) {
    lines.push(hr2); lines.push('  META SUMMARY'); lines.push(hr2); lines.push('');
    for (const p of result.metaSummary.split('\n')) lines.push(`  ${p}`);
    lines.push('');
  }

  if (result.detachmentTierList?.length) {
    lines.push(hr2); lines.push('  DETACHMENT TIER LIST'); lines.push(hr2);
    lines.push('  NOTE: Dataset contains top-finishing lists only — WR figures are elevated vs. general field.');
    lines.push('');
    for (const d of result.detachmentTierList) {
      const tierLabel = d.insufficientData ? 'INSUFF' : (d.tier || '?');
      lines.push(`  [${tierLabel}] ${d.detachment}  —  Lists: ${d.listCount}  |  Undefeated: ${d.undefeated}`);
      if (d.reasoning) lines.push(`      ${d.reasoning}`);
      if (d.sampleNote) lines.push(`      ⚠ ${d.sampleNote}`);
      lines.push('');
    }
  }

  if (result.bestListAnalysis) {
    const bla = result.bestListAnalysis;
    lines.push(hr2); lines.push(`  BEST LIST ANALYSIS — ${bla.detachment || ''}`); lines.push(hr2); lines.push('');
    for (const p of (bla.overview || '').split('\n')) lines.push(`  ${p}`);
    lines.push('');
    if (bla.keyUnits?.length) {
      lines.push('  Key Units:');
      for (const u of bla.keyUnits) lines.push(`    ${(u.name || '').padEnd(35)} [${u.frequency}] — ${u.role}`);
      lines.push('');
    }
    if (bla.keySynergies?.length) {
      lines.push('  Key Synergies:');
      for (const s of bla.keySynergies) { lines.push(`    ${s.units}`); lines.push(`      ${s.explanation}`); }
      lines.push('');
    }
    if (bla.enhancements) { lines.push(`  Enhancements: ${bla.enhancements}`); lines.push(''); }
    if (bla.fullRecommendedList) {
      lines.push('  Recommended Army List:');
      for (const l of bla.fullRecommendedList.split('\n')) lines.push(`    ${l}`);
      lines.push('');
    }
  }

  if (result.strategicAdvice) {
    const sa = result.strategicAdvice;
    lines.push(hr2); lines.push('  STRATEGIC ADVICE'); lines.push(hr2); lines.push('');
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
    lines.push(hr2); lines.push('  META TRENDS'); lines.push(hr2); lines.push('');
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
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY not set — skipping AI analysis. Writing empty placeholder.');
    writeOutput(emptyResult('Death Guard', 'ANTHROPIC_API_KEY not set'), 'AI analysis skipped: ANTHROPIC_API_KEY not set.\n');
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

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (err) {
    console.error('Could not load @anthropic-ai/sdk. Run "npm install" first.');
    const faction = metaReport.meta?.faction || 'Death Guard';
    writeOutput(emptyResult(faction, '@anthropic-ai/sdk not installed'), 'AI analysis skipped: SDK not installed.\n');
    process.exit(0);
  }

  // SDK handles retries automatically (default max_retries=2); bump to 4 for robustness
  const client = new Anthropic({ apiKey, maxRetries: 4 });
  const faction = metaReport.meta?.faction || 'Death Guard';
  const prompt  = buildPrompt(metaReport, optimizerReport);

  console.log(`Sending prompt to ${modelId} (max_tokens: ${maxTokens})…`);
  console.log(`Data: ${metaReport.meta?.totalLists || 0} lists, ${(metaReport.detachmentBreakdown || []).length} detachments`);

  let rawContent;
  try {
    // Use streaming — safe for long prompts and large outputs, avoids HTTP timeouts
    const stream = client.messages.stream({
      model: modelId,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    // Stream progress to console so CI logs show activity
    stream.on('text', text => process.stdout.write(text));

    const message = await stream.finalMessage();
    rawContent = message.content.find(b => b.type === 'text')?.text || '';
    const stopReason = message.stop_reason;
    console.log(`\nClaude responded (${rawContent.length} chars, ${message.usage.output_tokens} output tokens, stop_reason: ${stopReason}).`);
    if (stopReason === 'max_tokens') {
      console.warn('WARNING: Response was cut off at max_tokens limit — JSON may be truncated.');
    }
  } catch (err) {
    console.error('Anthropic API call failed:', err.message);
    writeOutput(emptyResult(faction, `API error: ${err.message}`), `AI analysis failed: ${err.message}\n`);
    process.exit(0);
  }

  // Extract the JSON object from Claude's response.
  // Claude sometimes wraps it in markdown fences or adds preamble text.
  function extractJSON(raw) {
    const trimmed = raw.trim();

    // 1. Try bare parse first (ideal case)
    try { return JSON.parse(trimmed); } catch {}

    // 2. Markdown fence: ```json ... ``` or ``` ... ```
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try { return JSON.parse(fenceMatch[1].trim()); } catch {}
    }

    // 3. Extract the outermost { … } block (handles preamble/postamble text)
    const firstBrace = trimmed.indexOf('{');
    const lastBrace  = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch {}
    }

    return null;
  }

  let result = extractJSON(rawContent);
  if (!result) {
    console.error('Failed to parse Claude response as JSON.');
    console.error('Raw response — first 500 chars:', rawContent.slice(0, 500));
    console.error('Raw response — last  300 chars:', rawContent.slice(-300));
    result = {
      generatedAt: new Date().toISOString(),
      model: modelId,
      faction,
      parseError: true,
      rawResponse: rawContent.slice(0, 2000), // truncated for diagnostics only
      metaSummary: null,
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
