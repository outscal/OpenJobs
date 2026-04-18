// merge-probe-hits.mjs — add ats_links to data/companies_v2.json based on probe-ats.mjs output.
//
// Takes the CSV emitted by probe-ats.mjs (output/ats-probe-*.csv), reconstructs
// the canonical public career-URL for each (company, matched_ats, slug) triple,
// finds the company by name in companies_v2.json, and appends the URL to its
// ats_links array (if not already present). These new ats_links let harvest.mjs
// route the company to the right adapter on subsequent runs — growing the
// reachable set.
//
// Defaults to dry-run with --min-jobs 1 (skips zero-job boards by default).
// Pass --write to actually modify companies_v2.json. A backup copy is always
// written before the source is modified.
//
// Usage:
//   node merge-probe-hits.mjs --csv output/ats-probe-2026-04-18-off200.csv
//   node merge-probe-hits.mjs --csv output/ats-probe-*.csv --min-jobs 0  (include zero-job)
//   node merge-probe-hits.mjs --csv output/ats-probe-*.csv --write       (apply changes)

import fs from 'node:fs';
import path from 'node:path';

// URL templates — public-facing career URLs, formatted to match each adapter's
// detect() regex. Verified against adapters/{ats}.mjs HOST_PATTERNS.
const URL_TEMPLATE = {
  greenhouse:      s => `https://boards.greenhouse.io/${s}`,
  lever:           s => `https://jobs.lever.co/${s}`,
  ashby:           s => `https://jobs.ashbyhq.com/${s}`,
  smartrecruiters: s => `https://jobs.smartrecruiters.com/${s}`,
  recruitee:       s => `https://${s}.recruitee.com/`,
  breezy:          s => `https://${s}.breezy.hr/`,
  bamboohr:        s => `https://${s}.bamboohr.com/jobs/`,
  personio:        s => `https://${s}.jobs.personio.com/`,
  workable:        s => `https://apply.workable.com/${s}/`,
};

function parseArgs(argv) {
  const out = { csv: null, companies: 'data/companies_v2.json', minJobs: 1, write: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') out.csv = argv[++i];
    else if (a === '--companies') out.companies = argv[++i];
    else if (a === '--min-jobs') out.minJobs = Number(argv[++i]);
    else if (a === '--write') out.write = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node merge-probe-hits.mjs --csv <path> [--min-jobs N] [--companies PATH] [--write]');
      process.exit(0);
    }
  }
  if (!out.csv) {
    console.error('[fatal] --csv <path> is required');
    process.exit(1);
  }
  return out;
}

function parseCsvLine(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (const ch of line + ',') {
    if (inQ) { if (ch === '"') inQ = false; else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { cols.push(cur); cur = ''; }
    else cur += ch;
  }
  return cols;
}

function loadCsv(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8').split('\n').filter(l => l && l.includes(','));
  return raw.slice(1)  // skip header
    .map(parseCsvLine)
    .filter(r => r.length >= 5)
    .map(r => ({
      name: r[0],
      type: r[1],
      slug: r[2],
      ats:  r[3],
      jobs: Number(r[4] || 0),
      sample: r[5] || '',
    }));
}

function normalizeName(n) {
  return String(n || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function main() {
  const args = parseArgs(process.argv);

  const companiesPath = args.companies;
  if (!fs.existsSync(companiesPath)) {
    console.error(`[fatal] ${companiesPath} not found`);
    process.exit(1);
  }
  if (!fs.existsSync(args.csv)) {
    console.error(`[fatal] ${args.csv} not found`);
    process.exit(1);
  }

  console.log(`Reading CSV: ${args.csv}`);
  const hits = loadCsv(args.csv).filter(h => h.jobs >= args.minJobs && URL_TEMPLATE[h.ats]);
  console.log(`  ${hits.length} rows after filter (min-jobs >= ${args.minJobs}, known ATS)`);

  console.log(`Reading companies: ${companiesPath}`);
  const raw = JSON.parse(fs.readFileSync(companiesPath, 'utf8'));
  const companies = Array.isArray(raw) ? raw : (raw.companies || raw.data || []);
  console.log(`  ${companies.length} companies loaded`);

  // Build name → company index (case-insensitive, trimmed). If names collide,
  // the later entry wins — not ideal, but companies.json dedups on name anyway.
  const byName = new Map();
  for (const c of companies) byName.set(normalizeName(c.name), c);

  const stats = {
    planned: 0,
    alreadyPresent: 0,
    newlyAdded: 0,
    companyNotFound: 0,
    newlyRouted: 0,  // companies that had no ats_links before this merge
  };
  const touchedCompanies = new Set();
  const notFoundSamples = [];

  for (const h of hits) {
    stats.planned++;
    const c = byName.get(normalizeName(h.name));
    if (!c) {
      stats.companyNotFound++;
      if (notFoundSamples.length < 10) notFoundSamples.push(h.name);
      continue;
    }
    const url = URL_TEMPLATE[h.ats](h.slug);
    const existingLinks = Array.isArray(c.ats_links) ? c.ats_links : [];
    const hadLinksBefore = existingLinks.length > 0;
    if (existingLinks.some(u => String(u).toLowerCase() === url.toLowerCase())) {
      stats.alreadyPresent++;
      continue;
    }
    if (!Array.isArray(c.ats_links)) c.ats_links = [];
    c.ats_links.push(url);
    stats.newlyAdded++;
    if (!hadLinksBefore && !touchedCompanies.has(c.name)) stats.newlyRouted++;
    touchedCompanies.add(c.name);
  }

  console.log('');
  console.log('=== Merge summary ===');
  console.log(`  rows planned:                  ${stats.planned}`);
  console.log(`  URLs newly added:              ${stats.newlyAdded}`);
  console.log(`  URLs already present (skipped): ${stats.alreadyPresent}`);
  console.log(`  companies not found in JSON:   ${stats.companyNotFound}`);
  console.log(`  unique companies touched:      ${touchedCompanies.size}`);
  console.log(`  companies newly routable (had no ats_links before): ${stats.newlyRouted}`);

  if (notFoundSamples.length) {
    console.log('');
    console.log('  Sample of names not found in companies_v2.json:');
    notFoundSamples.forEach(n => console.log(`    - ${n}`));
  }

  if (!args.write) {
    console.log('');
    console.log('[dry-run] No files modified. Pass --write to apply.');
    return;
  }

  // Write: backup first, then overwrite.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = `${companiesPath}.backup-${stamp}`;
  fs.copyFileSync(companiesPath, backupPath);
  console.log(`\n  Backup written: ${backupPath}`);

  // Preserve original top-level shape (array vs wrapped object).
  const output = Array.isArray(raw) ? companies : { ...raw, companies };
  fs.writeFileSync(companiesPath, JSON.stringify(output, null, 2));
  console.log(`  Updated: ${companiesPath}`);
  console.log('\nDone.');
}

main();
