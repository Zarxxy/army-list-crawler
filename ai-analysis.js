/**
 * ai-analysis.js
 *
 * Generates per-list and per-detachment AI characterizations using the
 * Anthropic API with prompt caching. Reads the crawled army lists, meta
 * report, and optimizer output.
 *
 * Output schema:
 *   detachmentSummaries[]  — ≤150 words each: archetypes, core, new tech
 *   listCharacterizations[] — per list: archetype, gamePlan (≤80w), synergies, techDiffs
 *   crossDetachmentPatterns — ≤200 words: model count, indirect, character density
 *   crawlDiff              — ≤100 words: what changed since last crawl (or null)
 *
 * Exits 0 even on API error so the pipeline is never blocked.
 *
 * Usage:
 *   node ai-analysis.js
 *   ANTHROPIC_API_KEY=sk-ant-... node ai-analysis.js
 *   node ai-analysis.js --lists ./output/army-lists-latest.json
 *   node ai-analysis.js --report ./reports/meta-report-latest.json
 *   node ai-analysis.js --optimizer ./reports/optimizer-latest.json
 *   node ai-analysis.js --output ./reports
 *   node ai-analysis.js --enriched ./reports/enriched-rules-latest.json
 *   node ai-analysis.js --model claude-opus-4-6
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { flattenLists, getArg } = require('./utils');

const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const listsFile  = getArg(args, '--lists')      || path.join(__dirname, 'output',  'army-lists-latest.json');
const reportFile = getArg(args, '--report')     || path.join(__dirname, 'reports', 'meta-report-latest.json');
const optimFile  = getArg(args, '--optimizer')  || path.join(__dirname, 'reports', 'optimizer-latest.json');
const outputDir  = getArg(args, '--output')     || path.join(__dirname, 'reports');
const rulesDir   = getArg(args, '--rules-dir')  || path.join(__dirname, 'rules');
const enrichedFile = getArg(args, '--enriched') || path.join(__dirname, 'reports', 'enriched-rules-latest.json');
const modelId    = getArg(args, '--model')      || appConfig.aiAnalysis.defaultModel;
const _rawMaxTokens = parseInt(getArg(args, '--max-tokens') || String(appConfig.aiAnalysis.maxTokens), 10);
const maxTokens = Number.isFinite(_rawMaxTokens) && _rawMaxTokens > 0 ? _rawMaxTokens : appConfig.aiAnalysis.maxTokens;

const outputLimits = appConfig.aiAnalysis.outputLimits || {
  wordsPerList: 80,
  wordsPerDetachmentSummary: 150,
  wordsCrossDetachment: 200,
  wordsCrawlDiff: 100,
};

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
// Rules document loader
// ---------------------------------------------------------------------------

function loadRulesDocument(dir) {
  const rfConfig = appConfig.rulesFetcher || {};
  const defaultFaction = rfConfig.defaultFaction || 'death-guard';
  const defaultEdition = rfConfig.defaultEdition || '10ed';
  const candidates = [
    path.join(dir, `${defaultFaction}-latest.txt`),
    path.join(dir, `${defaultFaction}-${defaultEdition}.txt`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf-8');
      console.log(`Loaded rules document: ${p} (${text.length} chars)`);
      return text;
    }
  }
  console.log('No rules document found — proceeding without rules context.');
  return null;
}

/**
 * Build a focused rules context from the enriched-rules JSON, targeting
 * only detachments and units that appear in the current tournament data.
 * Falls back to the full TXT if enriched data is unavailable.
 */
