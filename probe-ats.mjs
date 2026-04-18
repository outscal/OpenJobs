// probe-ats.mjs — slug-probe un-routed companies against the 9 slug-based ATS APIs.
//
// Reads data/companies_v2.json. For every company that routeCompany() cannot place
// on an adapter, generates a handful of slug variants from its name/slug and
// tries each variant against Greenhouse, Lever, Ashby, Workable, SmartRecruiters,
// Recruitee, Breezy, BambooHR, and Personio. Records any 200 + valid-shape hit
// to output/ats-probe-YYYY-MM-DD.csv.
//
// Workday is excluded — it needs per-tenant (host + siteId) discovery, not
// slug probing.
//
// Usage:
//   node probe-ats.mjs --limit 200              # pilot
//   node probe-ats.mjs --type gaming --limit 500
//   node probe-ats.mjs                          # full sweep (slow!)

import fs from 'node:fs';
import path from 'node:path';
import { routeCompany } from './adapters/index.mjs';

const TIMEOUT_MS = 8000;

// Per-ATS concurrency caps. Central-host APIs stay conservative to avoid
// provider rate limits; tenant-subdomain ATSs probe a different host per
// request, so there's no shared rate limit and we can safely run many
// concurrent probes (each goes to a distinct {slug}.{ats}.com DNS/server).
const PER_ATS_MAX = {
  // Central APIs — single host, shared rate limits. Keep conservative.
  greenhouse: 8,
  lever: 8,
  ashby: 6,
  smartrecruiters: 8,
  // Tenant-subdomain ATSs — each probe hits a different host. Safe at higher limits.
  recruitee: 20,
  breezy: 20,
  bamboohr: 20,
  // DISABLED in the default sweep — these two IP-rate-limit aggressively and every
  // probe gets 429'd, producing no hits while dragging total runtime from ~20 min
  // to 3+ hours. Run them as a separate pass via --only workable,personio later.
  // workable: 6,
  // personio: 5,
};

// Number of (company,slug) units in flight at once. Real throttle is per-ATS above;
// this just keeps the event loop saturated.
const UNIT_CONCURRENCY = 80;

// Retry once on 429 (rate limit) or 5xx with a 3s backoff.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_BACKOFF_MS = 1000;

// ── Probe definitions ──────────────────────────────────────────────
// Each probe: URL template from a slug, how to validate the response,
// how to extract a job count. `text:true` = XML/HTML response.

const PROBES = [
  {
    ats: 'greenhouse',
    url: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=false`,
    validate: j => Array.isArray(j?.jobs),
    count: j => j.jobs.length,
    sample: j => j.jobs[0]?.title || '',
  },
  {
    ats: 'lever',
    url: s => `https://api.lever.co/v0/postings/${s}?mode=json`,
    validate: j => Array.isArray(j),
    count: j => j.length,
    sample: j => j[0]?.text || '',
  },
  {
    ats: 'ashby',
    url: s => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    validate: j => Array.isArray(j?.jobs),
    count: j => j.jobs.length,
    sample: j => j.jobs[0]?.title || '',
  },
  {
    ats: 'workable',
    url: s => `https://apply.workable.com/api/v3/accounts/${s}/jobs`,
    method: 'POST',
    body: {},
    validate: j => typeof j?.total === 'number',
    count: j => j.total,
    sample: j => j.results?.[0]?.title || '',
  },
  {
    ats: 'smartrecruiters',
    // NOTE: returns 200 + {totalFound:0} for ANY slug. Only count as hit when totalFound > 0.
    url: s => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`,
    validate: j => typeof j?.totalFound === 'number' && j.totalFound > 0,
    count: j => j.totalFound,
    sample: j => j.content?.[0]?.name || '',
  },
  {
    ats: 'recruitee',
    url: s => `https://${s}.recruitee.com/api/offers/`,
    validate: j => Array.isArray(j?.offers),
    count: j => j.offers.length,
    sample: j => j.offers[0]?.title || '',
  },
  {
    ats: 'breezy',
    // NOTE: breezy.hr's /json endpoint returns 200 + "[]" for ANY subdomain that
    // happens to resolve — same wildcard-accept pattern as SmartRecruiters. We
    // only count it as a hit when count > 0, otherwise every slug falsely matches.
    // Tradeoff: we miss Breezy tenants with 0 current postings.
    url: s => `https://${s}.breezy.hr/json`,
    validate: j => {
      const arr = Array.isArray(j?.positions) ? j.positions : (Array.isArray(j) ? j : null);
      return arr !== null && arr.length > 0;
    },
    count: j => (j?.positions || j || []).length,
    sample: j => (j?.positions || j || [])[0]?.name || '',
  },
  {
    ats: 'bamboohr',
    url: s => `https://${s}.bamboohr.com/careers/list`,
    validate: j => Array.isArray(j?.result),
    count: j => j.result.length,
    sample: j => j.result[0]?.jobOpeningName || '',
  },
  {
    ats: 'personio',
    url: s => `https://${s}.jobs.personio.com/xml`,
    text: true,
    validate: x => typeof x === 'string' && /<position\b/i.test(x),
    count: x => (x.match(/<position\b/gi) || []).length,
    sample: x => (x.match(/<name>([^<]+)<\/name>/i) || [,''])[1] || '',
  },
];

