#!/usr/bin/env node
/**
 * harvest.mjs — Outscal jobs harvester (Tier 1: public ATS APIs)
 *
 * Reads data/companies_v2.json, routes each company to the right ATS adapter,
 * fetches live jobs, applies keyword + location filters from portals.yml,
 * and writes a CSV of matches to output/jobs-YYYY-MM-DD.csv.
 *
 * Usage:
 *   node harvest.mjs                        # full run, all ATSes
 *   node harvest.mjs --dry-run              # no CSV output, just counts
 *   node harvest.mjs --limit 20             # scan first 20 ATS-matched companies
 *   node harvest.mjs --ats greenhouse       # only one ATS (debug)
 *   node harvest.mjs --company "Voodoo"     # only one company (substring match)
 *   node harvest.mjs --no-filter            # skip title/location filtering
 *   node harvest.mjs --industry gaming      # only companies where industry_category matches
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { ADAPTERS, routeCompany } from './adapters/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────

const COMPANIES_PATH   = resolve(__dirname, 'data/companies_v2.json');
const PORTALS_PATH     = resolve(__dirname, 'portals.yml');
const HISTORY_PATH     = resolve(__dirname, 'data/harvest-history.tsv');
const OUTPUT_DIR       = resolve(__dirname, 'output');

const CONCURRENCY      = 10;
const FETCH_TIMEOUT_MS = 15_000;

// ── CLI ─────────────────────────────────────────────────────────────

// Country shortcuts — --country india,remote,us expands to a set of location keywords.
// Unknown values are used as literal substrings (so --country japan still works).
const COUNTRY_PRESETS = {
  india:       ['India', 'Delhi', 'New Delhi', 'NCR', 'Gurgaon', 'Gurugram', 'Noida', 'Bangalore', 'Bengaluru', 'Mumbai', 'Hyderabad', 'Pune', 'Chennai', 'Kolkata', 'Ahmedabad'],
  remote:      ['Remote', 'Anywhere', 'Global', 'Worldwide', 'Work from home', 'WFH', 'Distributed'],
  anywhere:    ['Remote', 'Anywhere', 'Global', 'Worldwide'],
  global:      ['Remote', 'Anywhere', 'Global', 'Worldwide'],
  us:          ['United States', 'USA', 'U.S.', 'U.S.A', 'San Francisco', 'New York', 'NYC', 'Los Angeles', 'Seattle', 'Boston', 'Austin', 'Chicago', 'Denver', 'Remote - US', 'Remote US'],
  usa:         ['United States', 'USA', 'U.S.', 'San Francisco', 'New York', 'NYC', 'Los Angeles', 'Seattle', 'Boston', 'Austin', 'Chicago', 'Denver'],
  uk:          ['United Kingdom', 'UK', 'London', 'Manchester', 'Edinburgh', 'Birmingham', 'Bristol', 'Remote - UK'],
  canada:      ['Canada', 'Toronto', 'Vancouver', 'Montreal', 'Ottawa', 'Calgary', 'Remote - Canada'],
  eu:          ['Europe', 'EU', 'Germany', 'Berlin', 'Munich', 'Hamburg', 'France', 'Paris', 'Netherlands', 'Amsterdam', 'Spain', 'Madrid', 'Barcelona', 'Sweden', 'Stockholm', 'Poland', 'Warsaw', 'Ireland', 'Dublin', 'Portugal', 'Lisbon', 'Italy', 'Milan', 'Rome'],
  europe:      ['Europe', 'EU', 'Germany', 'Berlin', 'France', 'Paris', 'Netherlands', 'Amsterdam', 'Spain', 'Madrid', 'Barcelona', 'Sweden', 'Stockholm', 'Poland', 'Warsaw', 'Ireland', 'Dublin'],
  apac:        ['APAC', 'Asia', 'Singapore', 'Tokyo', 'Japan', 'Seoul', 'Korea', 'Hong Kong', 'Taipei', 'Taiwan', 'Sydney', 'Melbourne', 'Australia'],
  asia:        ['Asia', 'APAC', 'Singapore', 'Tokyo', 'Japan', 'Seoul', 'Korea', 'Hong Kong', 'Taipei', 'Taiwan'],
  germany:     ['Germany', 'Berlin', 'Munich', 'Hamburg', 'Frankfurt'],
  france:      ['France', 'Paris', 'Lyon'],
  netherlands: ['Netherlands', 'Amsterdam', 'Rotterdam'],
  singapore:   ['Singapore'],
  japan:       ['Japan', 'Tokyo', 'Osaka'],
  australia:   ['Australia', 'Sydney', 'Melbourne', 'Brisbane'],
};

function expandCountries(csv) {
  if (!csv) return null;
  const terms = [];
  for (const raw of csv.split(',')) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    if (COUNTRY_PRESETS[key]) terms.push(...COUNTRY_PRESETS[key]);
    else terms.push(raw.trim());                       // literal keyword
  }
  return Array.from(new Set(terms));                    // dedup
}

function parseArgs(argv) {
  const args = { dryRun: false, limit: null, ats: null, company: null, noFilter: false, industry: null, country: null, locationOverride: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-filter') args.noFilter = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--ats') args.ats = argv[++i].toLowerCase();
    else if (a === '--company') args.company = argv[++i];
    else if (a === '--industry') args.industry = argv[++i].toLowerCase();
    else if (a === '--country') args.country = expandCountries(argv[++i]);
    else if (a === '--location') args.locationOverride = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
  }
  return args;
}

const ARGS = parseArgs(process.argv);

// ── Shared fetch helpers (passed to adapters) ───────────────────────

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function logWarn(msg) {
  if (process.env.HARVEST_VERBOSE === '1') console.warn(`[warn] ${msg}`);
}

// ── Load config ─────────────────────────────────────────────────────

function loadPortals() {
  if (!existsSync(PORTALS_PATH)) {
    console.error(`[fatal] missing ${PORTALS_PATH}`);
    process.exit(1);
  }
  return yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
}

function loadCompanies() {
  if (!existsSync(COMPANIES_PATH)) {
    console.error(`[fatal] missing ${COMPANIES_PATH} — drop your companies_v2.json here`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(COMPANIES_PATH, 'utf-8'));
  if (!Array.isArray(raw)) throw new Error('companies_v2.json must be an array');
  return raw;
}

function loadSeen() {
  const seen = new Set();
  if (existsSync(HISTORY_PATH)) {
    const lines = readFileSync(HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  return seen;
}

// ── Filters ─────────────────────────────────────────────────────────

function buildTitleFilter(tf) {
  const pos = (tf?.positive || []).map(k => k.toLowerCase());
  const neg = (tf?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const t = (title || '').toLowerCase();
    const passPos = pos.length === 0 || pos.some(k => t.includes(k));
    const failNeg = neg.some(k => t.includes(k));
    return { pass: passPos && !failNeg, matched: pos.filter(k => t.includes(k)) };
  };
}

function buildLocationFilter(loc) {
  const inc = (loc?.include || []).map(k => k.toLowerCase());
  const exc = (loc?.exclude || []).map(k => k.toLowerCase());
  const wantsRemote = inc.some(k => /remote|anywhere|global|worldwide|work from home|wfh|distributed/.test(k));
  return (location, remote) => {
    const l = (location || '').toLowerCase();
    if (exc.some(k => l.includes(k))) return false;
    if (inc.length === 0) return true;          // no filter set → pass everything
    if (!l) return false;                       // unknown location + active filter → drop (strict)
    if (inc.some(k => l.includes(k))) return true;
    if (remote && wantsRemote) return true;     // only honor remote flag if user opted in
    return false;
  };
}

// ── Manual-only hosts ───────────────────────────────────────────────

function isManualHost(urls, manualHosts) {
  for (const u of urls) {
    try {
      const h = new URL(u).hostname.toLowerCase();
      if (manualHosts.some(m => h.includes(m))) return h;
    } catch { /* ignore */ }
  }
  return null;
}

