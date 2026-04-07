/**
 * ai-analysis.js
 *
 * Generates an AI-powered Death Guard meta analysis using Claude via the
 * Anthropic SDK. Reads the crawled army lists, meta report, and optimizer
 * output, then asks Claude to produce:
 *
 *   - A concise meta summary
 *   - A detachment tier list (S / A / B) with reasoning
 *   - "Best list" breakdown — which units/synergies make it dominant
 *   - Strategic advice for playing Death Guard competitively
 *
 * Output: reports/ai-analysis-latest.json  (+ timestamped copy)
 *         reports/ai-analysis-latest.txt   (+ timestamped copy)
 *
 * The script exits with code 0 even if the API key is missing, so the
 * GitHub Actions pipeline is never blocked by this step.
 *
 * Usage:
 *   node ai-analysis.js
 *   node ai-analysis.js --lists ./output/army-lists-latest.json
 *   node ai-analysis.js --report ./reports/meta-report-latest.json
 *   node ai-analysis.js --optimizer ./reports/optimizer-latest.json
 *   node ai-analysis.js --output ./reports
 *   node ai-analysis.js --model claude-haiku-4-5-20251001
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const listsFile    = getArg('--lists')     || path.join(__dirname, 'output',  'army-lists-latest.json');
const reportFile   = getArg('--report')    || path.join(__dirname, 'reports', 'meta-report-latest.json');
const optimFile    = getArg('--optimizer') || path.join(__dirname, 'reports', 'optimizer-latest.json');
const outputDir    = getArg('--output')    || path.join(__dirname, 'reports');
const modelId      = getArg('--model')     || 'claude-sonnet-4-6';
const maxTokens    = parseInt(getArg('--max-tokens') || '4096', 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeOutput(result, text) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  fs.writeFileSync(path.join(outputDir, `ai-analysis-${ts}.json`), JSON.stringify(result, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'ai-analysis-latest.json'), JSON.stringify(result, null, 2), 'utf-8');

  fs.writeFileSync(path.join(outputDir, `ai-analysis-${ts}.txt`), text, 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'ai-analysis-latest.txt'), text, 'utf-8');
}

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Build the prompt from available data
// ---------------------------------------------------------------------------

function buildPrompt(metaReport, optimizerReport) {
  const faction = (metaReport.meta && metaReport.meta.faction) || 'Death Guard';
  const totalLists = (metaReport.meta && metaReport.meta.totalLists) || 0;
  const detachments = (metaReport.detachmentBreakdown || []).filter(d => d.detachment !== 'Unknown');
  const topPlayers = (metaReport.topPlayers || []).slice(0, 10);
  const undefeated = (metaReport.undefeatedLists || []);
  const events = (metaReport.eventBreakdown || []).slice(0, 10);

  const unitAnalysis = optimizerReport && optimizerReport.unitAnalysis
    ? optimizerReport.unitAnalysis.units || []
    : [];
  const enhancements = optimizerReport && optimizerReport.enhancementAnalysis
    ? optimizerReport.enhancementAnalysis.enhancements || []
    : [];
  const coOccurrence = (optimizerReport && optimizerReport.coOccurrence) || [];
  const concreteList = (optimizerReport && optimizerReport.concreteList) || null;

  const lines = [];

  lines.push(`You are an expert Warhammer 40,000 competitive meta analyst specialising in ${faction}.`);
  lines.push(`You have been given tournament data scraped from Listhammer.info. Analyse the data and produce an extensive, expert-level meta report.`);
  lines.push('');
  lines.push('=== TOURNAMENT DATA ===');
  lines.push('');
  lines.push(`Faction: ${faction}`);
  lines.push(`Total tournament lists analysed: ${totalLists}`);
  lines.push(`Undefeated finishes: ${undefeated.length}`);
  if (metaReport.meta && metaReport.meta.crawledAt) {
    lines.push(`Data crawled: ${metaReport.meta.crawledAt}`);
  }
  lines.push('');

  // Detachments
  if (detachments.length > 0) {
    lines.push('--- DETACHMENT BREAKDOWN ---');
    for (const d of detachments) {
      const wr = d.winRate != null ? `${d.winRate}% win rate` : 'win rate N/A';
      lines.push(`  ${d.detachment}: ${d.count} lists (${d.percentage}%), ${wr}, ${d.undefeatedCount} undefeated finishes`);
    }
    lines.push('');
  }

  // Top units
  const topUnits = unitAnalysis.filter(u => u.appearances > 0).slice(0, 20);
  if (topUnits.length > 0) {
    lines.push('--- TOP UNITS (by appearance frequency in tournament lists) ---');
    for (const u of topUnits) {
      lines.push(`  ${u.name}: ${u.frequency}% lists, win correlation ${u.winCorrelation}%, ~${u.typicalPoints}pts, avg copies per list: ${u.avgCopies}`);
    }
    lines.push('');
  }

  // Enhancements
  if (enhancements.length > 0) {
    lines.push('--- TOP ENHANCEMENTS ---');
    for (const e of enhancements.slice(0, 8)) {
      lines.push(`  ${e.name}: ${e.frequency}% usage (${e.appearances} times)`);
    }
    lines.push('');
  }

  // Co-occurrences (synergies)
  if (coOccurrence.length > 0) {
    lines.push('--- UNIT SYNERGIES (most common pairings in winning lists) ---');
    for (const c of coOccurrence.slice(0, 10)) {
      lines.push(`  ${c.pair}: appeared together ${c.count}x (${c.frequency}% of lists)`);
    }
    lines.push('');
  }

  // Top players
  if (topPlayers.length > 0) {
    lines.push('--- TOP PLAYERS ---');
    for (const p of topPlayers.slice(0, 8)) {
      lines.push(`  ${p.player}: ${p.wins}W-${p.losses}L (${p.winRate}% WR), detachments: ${(p.detachments || []).join(', ')}`);
    }
    lines.push('');
  }

  // Undefeated lists
  if (undefeated.length > 0) {
    lines.push('--- UNDEFEATED LISTS ---');
    for (const u of undefeated.slice(0, 10)) {
      lines.push(`  ${u.player} — ${u.record} — ${u.detachment} — ${u.event}`);
    }
    lines.push('');
  }

  // Recommended list from optimizer
  if (concreteList && concreteList.units && concreteList.units.length > 0) {
    lines.push('--- OPTIMIZER RECOMMENDED LIST ---');
    lines.push(`  Detachment: ${concreteList.detachment}`);
    lines.push(`  Total points: ${concreteList.totalPoints}pts`);
    if (concreteList.warlord) lines.push(`  Warlord: ${concreteList.warlord}`);
    if (concreteList.enhancements && concreteList.enhancements.length > 0) {
      lines.push(`  Enhancements: ${concreteList.enhancements.join(', ')}`);
    }
    lines.push('  Units:');
    for (const u of concreteList.units) {
      lines.push(`    ${u.name} — ${u.points}pts (${u.metaFrequency}% meta, tier: ${u.tier})`);
    }
    lines.push('');
  }

  lines.push('=== END DATA ===');
  lines.push('');
  lines.push('Please produce a comprehensive Death Guard meta analysis report with the following sections. Be detailed, specific, and authoritative. Reference the actual data provided.');
  lines.push('');
  lines.push('Your response MUST be valid JSON with this exact structure:');
  lines.push('```json');
  lines.push(JSON.stringify({
    generatedAt: '<ISO timestamp>',
    model: '<model used>',
    faction: faction,
    metaSummary: '<2-4 paragraph narrative overview of the current Death Guard meta, referencing key statistics>',
    detachmentTierList: [
      {
        tier: 'S',
        detachment: '<name>',
        reasoning: '<why this tier>',
        winRate: '<percentage>',
        listCount: '<number>',
        undefeated: '<number>',
      }
    ],
    bestListAnalysis: {
      detachment: '<recommended detachment name>',
      overview: '<2-3 paragraph analysis of why this is the best list archetype>',
      keyUnits: [
        { name: '<unit>', role: '<why it is key to the list>', frequency: '<meta %>'}
      ],
      keySynergies: [
        { units: '<unit1 + unit2>', explanation: '<why these work together>'}
      ],
      enhancements: '<which enhancements to run and why>',
      fullRecommendedList: '<full list at 2000pts with unit names and points, formatted as a roster>',
    },
    strategicAdvice: {
      overview: '<paragraph on how to play Death Guard in the current meta>',
      tips: ['<specific actionable tip>', '<tip>', '<tip>', '<tip>', '<tip>'],
      matchupAdvice: '<paragraph on favourable/unfavourable matchups and how to approach them>',
    },
    metaTrends: '<paragraph on emerging trends, what is rising/falling in popularity, what to expect next>',
  }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('Respond with ONLY the JSON object — no markdown fences, no preamble, no text outside the JSON.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Render plain text from the AI result
// ---------------------------------------------------------------------------

function renderText(result) {
  const hr = '='.repeat(74);
  const hr2 = '-'.repeat(74);
  const lines = [];

  lines.push(hr);
  lines.push(`  ${result.faction || 'DEATH GUARD'} — AI META ANALYSIS`);
  lines.push(hr);
  lines.push(`  Generated by: ${result.model || 'Claude AI'}`);
  lines.push(`  Timestamp:    ${result.generatedAt || new Date().toISOString()}`);
  lines.push('');

  if (result.metaSummary) {
    lines.push(hr2);
    lines.push('  META SUMMARY');
    lines.push(hr2);
    lines.push('');
    for (const para of result.metaSummary.split('\n')) {
      lines.push(`  ${para}`);
    }
    lines.push('');
  }

  if (result.detachmentTierList && result.detachmentTierList.length > 0) {
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
    for (const para of (bla.overview || '').split('\n')) {
      lines.push(`  ${para}`);
    }
    lines.push('');

    if (bla.keyUnits && bla.keyUnits.length > 0) {
      lines.push('  Key Units:');
      for (const u of bla.keyUnits) {
        lines.push(`    ${u.name.padEnd(35)} [${u.frequency}] — ${u.role}`);
      }
      lines.push('');
    }

    if (bla.keySynergies && bla.keySynergies.length > 0) {
      lines.push('  Key Synergies:');
      for (const s of bla.keySynergies) {
        lines.push(`    ${s.units}`);
        lines.push(`      ${s.explanation}`);
      }
      lines.push('');
    }

    if (bla.enhancements) {
      lines.push(`  Enhancements: ${bla.enhancements}`);
      lines.push('');
    }

    if (bla.fullRecommendedList) {
      lines.push('  Recommended Army List:');
      for (const line of bla.fullRecommendedList.split('\n')) {
        lines.push(`    ${line}`);
      }
      lines.push('');
    }
  }

  if (result.strategicAdvice) {
    const sa = result.strategicAdvice;
    lines.push(hr2);
    lines.push('  STRATEGIC ADVICE');
    lines.push(hr2);
    lines.push('');
    if (sa.overview) {
      for (const para of sa.overview.split('\n')) {
        lines.push(`  ${para}`);
      }
      lines.push('');
    }
    if (sa.tips && sa.tips.length > 0) {
      lines.push('  Tips:');
      for (const tip of sa.tips) {
        lines.push(`    • ${tip}`);
      }
      lines.push('');
    }
    if (sa.matchupAdvice) {
      lines.push('  Matchup Advice:');
      for (const para of sa.matchupAdvice.split('\n')) {
        lines.push(`    ${para}`);
      }
      lines.push('');
    }
  }

  if (result.metaTrends) {
    lines.push(hr2);
    lines.push('  META TRENDS');
    lines.push(hr2);
    lines.push('');
    for (const para of result.metaTrends.split('\n')) {
      lines.push(`  ${para}`);
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
    const empty = {
      generatedAt: new Date().toISOString(),
      model: null,
      faction: 'Death Guard',
      skipped: true,
      reason: 'ANTHROPIC_API_KEY not set',
      metaSummary: null,
      detachmentTierList: [],
      bestListAnalysis: null,
      strategicAdvice: null,
      metaTrends: null,
    };
    writeOutput(empty, 'AI analysis skipped: ANTHROPIC_API_KEY not set.\n');
    process.exit(0);
  }

  const metaReport = readJSON(reportFile);
  const optimizerReport = readJSON(optimFile);

  if (!metaReport) {
    console.warn(`Meta report not found at ${reportFile}. Writing empty placeholder.`);
    const empty = {
      generatedAt: new Date().toISOString(),
      model: null,
      faction: 'Death Guard',
      skipped: true,
      reason: 'Meta report not found',
      metaSummary: null,
      detachmentTierList: [],
      bestListAnalysis: null,
      strategicAdvice: null,
      metaTrends: null,
    };
    writeOutput(empty, 'AI analysis skipped: meta report not found.\n');
    process.exit(0);
  }

  if (metaReport.meta && metaReport.meta.totalLists === 0) {
    console.warn('No army lists in meta report. Writing empty placeholder.');
    const empty = {
      generatedAt: new Date().toISOString(),
      model: null,
      faction: (metaReport.meta && metaReport.meta.faction) || 'Death Guard',
      skipped: true,
      reason: 'No army lists found in meta report',
      metaSummary: null,
      detachmentTierList: [],
      bestListAnalysis: null,
      strategicAdvice: null,
      metaTrends: null,
    };
    writeOutput(empty, 'AI analysis skipped: no army lists found.\n');
    process.exit(0);
  }

  // Dynamically require the SDK so the script still runs (and exits 0)
  // even if npm install hasn't been run yet in development.
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (err) {
    console.error('Could not load @anthropic-ai/sdk. Run "npm install" first.');
    console.error(err.message);
    const empty = {
      generatedAt: new Date().toISOString(),
      model: null,
      faction: (metaReport.meta && metaReport.meta.faction) || 'Death Guard',
      skipped: true,
      reason: '@anthropic-ai/sdk not installed',
      metaSummary: null,
      detachmentTierList: [],
      bestListAnalysis: null,
      strategicAdvice: null,
      metaTrends: null,
    };
    writeOutput(empty, 'AI analysis skipped: @anthropic-ai/sdk not installed.\n');
    process.exit(0);
  }

  const client = new Anthropic({ apiKey });
  const prompt = buildPrompt(metaReport, optimizerReport);

  console.log(`Sending prompt to ${modelId} (max_tokens: ${maxTokens})…`);
  console.log(`Data: ${(metaReport.meta && metaReport.meta.totalLists) || 0} lists, ${(metaReport.detachmentBreakdown || []).length} detachments`);

  let rawContent;
  try {
    const message = await client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });
    rawContent = message.content[0].text;
    console.log(`Claude responded (${rawContent.length} chars).`);
  } catch (err) {
    console.error('Anthropic API call failed:', err.message);
    const empty = {
      generatedAt: new Date().toISOString(),
      model: modelId,
      faction: (metaReport.meta && metaReport.meta.faction) || 'Death Guard',
      skipped: true,
      reason: `API error: ${err.message}`,
      metaSummary: null,
      detachmentTierList: [],
      bestListAnalysis: null,
      strategicAdvice: null,
      metaTrends: null,
    };
    writeOutput(empty, `AI analysis failed: ${err.message}\n`);
    process.exit(0);
  }

  // Strip markdown fences if Claude wrapped the JSON anyway
  let jsonStr = rawContent.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let result;
  try {
    result = JSON.parse(jsonStr);
  } catch (err) {
    console.error('Failed to parse Claude response as JSON:', err.message);
    console.error('Raw response (first 500 chars):', rawContent.slice(0, 500));
    // Store the raw text under metaSummary so it still appears in the UI
    result = {
      generatedAt: new Date().toISOString(),
      model: modelId,
      faction: (metaReport.meta && metaReport.meta.faction) || 'Death Guard',
      parseError: true,
      metaSummary: rawContent,
      detachmentTierList: [],
      bestListAnalysis: null,
      strategicAdvice: null,
      metaTrends: null,
    };
  }

  // Stamp metadata
  result.generatedAt = result.generatedAt || new Date().toISOString();
  result.model = result.model || modelId;

  const textOutput = renderText(result);
  console.log('\n' + textOutput);
  writeOutput(result, textOutput);
  console.log(`\nAI analysis saved to ${path.join(outputDir, 'ai-analysis-latest.json')}`);
}

main().catch(err => {
  console.error('Unhandled error in ai-analysis.js:', err);
  process.exit(0); // Always exit 0 so the pipeline continues
});