// ── Slug variant generator ────────────────────────────────────────
// Only 3 variants per company: company.slug, hyphenated full name, no-space full name.
// Over-stripped single-word variants (e.g. "Riot Games" → "riot") cause too many
// false positives from generic-English-word slug collisions. Drop them.

function slugVariants(company) {
  const out = new Set();
  const push = s => {
    s = String(s || '').toLowerCase().trim();
    if (s.length >= 4 && s.length <= 60 && /^[a-z0-9][a-z0-9-]*$/.test(s)) out.add(s);
  };

  if (company.slug) push(company.slug);

  const name = String(company.name || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return [...out];

  push(name.replace(/\s+/g, '-'));
  push(name.replace(/\s+/g, ''));
  return [...out];
}

// ── Per-ATS semaphore ─────────────────────────────────────────────

class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.q = []; }
  async acquire() {
    if (this.active < this.max) { this.active++; return; }
    await new Promise(res => this.q.push(res));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.q.shift();
    if (next) next();
  }
}

const SEM = Object.fromEntries(Object.entries(PER_ATS_MAX).map(([k, v]) => [k, new Semaphore(v)]));

// Only probes with an active PER_ATS_MAX entry run. Probes for ATSs commented out
// (workable/personio) are filtered out here so SEM[p.ats] is always defined.
const ACTIVE_PROBES = PROBES.filter(p => PER_ATS_MAX[p.ats] !== undefined);

// Track rate-limit hits per ATS so we can surface them in the summary.
const RATE_LIMIT_HITS = Object.fromEntries(Object.keys(PER_ATS_MAX).map(k => [k, 0]));

// ── HTTP probe ────────────────────────────────────────────────────
// Acquires the per-ATS semaphore, issues the request, handles one retry on 429/5xx.

async function doFetch(p, slug) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const init = {
      signal: ctl.signal,
      headers: { Accept: p.text ? 'application/xml,text/xml,*/*' : 'application/json' },
    };
    if (p.method === 'POST') {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(p.body || {});
    }
    return await fetch(p.url(slug), init);
  } finally {
    clearTimeout(timer);
  }
}

async function probeOne(p, slug) {
  await SEM[p.ats].acquire();
  try {
    let res;
    try { res = await doFetch(p, slug); } catch { return null; }
    if (RETRY_STATUSES.has(res.status)) {
      RATE_LIMIT_HITS[p.ats]++;
      await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
      try { res = await doFetch(p, slug); } catch { return null; }
    }
    if (!res.ok) return null;
    let data;
    try { data = p.text ? await res.text() : await res.json(); } catch { return null; }
    if (!p.validate(data)) return null;
    return { count: p.count(data), sample: (p.sample ? p.sample(data) : '').slice(0, 80) };
  } finally {
    SEM[p.ats].release();
  }
}

// ── Concurrency pool (for units, not individual probes) ───────────

async function runPool(items, worker, concurrency) {
  let idx = 0;
  async function drain() {
    while (idx < items.length) {
      const i = idx++;
      try { await worker(items[i], i); } catch (e) { /* swallow */ }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, drain));
}