// ── Concurrency helper ──────────────────────────────────────────────

async function runPool(items, worker, concurrency) {
  const results = [];
  let idx = 0;
  async function drain() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, drain));
  return results;
}

// ── CSV ─────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'company', 'industry', 'role', 'location', 'remote',
  'department', 'employment_type', 'posted_date',
  'ats', 'detail_url', 'apply_url', 'matched_keywords'
];

function csvEscape(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).replace(/\r?\n/g, ' ').trim();
  if (/[",]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(path, rows) {
  const header = CSV_COLUMNS.join(',');
  const body   = rows.map(r => CSV_COLUMNS.map(c => csvEscape(r[c])).join(',')).join('\n');
  writeFileSync(path, header + '\n' + body + '\n', 'utf-8');
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== outscal-jobs harvest ===\n');

  const portals   = loadPortals();
  const companies = loadCompanies();
  const seen      = loadSeen();

  console.log(`Loaded ${companies.length} companies from data/companies_v2.json`);
  console.log(`Seen URLs from prior runs: ${seen.size}`);

  // Industry allowlist
  const industryList = (portals.industry_allowlist || []).map(s => s.toLowerCase());
  const cliIndustry  = ARGS.industry;
  const industryPass = (c) => {
    const cat = (c.industry_category || c.type || '').toLowerCase();
    if (cliIndustry) return cat === cliIndustry;
    if (industryList.length === 0) return true;
    return industryList.includes(cat);
  };

  // ATS allowlist (CLI wins over portals.yml)
  const atsAllowlist = ARGS.ats ? [ARGS.ats] : (portals.ats_allowlist || []).map(s => s.toLowerCase());

  const manualHosts = (portals.manual_only || []).map(s => s.toLowerCase());

  const titleFilter = buildTitleFilter(portals.title_filter);

  // CLI --country / --location override portals.yml locations.include
  const effectiveLocations = (() => {
    if (ARGS.locationOverride) return { include: ARGS.locationOverride, exclude: portals.locations?.exclude || [] };
    if (ARGS.country)          return { include: ARGS.country,          exclude: portals.locations?.exclude || [] };
    return portals.locations || { include: [], exclude: [] };
  })();
  const locationFilter = buildLocationFilter(effectiveLocations);
  if (ARGS.country || ARGS.locationOverride) {
    console.log(`[location override] ${effectiveLocations.include.slice(0, 8).join(', ')}${effectiveLocations.include.length > 8 ? '…' : ''}`);
  }

  // Partition companies
  const routed = [];
  const manual = [];
  const unrouted = [];

  for (const c of companies) {
    if (!industryPass(c)) continue;
    if (ARGS.company && !(c.name || '').toLowerCase().includes(ARGS.company.toLowerCase())) continue;

    const urls = [...(c.ats_links || []), c.listUrl, c.website].filter(Boolean);
    const manualHit = isManualHost(urls, manualHosts);
    if (manualHit) {
      manual.push({ company: c, host: manualHit });
      continue;
    }

    const route = routeCompany(c);
    if (route) {
      if (atsAllowlist.length && !atsAllowlist.includes(route.adapter.ATS)) continue;
      routed.push({ company: c, ...route });
    } else {
      unrouted.push(c);
    }
  }

  if (ARGS.limit) routed.length = Math.min(ARGS.limit, routed.length);

  console.log(`Routable to known ATS: ${routed.length}`);
  console.log(`Flagged manual (LinkedIn/Wellfound etc): ${manual.length}`);
  console.log(`Unrouted (no known ATS — Tier 2 scope): ${unrouted.length}`);
  if (ARGS.limit) console.log(`[--limit ${ARGS.limit}] capping to ${routed.length} routable`);
  console.log('');

  // Adapter counts
  const byAts = {};
  for (const r of routed) byAts[r.adapter.ATS] = (byAts[r.adapter.ATS] || 0) + 1;
  console.log('By ATS:', byAts);
  console.log('');

  // Run adapters with concurrency
  let done = 0;
  const ctx = { fetchJson, fetchText, logWarn };
  const startedAt = Date.now();

  const jobLists = await runPool(routed, async (r) => {
    const { company, adapter, handle } = r;
    try {
      if (handle.skipped) return { company, adapter, jobs: [], skipped: handle.reason || 'skipped' };
      const jobs = await adapter.fetchJobs(handle, { ...ctx, company });
      return { company, adapter, jobs: Array.isArray(jobs) ? jobs : [] };
    } catch (e) {
      return { company, adapter, jobs: [], error: e.message };
    } finally {
      done++;
      if (done % 25 === 0 || done === routed.length) {
        process.stdout.write(`  [${done}/${routed.length}] ${Math.round((Date.now()-startedAt)/1000)}s\n`);
      }
    }
  }, CONCURRENCY);

  // Flatten & filter
  let totalRaw = 0, totalAfterTitle = 0, totalAfterLocation = 0, totalAfterDedup = 0;
  const rows = [];

  for (const { company, adapter, jobs } of jobLists) {
    totalRaw += jobs.length;
    for (const j of jobs) {
      if (!j.title || !j.detail_url) continue;

      const tf = ARGS.noFilter ? { pass: true, matched: [] } : titleFilter(j.title);
      if (!tf.pass) continue;
      totalAfterTitle++;

      if (!ARGS.noFilter && !locationFilter(j.location, j.remote)) continue;
      totalAfterLocation++;

      if (seen.has(j.detail_url)) continue;
      totalAfterDedup++;

      rows.push({
        company:         company.name || company.display_name || '',
        industry:        company.industry_category || company.type || '',
        role:            j.title,
        location:        j.location || '',
        remote:          j.remote ? 'yes' : '',
        department:      j.department || '',
        employment_type: j.employment_type || '',
        posted_date:     j.posted_date || '',
        ats:             adapter.ATS,
        detail_url:      j.detail_url,
        apply_url:       j.apply_url || j.detail_url,
        matched_keywords: tf.matched.join('; '),
      });
    }
  }

  console.log('');
  console.log('=== Results ===');
  console.log(`Raw jobs fetched          : ${totalRaw}`);
  console.log(`After title filter        : ${totalAfterTitle}`);
  console.log(`After location filter     : ${totalAfterLocation}`);
  console.log(`After dedup vs history    : ${totalAfterDedup}`);
  console.log(`Final CSV rows            : ${rows.length}`);

  if (ARGS.dryRun) {
    console.log('\n[dry-run] skipping CSV + history writes');
    return;
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  if (rows.length > 0) {
    const outPath = resolve(OUTPUT_DIR, `jobs-${date}.csv`);
    writeCsv(outPath, rows);
    console.log(`\nWrote ${rows.length} rows → ${outPath}`);

    // Append to history for future dedup
    mkdirSync(dirname(HISTORY_PATH), { recursive: true });
    if (!existsSync(HISTORY_PATH)) {
      writeFileSync(HISTORY_PATH, 'url\tcompany\ttitle\tats\tdate\n', 'utf-8');
    }
    const hist = rows.map(r => `${r.detail_url}\t${r.company}\t${r.role}\t${r.ats}\t${date}`).join('\n') + '\n';
    appendFileSync(HISTORY_PATH, hist, 'utf-8');
  }

  // Manual CSV
  if (manual.length > 0) {
    const manualPath = resolve(OUTPUT_DIR, `jobs-manual-${date}.csv`);
    const manualRows = manual.map(({ company, host }) => ({
      company: company.name || company.display_name || '',
      industry: company.industry_category || company.type || '',
      role: '', location: '', remote: '', department: '', employment_type: '', posted_date: '',
      ats: host, detail_url: (company.ats_links || [])[0] || '', apply_url: '', matched_keywords: '',
    }));
    writeCsv(manualPath, manualRows);
    console.log(`Wrote ${manualRows.length} manual-flagged companies → ${manualPath}`);
  }

  console.log('\nDone.');
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
