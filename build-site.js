const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Builds the GitHub Pages site by inlining report JSON directly into the
// HTML template. The result is a single self-contained index.html that
// works without a server and without separate data files.
//
// Also copies the raw JSON into docs/data/ as a fallback / for direct access.
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
const templatePath = path.join(docsDir, 'template.html');
const outputPath = path.join(docsDir, 'index.html');

// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Read template
  if (!fs.existsSync(templatePath)) {
    console.error(`Template not found: ${templatePath}`);
    process.exit(1);
  }
  let html = fs.readFileSync(templatePath, 'utf-8');

  let embedded = 0;

  // Meta report
  const metaSrc = path.join(reportsDir, 'meta-report-latest.json');
  let metaJSON = 'null';
  if (fs.existsSync(metaSrc)) {
    metaJSON = fs.readFileSync(metaSrc, 'utf-8');
    fs.copyFileSync(metaSrc, path.join(dataDir, 'meta-report.json'));
    console.log('  Embedded meta report');
    embedded++;
  } else {
    console.warn('  Warning: meta report not found — run "npm run report" first');
  }

  // Optimizer report
  const optSrc = path.join(reportsDir, 'optimizer-latest.json');
  let optJSON = 'null';
  if (fs.existsSync(optSrc)) {
    optJSON = fs.readFileSync(optSrc, 'utf-8');
    fs.copyFileSync(optSrc, path.join(dataDir, 'optimizer.json'));
    console.log('  Embedded optimizer report');
    embedded++;
  } else {
    console.warn('  Warning: optimizer report not found — run "npm run optimize" first');
  }

  // Inject data into the template
  // The template uses the pattern: var X = /*__PLACEHOLDER__*/null;
  // We need to replace both the comment AND the trailing null to avoid syntax errors
  html = html.replace('/*__META_REPORT_DATA__*/null', metaJSON);
  html = html.replace('/*__OPTIMIZER_DATA__*/null', optJSON);

  fs.writeFileSync(outputPath, html, 'utf-8');

  if (embedded === 0) {
    console.warn('\nNo reports found — site will show empty state.');
  }

  console.log(`\nSite built -> ${path.relative(__dirname, outputPath)} (${embedded} report${embedded > 1 ? 's' : ''} inlined)`);
  console.log('Deploy docs/ to GitHub Pages, or open index.html in a browser.');
}

main();
