/**
 * enrich-rules.js
 *
 * Cross-references rules JSON with optimizer output to produce a unified
 * enriched-rules.json. Contains:
 *   - Structured detachment objects (ability + stratagems[] + enhancements[])
 *   - Per-unit meta stats merged with rules data (keywords, abilities)
 *   - Units that exist in rules but have never appeared in tournament data
 *
 * Usage:
 *   node enrich-rules.js
 *   node enrich-rules.js --rules ./rules/death-guard-latest.json
 *   node enrich-rules.js --optimizer ./reports/optimizer-latest.json
 *   node enrich-rules.js --output ./reports
 *   node enrich-rules.js --dry-run
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { getArg } = require('./utils');

const args = process.argv.slice(2);

const rulesFile = getArg(args, '--rules')     || path.join(__dirname, 'rules', 'death-guard-latest.json');
const optimFile = getArg(args, '--optimizer') || path.join(__dirname, 'reports', 'optimizer-latest.json');
const outputDir = getArg(args, '--output')    || path.join(__dirname, 'reports');
const dryRun    = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch (err) { console.warn(`Failed to parse JSON ${filePath}: ${err.message}`); return null; }
}

/**
 * Normalise a unit name for matching: lowercase, collapse whitespace,
 * strip common suffixes/prefixes that differ between list text and rules.
 */