function buildFocusedRulesContext(enrichedPath, detachmentNames, unitNames) {
  const enriched = readJSON(enrichedPath);
  if (!enriched || !enriched.detachments || enriched.detachments.length === 0) return null;

  const detSet = new Set(detachmentNames.map((d) => d.toLowerCase()));
  const unitSet = new Set(unitNames.map((u) => u.toLowerCase()));

  const lines = [];
  lines.push('=== FACTION RULES REFERENCE (relevant to current tournament data) ===');
  lines.push('');

  // Detachment rules for detachments in the data
  for (const det of enriched.detachments) {
    if (detSet.size > 0 && !detSet.has(det.name.toLowerCase())) continue;

    lines.push(`--- DETACHMENT: ${det.name} ---`);
    lines.push(`Ability: ${det.abilityName} — ${det.abilityDescription.slice(0, 200)}`);
    lines.push('');

    if (det.stratagems.length > 0) {
      lines.push('Stratagems:');
      for (const s of det.stratagems) {
        lines.push(`  ${s.name} (${s.cp}, ${s.type})`);
        if (s.when) lines.push(`    When: ${s.when}`);
        if (s.target) lines.push(`    Target: ${s.target}`);
      }
      lines.push('');
    }

    if (det.enhancements.length > 0) {
      lines.push('Enhancements:');
      for (const e of det.enhancements) {
        lines.push(`  ${e.name} (${e.pts}pts)`);
      }
      lines.push('');
    }
  }

  // Unit keywords for units in the data
  if (enriched.units && enriched.units.length > 0) {
    const relevantUnits = enriched.units.filter((u) => unitSet.has(u.name.toLowerCase()));
    if (relevantUnits.length > 0) {
      lines.push('--- UNIT KEYWORDS (tournament units) ---');
      for (const u of relevantUnits) {
        if (u.keywords.length > 0) {
          lines.push(`  ${u.canonicalName || u.name}: ${u.keywords.join(', ')}`);
        }
      }
      lines.push('');
    }
  }

  // Unseen units (units in rules but never in tournaments)
  if (enriched.unseenUnits && enriched.unseenUnits.length > 0) {
    lines.push('--- UNITS NEVER SEEN IN TOURNAMENTS ---');
    for (const u of enriched.unseenUnits.slice(0, 10)) {
      lines.push(`  ${u.name}: ${u.keywords.join(', ')}`);
    }
    lines.push('');
  }

  const text = lines.join('\n');
  console.log(`Built focused rules context: ${text.length} chars (vs full TXT)`);
  return text;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPromptBlocks(faction, rulesText) {
  const wList  = outputLimits.wordsPerList;
  const wDet   = outputLimits.wordsPerDetachmentSummary;
  const wCross = outputLimits.wordsCrossDetachment;
  const wDiff  = outputLimits.wordsCrawlDiff;

  const instructionsText = [
    `You are an expert Warhammer 40,000 competitive meta analyst specialising in ${faction}.`,
    '',
    '=== ANALYSIS RULES — FOLLOW STRICTLY ===',
    '',
    'DATASET CONTEXT: This dataset contains ONLY top-finishing tournament lists (1st/2nd place).',
    'Win rates are inflated vs. general field. Do NOT reference win rate, win %, or wins/losses anywhere.',
    '',
    'RULE 1 — NO WIN RATES: All claims must be grounded in list count, unit inclusion rate, or co-occurrence.',
    '',
    `RULE 2 — detachmentSummaries: One entry per detachment listed. ≤${wDet} words each.`,
    'Cover: current archetypes present, which units are core (>60% inclusion), what is new or contested.',
    'Also include keyStrength (≤15 words) and keyWeakness (≤15 words) for each detachment.',
    '',
    'RULE 3 — listCharacterizations: One entry per list. listId = "playerName|event|date".',
    `gamePlan: ≤${wList} words describing how this list intends to play.`,
    'primaryThreat: one of "melee", "ranged", "attrition", "mixed".',
    'boardControl: one of "aggressive", "balanced", "defensive".',
    'keyRulesInteraction: ≤20 words naming the most important rule/stratagem synergy in this list.',
    'techDiffs: what this list does differently from others in the same detachment.',
    'If only 1 list exists for a detachment, techDiffs = "Only list for this detachment."',
    '',
    `RULE 4 — crossDetachmentPatterns: ≤${wCross} words. Discuss model count trends, indirect fire`,
    'prevalence, character density, and board-presence themes across all detachments in the data.',
    '',
    `RULE 5 — crawlDiff: ≤${wDiff} words. Summarise what is new since the previous crawl.`,
    'If crawlDiff data is null, set this field to null in your response.',
    '',
    'IMPORTANT: Respond with ONLY valid JSON. No markdown fences, no preamble, no trailing text.',
    'Start your response with { and end with }.',
  ].join('\n');

  const blocks = [];

  // Rules reference block — cached first (large, rarely changes)
  if (rulesText) {
    blocks.push({
      type: 'text',
      text: rulesText,
      cache_control: { type: 'ephemeral' },
    });
  }

  // Analysis instructions block — also cached (changes rarely)
  blocks.push({
    type: 'text',
    text: instructionsText,
    cache_control: { type: 'ephemeral' },
  });

  return blocks;
}

function buildUserPrompt(listsData, metaReport, optimizerReport) {
  const faction    = metaReport.meta?.faction   || 'Death Guard';
  const totalLists = metaReport.meta?.totalLists || 0;
  const detFreq    = optimizerReport?.detachmentFrequencyAnalysis || [];
  const crawlDiff  = metaReport.crawlDiff || null;
  const lists      = listsData ? flattenLists(listsData) : [];

  const lines = [];

  // Faction overview
  lines.push('=== FACTION DATA ===');
  lines.push(`Faction: ${faction}`);
  lines.push(`Total lists in dataset: ${totalLists}`);
  lines.push(`Data crawled: ${metaReport.meta?.crawledAt || 'unknown'}`);
  lines.push('');

  // Crawl diff
  if (crawlDiff) {
    lines.push('=== CRAWL DIFF ===');
    lines.push(`New lists since last crawl: ${(crawlDiff.newLists || []).length}`);
    lines.push(`Dropped lists: ${(crawlDiff.droppedLists || []).length}`);
    if ((crawlDiff.newTechChoices || []).length > 0) {
      lines.push(`New tech choices: ${crawlDiff.newTechChoices.slice(0, 10).join(', ')}`);
    }
    lines.push('');
  }

  // Detachment frequency
  if (detFreq.length > 0) {
    lines.push('=== DETACHMENT FREQUENCY ===');
    for (const det of detFreq) {
      lines.push(`${det.detachment} (${det.listCount} lists):`);
      for (const u of det.topUnits.slice(0, 8)) {
        lines.push(`  Unit: ${u.name} — ${u.count}x (${u.frequency}%)`);
      }
      for (const e of det.topEnhancements.slice(0, 4)) {
        lines.push(`  Enhancement: ${e.name} — ${e.count}x (${e.frequency}%)`);
      }
      lines.push('');
    }
  }

  // List texts (truncated to 400 chars each)
  if (lists.length > 0) {
    lines.push('=== LIST TEXTS (truncated to 400 chars) ===');
    for (const list of lists) {
      const listId = `${list.playerName || list.player || ''}|${list.event || ''}|${list.date || ''}`;
      const text = (list.armyListText || '').slice(0, 400);
      lines.push(`[${listId}]`);
      lines.push(text || '(no list text)');
      lines.push('');
    }
  }

  // Output schema
  const listIds = lists.map((l) =>
    `${l.playerName || l.player || ''}|${l.event || ''}|${l.date || ''}`
  );
  const detachmentNames = detFreq.length > 0
    ? detFreq.map((d) => d.detachment)
    : (metaReport.detachmentBreakdown || [])
        .filter((d) => d.detachment !== 'Unknown')
        .map((d) => d.detachment);

  const wList  = outputLimits.wordsPerList;
  const wDet   = outputLimits.wordsPerDetachmentSummary;
  const wCross = outputLimits.wordsCrossDetachment;
  const wDiff  = outputLimits.wordsCrawlDiff;
  lines.push('=== REQUIRED OUTPUT SCHEMA ===');
  lines.push(JSON.stringify({
    detachmentSummaries: detachmentNames.map((d) => ({
      detachment: d,
      summary: `<≤${wDet} words: archetypes present, core units (>60%), new or contested picks>`,
      keyStrength: '<≤15 words: primary competitive strength>',
      keyWeakness: '<≤15 words: primary competitive weakness>',
    })),
    listCharacterizations: listIds.map((id) => ({
      listId: id,
      archetype: '<short label e.g. "Daemon Prince spam">',
      gamePlan: `<≤${wList} words: how this list plays>`,
      primaryThreat: '<melee|ranged|attrition|mixed>',
      boardControl: '<aggressive|balanced|defensive>',
      keyRulesInteraction: '<≤20 words: most important rule/stratagem synergy>',
      keySynergies: '<brief: 1-2 key unit interactions>',
      techDiffs: '<what differs from other lists in same detachment>',
    })),
    crossDetachmentPatterns: `<≤${wCross} words: model count, indirect fire, character density trends>`,
    crawlDiff: crawlDiff ? `<≤${wDiff} words: what changed since last crawl>` : null,
  }, null, 2));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON extractor (unchanged — battle-tested)
// ---------------------------------------------------------------------------

function extractJSON(raw) {
  const trimmed = raw.trim();

  // 1. Bare parse (ideal)
  try { return JSON.parse(trimmed); } catch {}

  // 2. Markdown fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // 3. Outermost { … }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace  = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch {}
  }

  return null;
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

function renderText(result) {
  const hr  = '='.repeat(74);
  const hr2 = '-'.repeat(74);
  const lines = [];

  lines.push(hr);
  lines.push(`  ${result.faction || 'ARMY'} — AI META ANALYSIS`);
  lines.push(hr);
  lines.push(`  Generated by: ${result.model || 'Claude AI'}`);
  lines.push(`  Timestamp:    ${result.generatedAt || new Date().toISOString()}`);
  if (result.inputTokens !== undefined) {
    lines.push(`  Tokens — input: ${result.inputTokens}, output: ${result.outputTokens}, ` +
      `cache_creation: ${result.cacheCreationTokens}, cache_read: ${result.cacheReadTokens}`);
  }
  lines.push('');

  // Detachment summaries
  if (result.detachmentSummaries?.length > 0) {
    lines.push(hr2);
    lines.push('  DETACHMENT SUMMARIES');
    lines.push(hr2);
    for (const ds of result.detachmentSummaries) {
      lines.push('');
      lines.push(`  [${ds.detachment}]`);
      for (const p of (ds.summary || '').split('\n')) lines.push(`  ${p}`);
      if (ds.keyStrength)  lines.push(`  + Strength: ${ds.keyStrength}`);
      if (ds.keyWeakness)  lines.push(`  - Weakness: ${ds.keyWeakness}`);
    }
    lines.push('');
  }

  // Cross-detachment patterns
  if (result.crossDetachmentPatterns) {
    lines.push(hr2);
    lines.push('  CROSS-DETACHMENT PATTERNS');
    lines.push(hr2);
    lines.push('');
    for (const p of result.crossDetachmentPatterns.split('\n')) lines.push(`  ${p}`);
    lines.push('');
  }

  // Crawl diff summary
  if (result.crawlDiff) {
    lines.push(hr2);
    lines.push('  SINCE LAST CRAWL');
    lines.push(hr2);
    lines.push('');
    for (const p of result.crawlDiff.split('\n')) lines.push(`  ${p}`);
    lines.push('');
  }

  // List characterizations (first 5 shown)
  if (result.listCharacterizations?.length > 0) {
    lines.push(hr2);
    lines.push('  LIST CHARACTERIZATIONS (sample)');
    lines.push(hr2);
    for (const lc of result.listCharacterizations.slice(0, 5)) {
      lines.push('');
      lines.push(`  [${lc.listId}]`);
      lines.push(`  Archetype:  ${lc.archetype}`);
      if (lc.gamePlan)            lines.push(`  Game Plan:  ${lc.gamePlan}`);
      if (lc.primaryThreat)       lines.push(`  Threat:     ${lc.primaryThreat}`);
      if (lc.boardControl)        lines.push(`  Board:      ${lc.boardControl}`);
      if (lc.keyRulesInteraction) lines.push(`  Key Rule:   ${lc.keyRulesInteraction}`);
      if (lc.keySynergies)        lines.push(`  Synergies:  ${lc.keySynergies}`);
      if (lc.techDiffs)           lines.push(`  Tech diffs: ${lc.techDiffs}`);
    }
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
  const listsData       = readJSON(listsFile);

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

  const client  = new Anthropic({ apiKey, maxRetries: 4 });
  const faction = metaReport.meta?.faction || 'Death Guard';

  // Try focused rules context from enriched data first, fall back to full TXT
  const detFreq = optimizerReport?.detachmentFrequencyAnalysis || [];
  const detachmentNames = detFreq.length > 0
    ? detFreq.map((d) => d.detachment)
    : (metaReport.detachmentBreakdown || [])
        .filter((d) => d.detachment !== 'Unknown')
        .map((d) => d.detachment);
  const unitNames = (optimizerReport?.unitAnalysis?.units || []).map((u) => u.name);

  const enrichedPath = enrichedFile;
  let rulesText = buildFocusedRulesContext(enrichedPath, detachmentNames, unitNames);
  if (!rulesText) {
    console.log('Enriched rules not available — falling back to full rules TXT.');
    rulesText = loadRulesDocument(rulesDir);
  }

  const systemBlocks   = buildSystemPromptBlocks(faction, rulesText);
  const userPrompt     = buildUserPrompt(listsData || { sections: {} }, metaReport, optimizerReport);

  console.log(`Sending request to ${modelId} (max_tokens: ${maxTokens})…`);
  console.log(`Data: ${metaReport.meta?.totalLists || 0} lists, ${(metaReport.detachmentBreakdown || []).length} detachments`);
  console.log(`System prompt blocks: ${systemBlocks.length} (rules: ${rulesText ? 'yes' : 'no'}, source: ${rulesText && rulesText.startsWith('=== FACTION RULES') ? 'enriched' : 'txt'})`);

  // Helper to make one API call
  async function callAPI() {
    return client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      system: systemBlocks,
      messages: [{ role: 'user', content: userPrompt }],
    });
  }

  let message;
  try {
    message = await callAPI();
  } catch (err) {
    console.error('Anthropic API call failed:', err.message);
    writeOutput(emptyResult(faction, `API error: ${err.message}`), `AI analysis failed: ${err.message}\n`);
    process.exit(0);
  }

  const rawContent = message.content.find((b) => b.type === 'text')?.text || '';
  const usage = { ...message.usage };

  console.log(`Response: ${rawContent.length} chars, stop_reason: ${message.stop_reason}`);
  console.log(`Tokens — input: ${usage.input_tokens}, output: ${usage.output_tokens}, ` +
    `cache_creation: ${usage.cache_creation_input_tokens || 0}, cache_read: ${usage.cache_read_input_tokens || 0}`);

  if (message.stop_reason === 'max_tokens') {
    console.warn('WARNING: Response was cut off at max_tokens limit — JSON may be truncated.');
  }

  let result = extractJSON(rawContent);

  // Retry with a higher token limit when the response was truncated
  if (!result && message.stop_reason === 'max_tokens') {
    const bumpedTokens = Math.ceil(maxTokens * 1.5);
    console.warn(`Response truncated — retrying with max_tokens=${bumpedTokens}…`);
    try {
      const retry = await client.messages.create({
        model: modelId,
        max_tokens: bumpedTokens,
        system: systemBlocks,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const retryContent = retry.content.find((b) => b.type === 'text')?.text || '';
      result = extractJSON(retryContent);
      if (retry.usage) {
        usage.input_tokens                = (usage.input_tokens                || 0) + (retry.usage.input_tokens                || 0);
        usage.output_tokens               = (usage.output_tokens               || 0) + (retry.usage.output_tokens               || 0);
        usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens || 0) + (retry.usage.cache_creation_input_tokens || 0);
        usage.cache_read_input_tokens     = (usage.cache_read_input_tokens     || 0) + (retry.usage.cache_read_input_tokens     || 0);
      }
    } catch (retryErr) {
      console.error('Truncation retry failed:', retryErr.message);
    }
  }

  // Retry once on parse failure (non-truncation cases)
  if (!result) {
    console.warn('Failed to parse response as JSON. Retrying once…');
    try {
      const retry = await callAPI();
      const retryContent = retry.content.find((b) => b.type === 'text')?.text || '';
      result = extractJSON(retryContent);
      // Accumulate token usage across both calls
      if (retry.usage) {
        usage.input_tokens             = (usage.input_tokens             || 0) + (retry.usage.input_tokens             || 0);
        usage.output_tokens            = (usage.output_tokens            || 0) + (retry.usage.output_tokens            || 0);
        usage.cache_creation_input_tokens = (usage.cache_creation_input_tokens || 0) + (retry.usage.cache_creation_input_tokens || 0);
        usage.cache_read_input_tokens  = (usage.cache_read_input_tokens  || 0) + (retry.usage.cache_read_input_tokens  || 0);
      }
    } catch (retryErr) {
      console.error('Retry failed:', retryErr.message);
    }
  }

  if (!result) {
    console.error('Failed to parse AI response as JSON after retry.');
    console.error('Raw — first 500 chars:', rawContent.slice(0, 500));
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

  // Ensure required top-level fields
  result.generatedAt         = result.generatedAt || new Date().toISOString();
  result.model               = result.model       || modelId;
  result.faction             = result.faction     || faction;
  result.inputTokens         = usage.input_tokens                    || 0;
  result.outputTokens        = usage.output_tokens                   || 0;
  result.cacheCreationTokens = usage.cache_creation_input_tokens     || 0;
  result.cacheReadTokens     = usage.cache_read_input_tokens         || 0;

  const textOutput = renderText(result);
  console.log('\n' + textOutput);
  writeOutput(result, textOutput);

  console.log(`\nToken usage — input: ${result.inputTokens}, output: ${result.outputTokens}, ` +
    `cache_creation: ${result.cacheCreationTokens}, cache_read: ${result.cacheReadTokens}`);
  console.log(`AI analysis saved to ${path.join(outputDir, 'ai-analysis-latest.json')}`);
}

main().catch((err) => {
  console.error('Unhandled error in ai-analysis.js:', err);
  process.exit(0); // Always exit 0 so the pipeline continues
});