// ── CSV helper ────────────────────────────────────────────────────

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Main ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { limit: Infinity, offset: 0, type: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--offset') out.offset = Number(argv[++i]);
    else if (a === '--type') out.type = String(argv[++i]).toLowerCase();
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  const raw = JSON.parse(fs.readFileSync('data/companies_v2.json', 'utf8'));
  const companies = Array.isArray(raw) ? raw : (raw.companies || raw.data || []);
  console.log(`companies_v2.json total: ${companies.length}`);

  let unrouted = companies.filter(c => !routeCompany(c));
  console.log(`Un-routed to any ATS adapter: ${unrouted.length}`);

  if (args.type) {
    unrouted = unrouted.filter(c => String(c.type || '').toLowerCase() === args.type);
    console.log(`After --type=${args.type}: ${unrouted.length}`);
  }
  if (args.offset > 0) {
    unrouted = unrouted.slice(args.offset);
    console.log(`After --offset=${args.offset}: ${unrouted.length}`);
  }
  if (Number.isFinite(args.limit)) {
    unrouted = unrouted.slice(0, args.limit);
    console.log(`After --limit=${args.limit}: ${unrouted.length}`);
  }

  // Flatten into independent (company, slug, probe) tasks. No per-unit Promise.all —
  // each task is bounded only by its ATS semaphore. This removes head-of-line blocking
  // where one slow ATS request would stall 8 fast ones waiting on the same unit.
  const tasks = [];
  for (const c of unrouted) {
    for (const slug of slugVariants(c)) {
      for (const p of ACTIVE_PROBES) tasks.push({ c, slug, p });
    }
  }
  console.log(`Total probe tasks (company × slug × ATS): ${tasks.length}`);
  console.log(`Per-ATS caps: ${Object.entries(PER_ATS_MAX).map(([k,v])=>`${k}=${v}`).join(', ')}`);
  console.log(`Theoretical peak concurrent HTTP: ${Object.values(PER_ATS_MAX).reduce((a,b)=>a+b,0)}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms  Retry: once on ${[...RETRY_STATUSES].join('/')} after ${RETRY_BACKOFF_MS}ms\n`);

  fs.mkdirSync('output', { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const suffix = args.offset > 0 ? `-off${args.offset}` : '';
  const outPath = path.join('output', `ats-probe-${date}${suffix}.csv`);
  fs.writeFileSync(outPath, 'company_name,company_type,slug_tried,matched_ats,job_count,sample_title\n');

  let done = 0, hits = 0;
  const companiesWithHit = new Set();
  const perAts = Object.fromEntries(ACTIVE_PROBES.map(p => [p.ats, 0]));
  const t0 = Date.now();

  // Fire all tasks. Per-ATS semaphores inside probeOne() are the real throttle —
  // they block acquire() until a slot is free. Promise queue holds the rest.
  await Promise.all(tasks.map(async ({ c, slug, p }) => {
    const r = await probeOne(p, slug);
    done++;
    if (r) {
      hits++;
      companiesWithHit.add(c._id?.$oid || c.name);
      perAts[p.ats]++;
      fs.appendFileSync(outPath, [c.name, c.type, slug, p.ats, r.count, r.sample].map(csvEscape).join(',') + '\n');
    }
    if (done % 2000 === 0) {
      const sec = (Date.now() - t0) / 1000;
      const rate = done / sec;
      const eta = Math.round((tasks.length - done) / rate);
      console.log(`  [${done}/${tasks.length}] ${(100*done/tasks.length).toFixed(1)}%  hits:${hits}  companies:${companiesWithHit.size}  ${rate.toFixed(0)} req/s  eta:${eta}s`);
    }
  }));

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${sec}s`);
  console.log(`Probe tasks completed: ${tasks.length}`);
  console.log(`Probe hits (CSV rows): ${hits}`);
  console.log(`Unique companies matched: ${companiesWithHit.size}`);
  console.log(`Companies probed: ${unrouted.length}`);
  console.log(`Hit rate per company: ${(100 * companiesWithHit.size / unrouted.length).toFixed(1)}%`);
  console.log(`\nPer-ATS hits (rows in CSV):`);
  for (const [ats, n] of Object.entries(perAts).sort((a, b) => b[1] - a[1])) {
    if (n) console.log(`  ${ats.padEnd(18)} ${n}`);
  }
  const rlTotal = Object.values(RATE_LIMIT_HITS).reduce((a, b) => a + b, 0);
  if (rlTotal) {
    console.log(`\nRate-limit/5xx retries triggered: ${rlTotal}`);
    for (const [ats, n] of Object.entries(RATE_LIMIT_HITS).sort((a, b) => b[1] - a[1])) {
      if (n) console.log(`  ${ats.padEnd(18)} ${n}`);
    }
  } else {
    console.log(`\nNo rate-limit hits detected.`);
  }
  console.log(`\nCSV: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