function normaliseName(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Try to find a matching rules unit for a given optimizer unit name.
 * Returns the rules unit object or null.
 */
function findRulesUnit(optimName, rulesUnits, nameMap) {
  const normalised = normaliseName(optimName);

  // 1. Exact match
  if (nameMap[normalised]) return nameMap[normalised];

  // 2. Try stripping trailing x-count patterns like "x2", "x3"
  const stripped = normalised.replace(/\s*x\d+$/, '');
  if (stripped !== normalised && nameMap[stripped]) return nameMap[stripped];

  // 3. Try substring match: optimizer name contained in rules name or vice versa
  for (const unit of rulesUnits) {
    const rn = normaliseName(unit.name);
    if (rn.includes(normalised) || normalised.includes(rn)) return unit;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Detachment parser (same logic as template.html, server-side version)
// ---------------------------------------------------------------------------

function parseDetachments(factionAbilities) {
  if (!factionAbilities || factionAbilities.length === 0) return [];

  const skipNames = new Set([
    "NURGLE'S GIFT (AURA)", 'PACT OF DECAY', 'SPAWNDOM', 'A GRAND PLAGUE',
    'ALCHEMICAL PATHOGENS', 'BATTLE TRAITS', 'AGENDAS', 'REQUISITIONS',
    'CRUSADE RELICS', 'ARTIFICER RELICS', 'ANTIQUITY RELICS', 'LEGENDARY RELICS',
    'CRUSADE BADGES', 'PLAGUE CHAMPION', 'CHOSEN OF NURGLE', 'DISEASED DAEMON LORD',
    'BOARDING ACTIONS', 'INTRODUCTION', 'FORMING BOARDING SQUADS',
    'PRIVACY PREFERENCES',
  ]);

  const detachments = [];
  let i = 0;

  while (i < factionAbilities.length) {
    const entry = factionAbilities[i];

    if (skipNames.has(entry.name) ||
        entry.name === 'ENHANCEMENTS' || entry.name === 'STRATAGEMS' ||
        entry.name === 'DETACHMENT RULE' || entry.name === 'RULES ADAPTATIONS') {
      i++;
      continue;
    }

    // This is a detachment ability entry
    const abilityName = entry.name;
    const abilityDesc = entry.description;
    const enhancements = [];
    const stratagems = [];
    let detName = null;

    let j = i + 1;
    while (j < factionAbilities.length && j <= i + 4) {
      const next = factionAbilities[j];

      if (next.name === 'ENHANCEMENTS') {
        const enhMatch = next.description.match(/^(.+)\n(\d+)\s*pts/);
        if (enhMatch) {
          enhancements.push({ name: enhMatch[1].trim(), pts: parseInt(enhMatch[2], 10) });
        }
      } else if (next.name === 'STRATAGEMS') {
        const parts = next.description.split(/\n(?=[A-Z][A-Z '\u2019-]+\n\d+CP\n)/);
        for (const part of parts) {
          const lines = part.trim().split('\n');
          if (lines.length >= 3) {
            const sName = lines[0].trim();
            const sCp = lines[1].trim();
            const sTypeLine = lines[2].trim();
            const typeMatch = sTypeLine.match(/^(.+?)\s+[\u2013\u2014]\s+(.+)$/);
            if (typeMatch && !detName) detName = typeMatch[1].trim();
            const sType = typeMatch ? typeMatch[2].replace(/\s*STRATAGEM$/i, '').trim() : '';

            // Parse WHEN/TARGET/EFFECT from remaining lines
            const body = lines.slice(3).join('\n');
            const whenMatch = body.match(/WHEN:\s*(.+?)(?:\n|$)/);
            const targetMatch = body.match(/TARGET:\s*(.+?)(?:\n|$)/);

            stratagems.push({
              name: sName,
              cp: sCp,
              type: sType,
              when: whenMatch ? whenMatch[1].trim() : null,
              target: targetMatch ? targetMatch[1].trim() : null,
            });
          }
        }
        j++;
        break;
      } else if (next.name !== 'DETACHMENT RULE' && next.name !== abilityName) {
        break;
      }
      j++;
    }

    if (detName && stratagems.length > 0) {
      detachments.push({
        name: detName,
        abilityName,
        abilityDescription: abilityDesc,
        enhancements,
        stratagems,
      });
    }
    i = j;
    continue;
  }

  return detachments;
}

// ---------------------------------------------------------------------------
// Extract target keywords from stratagem TARGET text
// ---------------------------------------------------------------------------

function extractTargetKeywords(targetText) {
  if (!targetText) return [];
  const keywords = [];
  const kwPatterns = [
    'INFANTRY', 'VEHICLE', 'MONSTER', 'CHARACTER', 'TERMINATOR',
    'POXWALKERS', 'PLAGUE LEGIONS', 'BIOLOGUS PUTRIFIER',
    'NURGLINGS', 'DAEMON',
  ];
  for (const kw of kwPatterns) {
    if (targetText.toUpperCase().includes(kw)) keywords.push(kw);
  }
  return keywords;
}

// ---------------------------------------------------------------------------
// Main enrichment
// ---------------------------------------------------------------------------

function enrich(rules, optimizer) {
  const result = {
    generatedAt: new Date().toISOString(),
    faction: rules.faction || 'death-guard',
    edition: rules.edition || '10ed',
    detachments: [],
    units: [],
    unseenUnits: [],
  };

  // 1. Parse detachments from factionAbilities
  result.detachments = parseDetachments(rules.factionAbilities || []);

  // Add target keywords to each stratagem
  for (const det of result.detachments) {
    for (const strat of det.stratagems) {
      strat.targetKeywords = extractTargetKeywords(strat.target);
    }
  }

  // 2. Build name lookup from rules units (skip the "Datasheets" overview entry)
  const rulesUnits = (rules.units || []).filter((u) => u.name !== 'Datasheets');
  const nameMap = {};
  for (const unit of rulesUnits) {
    nameMap[normaliseName(unit.name)] = unit;
  }

  // 3. Get optimizer data
  const optimUnits = (optimizer && optimizer.unitAnalysis && optimizer.unitAnalysis.units) || [];
  const detFreq = (optimizer && optimizer.detachmentFrequencyAnalysis) || [];
  const coOcc = (optimizer && optimizer.coOccurrence) || [];
  const seenNames = new Set();

  // 4. Enrich each optimizer unit with rules data
  for (const ou of optimUnits) {
    const rulesUnit = findRulesUnit(ou.name, rulesUnits, nameMap);
    seenNames.add(normaliseName(ou.name));

    // Find which detachments use this unit
    const detachments = [];
    for (const df of detFreq) {
      const inDet = (df.topUnits || []).find((u) =>
        normaliseName(u.name) === normaliseName(ou.name)
      );
      if (inDet) {
        detachments.push({
          detachment: df.detachment,
          count: inDet.count,
          frequency: inDet.frequency,
        });
      }
    }

    // Find co-occurrence partners
    const partners = [];
    for (const c of coOcc) {
      const pair = (c.pair || '').toLowerCase();
      if (pair.includes(normaliseName(ou.name))) {
        // Extract the other unit from the pair
        const parts = (c.pair || '').split(/\s*\+\s*/);
        const other = parts.find((p) => normaliseName(p) !== normaliseName(ou.name));
        if (other) partners.push({ unit: other.trim(), count: c.count });
      }
    }

    result.units.push({
      name: ou.name,
      canonicalName: rulesUnit ? rulesUnit.name : null,
      keywords: rulesUnit ? (rulesUnit.keywords || []) : [],
      count: ou.appearances,
      frequency: ou.frequency,
      detachments,
      coOccurrencePartners: partners.slice(0, 5),
    });
  }

  // 5. Find units in rules that never appeared in tournament data
  for (const unit of rulesUnits) {
    const nn = normaliseName(unit.name);
    // Check if any seen name matches
    let seen = false;
    for (const sn of seenNames) {
      if (sn === nn || sn.includes(nn) || nn.includes(sn)) {
        seen = true;
        break;
      }
    }
    if (!seen) {
      result.unseenUnits.push({
        name: unit.name,
        keywords: unit.keywords || [],
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function main() {
  const rules = readJSON(rulesFile);
  if (!rules) {
    console.error(`Rules file not found: ${rulesFile}`);
    process.exit(1);
  }

  const optimizer = readJSON(optimFile);
  if (!optimizer) {
    console.warn(`Optimizer file not found at ${optimFile} — enriching with rules only (no meta stats).`);
  }

  const enriched = enrich(rules, optimizer);

  console.log(`Enriched: ${enriched.detachments.length} detachments, ` +
    `${enriched.units.length} tournament units, ${enriched.unseenUnits.length} unseen units`);

  for (const det of enriched.detachments) {
    console.log(`  ${det.name}: ${det.stratagems.length} stratagems, ${det.enhancements.length} enhancements`);
  }

  if (dryRun) {
    console.log('\nDry run — no files written.');
    return;
  }

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, 'enriched-rules-latest.json');
  fs.writeFileSync(outPath, JSON.stringify(enriched, null, 2), 'utf-8');
  console.log(`\nEnriched rules saved to ${outPath}`);
}

// Export for testing
module.exports = { enrich, parseDetachments, normaliseName, findRulesUnit, extractTargetKeywords };

if (require.main === module) {
  main();
}
