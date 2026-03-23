const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Copies report JSON files into docs/data/ so the GitHub Pages site can
// load them. Run after `npm run report` and `npm run optimize`.
//
// Usage:
//   node build-site.js
//   node build-site.js --reports-dir ./reports --docs-dir ./docs
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const reportsDir = getArg('--reports-dir') || path.join(__dirname, 'reports');
const docsDir = getArg('--docs-dir') || path.join(__dirname, 'docs');
const dataDir = path.join(docsDir, 'data');

// ---------------------------------------------------------------------------

function main() {
  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  let copied = 0;

  // Copy meta report
  const metaSrc = path.join(reportsDir, 'meta-report-latest.json');
  const metaDest = path.join(dataDir, 'meta-report.json');
  if (fs.existsSync(metaSrc)) {
    fs.copyFileSync(metaSrc, metaDest);
    console.log(`  Copied meta report -> ${path.relative(__dirname, metaDest)}`);
    copied++;
  } else {
    console.warn(`  Warning: ${metaSrc} not found — run "npm run report" first`);
  }

  // Copy optimizer report
  const optSrc = path.join(reportsDir, 'optimizer-latest.json');
  const optDest = path.join(dataDir, 'optimizer.json');
  if (fs.existsSync(optSrc)) {
    fs.copyFileSync(optSrc, optDest);
    console.log(`  Copied optimizer report -> ${path.relative(__dirname, optDest)}`);
    copied++;
  } else {
    console.warn(`  Warning: ${optSrc} not found — run "npm run optimize" first`);
  }

  if (copied === 0) {
    console.error('\nNo reports found to copy. Run the crawler, report, and optimizer first:');
    console.error('  npm run crawl && npm run report && npm run optimize');
    process.exit(1);
  }

  console.log(`\nSite data built (${copied} file${copied > 1 ? 's' : ''} copied to ${path.relative(__dirname, dataDir)}/)`);
  console.log('Open docs/index.html in a browser, or deploy to GitHub Pages.');
}

main();
