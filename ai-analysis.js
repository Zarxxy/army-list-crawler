/**
 * ai-analysis.js
 *
 * Generates per-list and per-detachment AI characterizations using the Anthropic API.
 *
 * Output schema:
 *   detachmentSummaries[]   — state-of-the-meta paragraph per detachment (≤150 words)
 *   listCharacterizations[] — archetype label + game plan per list (≤80 words)
 *   crossDetachmentPatterns — patterns across all factions (≤200 words)
 *   crawlDiff               — "since last crawl" summary (≤100 words)
 *
 * Uses Anthropic prompt caching on the static system prompt block to reduce
 * costs on repeated crawls. Logs full token usage (including cache metrics).
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
 *   node ai-analysis.js --model claude-opus-4-5
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArgLocal(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const listsFile  = getArgLocal('--lists')     || path.join(__dirname, 'output',  'army-lists-latest.json');
const reportFile = getArgLocal('--report')    || path.join(__dirname, 'reports', 'meta-report-latest.json');
const optimFile  = getArgLocal('--optimizer') || path.join(__dirname, 'reports', 'optimizer-latest.json');
const outputDir  = getArgLocal('--output')    || path.join(__dirname, 'reports');
const modelId    = getArgLocal('--model')     || appConfig.aiAnalysis.defaultModel;
const maxTokens  = parseInt(getArgLocal('--max-tokens') || String(appConfig.aiAnalysis.maxTokens), 10);
const limits     = appConfig.aiAnalysis.outputLimits || {};

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
    faction: faction || 'Unknown',
    skipped: true,
    reason,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    detachmentSummaries: [],
    listCharacterizations: [],
    crossDetachmentPatterns: null,
    crawlDiff: null,
  };
}

// ---------------------------------------------------------------------------
// Build the static system prompt (cacheable block)
// ---------------------------------------------------------------------------

function buildSystemPrompt(faction) {
  return [
    `You are an expert Warhammer 40,000 competitive meta analyst specialising in ${faction}.`,
    'You are given real tournament data (top-finishing lists only — 1st and 2nd place finishes).',
    '',
    '=== ANALYSIS RULES — FOLLOW STRICTLY ===',
    '',
    'DATASET CONTEXT: This dataset contains ONLY top-finishing tournament lists.',
    'Win rates are NOT representative of general field performance. Do NOT mention win rates.',
    '',
    'RULE 1 — ONLY CLAIMS GROUNDED IN DATA:',
    'Only describe units, synergies, and strategies that appear in the provided lists.',
    'No speculation. No matchup predictions. No win rate claims.',
    '',
    'RULE 2 — FRAMING:',
    'Use "appears in X% of top lists" or "top players frequently choose" — not "wins because of".',
    '',
    'RULE 3 — DETACHMENT SUMMARIES (≤' + (limits.wordsPerDetachmentSummary || 150) + ' words each):',
    'Describe: current archetypes, what units are universal vs optional, what new tech has appeared.',
    'Do not tier or rank detachments against each other.',
    '',
    'RULE 4 — LIST CHARACTERIZATIONS (≤' + (limits.wordsPerList || 80) + ' words each):',
    'For each list: archetype label (2-4 words), game plan, key synergies, notable tech differences.',
    '',
    'RULE 5 — CROSS-DETACHMENT PATTERNS (≤' + (limits.wordsCrossDetachment || 200) + ' words):',
    'Patterns visible across ALL lists regardless of detachment: model count trends, shooting vs melee',
    'balance, character density, objective play, indirect fire prevalence.',
    '',
    'RULE 6 — CRAWL DIFF (≤' + (limits.wordsCrawlDiff || 100) + ' words):',
    'Summarise what changed since the previous crawl: new lists, dropped lists, new tech appearing.',
    'Only include if diff data is provided.',
    '',
    '=== END RULES ===',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Build the user message (data block — changes each crawl)
// ---------------------------------------------------------------------------

function buildUserMessage(listsData, metaReport, optimizerReport) {
  const faction     = (metaReport.meta && metaReport.meta.faction) || 'Unknown';
  const totalLists  = (metaReport.meta && metaReport.meta.totalLists) || 0;
  const detachments = (metaReport.detachmentBreakdown || []).filter((d) => d.detachment !== 'Unknown');
  const crawlDiff   = metaReport.crawlDiff || null;
  const detFreq     = (optimizerReport && optimizerReport.detachmentFrequencyAnalysis) || [];
  const variance    = (optimizerReport && optimizerReport.varianceAnalysis) || [];
  const novelty     = (optimizerReport && optimizerReport.noveltyFlags) || [];

  const lines = [];

  lines.push('=== TOURNAMENT DATA ===');
  lines.push(`Faction: ${faction}`);
  lines.push(`Total top-finishing lists: ${totalLists}`);
  if (metaReport.meta?.crawledAt) lines.push(`Data crawled: ${metaReport.meta.crawledAt}`);
  lines.push('');

  // Detachment breakdown
  if (detachments.length > 0) {
    lines.push('--- DETACHMENT BREAKDOWN ---');
    for (const d of detachments) {
      lines.push(`  ${d.detachment}: ${d.count} lists (${d.percentage}%), ${d.undefeatedCount} undefeated`);
    }
    lines.push('');
  }

  // Per-detachment frequency
  if (detFreq.length > 0) {
    lines.push('--- PER-DETACHMENT UNIT FREQUENCY ---');
    for (const d of detFreq) {
      lines.push(`  [${d.detachment}] — ${d.listCount} lists`);
      for (const u of (d.topUnits || []).slice(0, 10)) {
        lines.push(`    ${u.name}: ${u.frequency}% (${u.count} lists)`);
      }
      if ((d.topEnhancements || []).length > 0) {
        lines.push(`  Enhancements:`);
        for (const e of d.topEnhancements.slice(0, 5)) {
          lines.push(`    ${e.name}: ${e.frequency}%`);
        }
      }
    }
    lines.push('');
  }

  // Variance
  if (variance.length > 0) {
    lines.push('--- CONTESTED TECH (20-79% inclusion per detachment) ---');
    for (const d of variance) {
      lines.push(`  [${d.detachment}]: ${d.contestedUnits.map((u) => `${u.name} (${u.frequency}%)`).join(', ')}`);
    }
    lines.push('');
  }

  // Novelty
  if (novelty.length > 0) {
    lines.push(`--- NEW TECH THIS CRAWL (${novelty.length} items) ---`);
    for (const n of novelty.slice(0, 15)) {
      lines.push(`  [${n.type}] ${n.name} — ${n.detachment}`);
    }
    lines.push('');
  }

  // Crawl diff
  if (crawlDiff) {
    lines.push('--- CRAWL DIFF ---');
    lines.push(`  New lists: ${crawlDiff.newLists.length}`);
    lines.push(`  Dropped lists: ${crawlDiff.droppedLists.length}`);
    lines.push(`  New tech choices: ${crawlDiff.newTechChoices.length}`);
    if (crawlDiff.newLists.length > 0) {
      lines.push('  New:');
      for (const l of crawlDiff.newLists.slice(0, 5)) {
        lines.push(`    + ${l.playerName} (${l.detachment}) — ${l.event}`);
      }
    }
    if (crawlDiff.newTechChoices.length > 0) {
      lines.push(`  New tech: ${crawlDiff.newTechChoices.slice(0, 8).join(', ')}`);
    }
    lines.push('');
  }

  // Army lists (truncated for token efficiency)
  // Flatten from listsByDetachment if available, otherwise from sections
  const allLists = [];
  if (metaReport.listsByDetachment) {
    for (const detLists of Object.values(metaReport.listsByDetachment)) {
      for (const l of detLists) allLists.push(l);
    }
  } else if (listsData && listsData.sections) {
    for (const entries of Object.values(listsData.sections)) {
      for (const e of entries) allLists.push(e);
    }
  }

  if (allLists.length > 0) {
    lines.push('--- ARMY LISTS ---');
    lines.push('(Full list texts truncated to 400 chars for token efficiency)');
    lines.push('');
    for (const l of allLists) {
      const player = l.playerName || l.player || 'Unknown';
      const det = l.detachment || 'Unknown';
      const event = l.event || 'Unknown Event';
      const date = l.date || '';
      const listId = `${player}|${event}|${date}`;
      const text = (l.armyListText || '').substring(0, 400);
      lines.push(`LIST_ID: ${listId}`);
      lines.push(`Detachment: ${det} | Event: ${event} | Date: ${date}`);
      lines.push(text || '(no list text available)');
      lines.push('---');
    }
    lines.push('');
  }

  lines.push('=== END DATA ===');
  lines.push('');

  // Output schema instruction
  lines.push('Respond with ONLY valid JSON — no markdown, no preamble. Start with { end with }.');
  lines.push('');
  lines.push('Use this exact schema:');
  lines.push(JSON.stringify({
    generatedAt: '<ISO timestamp>',
    model: '<model name>',
    faction,
    detachmentSummaries: [
      {
        detachment: '<name>',
        summary: '<≤' + (limits.wordsPerDetachmentSummary || 150) + ' words: archetypes, core units, new tech>',
      },
    ],
    listCharacterizations: [
      {
        listId: '<player|event|date matching LIST_ID above>',
        archetype: '<2-4 word label>',
        gamePlan: '<≤' + (limits.wordsPerList || 80) + ' words>',
        keySynergies: '<brief>',
        techDiffs: '<what differs from other lists in same detachment>',
      },
    ],
    crossDetachmentPatterns: '<≤' + (limits.wordsCrossDetachment || 200) + ' words: patterns across all factions>',
    crawlDiff: crawlDiff ? '<≤' + (limits.wordsCrawlDiff || 100) + ' words: since last crawl summary>' : null,
  }, null, 2));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON extraction (handles markdown fences and preamble)
// ---------------------------------------------------------------------------

function extractJSON(raw) {
  const trimmed = raw.trim();

  try { return JSON.parse(trimmed); } catch {}

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace  = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch {}
  }

  return null;
}

// ---------------------------------------------------------------------------
// Text renderer for .txt output
// ---------------------------------------------------------------------------

function renderText(result) {
  const hr  = '='.repeat(74);
  const hr2 = '-'.repeat(74);
  const lines = [];

  lines.push(hr);
  lines.push(`  ${result.faction || 'UNKNOWN'} — AI META ANALYSIS`);
  lines.push(hr);
  lines.push(`  Generated by: ${result.model || 'Claude AI'}`);
  lines.push(`  Timestamp:    ${result.generatedAt || new Date().toISOString()}`);
  if (result.inputTokens) {
    lines.push(`  Tokens: ${result.inputTokens} in / ${result.outputTokens} out` +
      (result.cacheReadTokens ? ` / ${result.cacheReadTokens} cache read / ${result.cacheCreationTokens} cache write` : ''));
  }
  lines.push('');

  if (result.detachmentSummaries && result.detachmentSummaries.length) {
    lines.push(hr2); lines.push('  DETACHMENT SUMMARIES'); lines.push(hr2);
    for (const d of result.detachmentSummaries) {
      lines.push('');
      lines.push(`  [${d.detachment}]`);
      for (const p of (d.summary || '').split('\n')) lines.push(`  ${p}`);
    }
    lines.push('');
  }

  if (result.listCharacterizations && result.listCharacterizations.length) {
    lines.push(hr2); lines.push('  LIST CHARACTERIZATIONS'); lines.push(hr2);
    for (const l of result.listCharacterizations) {
      lines.push('');
      lines.push(`  ${l.listId}`);
      lines.push(`  Archetype: ${l.archetype}`);
      lines.push(`  Game Plan: ${l.gamePlan}`);
      if (l.keySynergies) lines.push(`  Key Synergies: ${l.keySynergies}`);
      if (l.techDiffs) lines.push(`  Tech Diffs: ${l.techDiffs}`);
    }
    lines.push('');
  }

  if (result.crossDetachmentPatterns) {
    lines.push(hr2); lines.push('  CROSS-DETACHMENT PATTERNS'); lines.push(hr2); lines.push('');
    for (const p of result.crossDetachmentPatterns.split('\n')) lines.push(`  ${p}`);
    lines.push('');
  }

  if (result.crawlDiff) {
    lines.push(hr2); lines.push('  CRAWL DIFF SUMMARY'); lines.push(hr2); lines.push('');
    for (const p of result.crawlDiff.split('\n')) lines.push(`  ${p}`);
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
    writeOutput(emptyResult('Unknown', 'ANTHROPIC_API_KEY not set'), 'AI analysis skipped: ANTHROPIC_API_KEY not set.\n');
    process.exit(0);
  }

  const metaReport      = readJSON(reportFile);
  const optimizerReport = readJSON(optimFile);
  const listsData       = readJSON(listsFile);

  if (!metaReport) {
    console.warn(`Meta report not found at ${reportFile}.`);
    writeOutput(emptyResult('Unknown', 'Meta report not found'), 'AI analysis skipped: meta report not found.\n');
    process.exit(0);
  }

  if ((metaReport.meta?.totalLists || 0) === 0) {
    console.warn('No army lists in meta report.');
    const faction = metaReport.meta?.faction || 'Unknown';
    writeOutput(emptyResult(faction, 'No army lists found'), 'AI analysis skipped: no army lists found.\n');
    process.exit(0);
  }

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (err) {
    console.error('Could not load @anthropic-ai/sdk. Run "npm install" first.');
    const faction = metaReport.meta?.faction || 'Unknown';
    writeOutput(emptyResult(faction, '@anthropic-ai/sdk not installed'), 'AI analysis skipped: SDK not installed.\n');
    process.exit(0);
  }

  const client  = new Anthropic({ apiKey, maxRetries: 4 });
  const faction = metaReport.meta?.faction || 'Unknown';

  const systemPrompt  = buildSystemPrompt(faction);
  const userMessage   = buildUserMessage(listsData, metaReport, optimizerReport);

  console.log(`Sending prompt to ${modelId} (max_tokens: ${maxTokens})…`);
  console.log(`Data: ${metaReport.meta?.totalLists || 0} lists, ${(metaReport.detachmentBreakdown || []).length} detachments`);
  console.log(`System prompt: ${systemPrompt.length} chars (cached)`);
  console.log(`User message: ${userMessage.length} chars`);

  // ---------------------------------------------------------------------------
  // API call — with prompt caching on the system block and retry-once on parse failure
  // ---------------------------------------------------------------------------

  async function callAPI() {
    const stream = client.messages.stream({
      model: modelId,
      max_tokens: maxTokens,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });

    stream.on('text', (text) => process.stdout.write(text));
    const message = await stream.finalMessage();

    const rawContent = message.content.find((b) => b.type === 'text')?.text || '';
    const stopReason = message.stop_reason;
    const usage      = message.usage || {};

    console.log(`\nClaude responded (${rawContent.length} chars, stop_reason: ${stopReason})`);
    console.log(`Tokens — in: ${usage.input_tokens}, out: ${usage.output_tokens}, cache_write: ${usage.cache_creation_input_tokens || 0}, cache_read: ${usage.cache_read_input_tokens || 0}`);

    if (stopReason === 'max_tokens') {
      console.warn('WARNING: Response was cut off at max_tokens limit — JSON may be truncated.');
    }

    return { rawContent, usage };
  }

  let rawContent, usage;
  try {
    ({ rawContent, usage } = await callAPI());
  } catch (err) {
    console.error('Anthropic API call failed:', err.message);
    writeOutput(emptyResult(faction, `API error: ${err.message}`), `AI analysis failed: ${err.message}\n`);
    process.exit(0);
  }

  // Parse JSON — retry once if it fails
  let result = extractJSON(rawContent);

  if (!result) {
    console.warn('Failed to parse Claude response as JSON. Retrying once…');
    try {
      ({ rawContent, usage } = await callAPI());
      result = extractJSON(rawContent);
    } catch (err) {
      console.error('Retry API call failed:', err.message);
    }
  }

  if (!result) {
    console.error('Failed to parse Claude response as JSON after retry. Writing parse-error placeholder.');
    console.error('Raw response (first 500 chars):', rawContent.slice(0, 500));
    result = {
      generatedAt: new Date().toISOString(),
      model: modelId,
      faction,
      parseError: true,
      rawResponse: rawContent.slice(0, 2000),
      detachmentSummaries: [],
      listCharacterizations: [],
      crossDetachmentPatterns: null,
      crawlDiff: null,
    };
  }

  // Stamp metadata
  result.generatedAt        = result.generatedAt        || new Date().toISOString();
  result.model              = result.model              || modelId;
  result.inputTokens        = (usage && usage.input_tokens)                   || 0;
  result.outputTokens       = (usage && usage.output_tokens)                  || 0;
  result.cacheCreationTokens = (usage && usage.cache_creation_input_tokens)   || 0;
  result.cacheReadTokens    = (usage && usage.cache_read_input_tokens)        || 0;

  const textOutput = renderText(result);
  console.log('\n' + textOutput);
  writeOutput(result, textOutput);
  console.log(`\nAI analysis saved to ${path.join(outputDir, 'ai-analysis-latest.json')}`);
}

main().catch((err) => {
  console.error('Unhandled error in ai-analysis.js:', err);
  process.exit(0); // Always exit 0 so the pipeline continues
});
