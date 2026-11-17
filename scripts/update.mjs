// Pulls EU co-decision files from the European Parliament Open Data Portal
// and writes data/data.json for the page. Runs on GitHub Actions (Node 20).
// Source: https://data.europarl.europa.eu  (procedures API v2)
import { readFile, writeFile } from "node:fs/promises";

const BASE = "https://data.europarl.europa.eu/api/v2";
const FMT = "format=application%2Fld%2Bjson";
const MIN_YEAR = +(process.env.MIN_YEAR || 2025);
const LIMIT = process.env.LIMIT ? +process.env.LIMIT : Infinity; // test runs: fetch only N files
const DELAY_MS = 1200;            // pause between detail calls (API rate-limits bursts)
const BUDGET_MS = 30 * 60 * 1000; // stop fetching after 30 min, keep what we have
const FINAL_RECHECK_DAYS = 14;    // published files are re-checked this rarely
const OUT = "data/data.json";
const OVERRIDES = "data/title-overrides.json";
const started = Date.now();

const STAGE_OF = {
  REFERRAL: 1,
  COMMITTEE_TABLING_AMENDMENT: 2, COMMITTEE_TABLING_REPORT: 2, COMMITTEE_TABLING_OPINION: 2,
  COMMITTEE_ADOPTING_OPINION: 2, COMMITTEE_ADOPTING_REPORT: 2, PLENARY_REFER_COMMITTEE_RECONSIDERATION: 2,
  PLENARY_REJECT_COMMITTEE_INTERINSTUTIONAL_NEGOTIATIONS: 3,
  PLENARY_REFER_COMMITTEE_INTERINSTITUTIONAL_NEGOTIATIONS: 3,
  INTERINSTITUTIONAL_NEGOTIATION: 3, COMMITTEE_APPROVE_PROVISIONAL_AGREEMENT: 3,
  PLENARY_ENDORSE_COMMITTEE_INTERINSTITUTIONAL_NEGOTIATIONS: 3,
  TABLING_PLENARY: 4, PLENARY_DEBATE: 4, PLENARY_AMEND: 4, PLENARY_AMEND_PROPOSAL: 4,
  PLENARY_AMEND_COUNCIL_POSITION: 4, PLENARY_VOTE: 4, PLENARY_VOTE_RESULTS: 4,
  PLENARY_ADOPT_POSITION: 5,
  SIGNATURE: 6,
  PUBLICATION_OFFICIAL_JOURNAL: 7,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
const unknownTypes = new Set();

async function getJson(url) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/ld+json", "User-Agent": "eu-legislative-tracker (GitHub Actions)" } });
      if (res.status === 429) {
        const wait = (+res.headers.get("retry-after") || 60) + 5;
        console.log(`429 rate limited, waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 500) throw new Error("HTTP " + res.status);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      if (attempt === 6) throw e;
      console.log(`retry ${attempt} for ${url}: ${e.message}`);
      await sleep(attempt * 5000);
    }
  }
}

async function listIds() {
  const ids = [];
  let offset = 0, total = Infinity;
  while (offset < total) {
    const j = await getJson(`${BASE}/procedures?process-type=COD&limit=500&offset=${offset}&${FMT}`);
    total = j.meta?.total ?? 0;
    for (const p of j.data || []) {
      const m = /^(\d{4})-\d+$/.exec(p.process_id || "");
      if (m && +m[1] >= MIN_YEAR) ids.push(p.process_id);
    }
    offset += 500;
    await sleep(DELAY_MS);
  }
  return [...new Set(ids)];
}

function buildRecord(id, d, overrides) {
  const events = [];
  for (const e of d.consists_of || []) {
    const type = (e.had_activity_type || "").split("/").pop();
    const date = e.activity_date || "";
    if (!type || !date || date > today) continue; // ignore scheduled future items
    const stage = STAGE_OF[type];
    if (!stage) { unknownTypes.add(type); continue; }
    events.push({ type, date, stage });
  }
  // latest event: newest date, ties go to the later stage
  let latest = null;
  for (const e of events) {
    if (!latest || e.date > latest.date || (e.date === latest.date && e.stage > latest.stage)) latest = e;
  }
  const sd = ["", "", "", "", "", "", ""];
  for (const e of events) {
    const k = e.stage - 1;
    if (!sd[k] || e.date < sd[k]) sd[k] = e.date; // first date each stage was reached
  }
  const titles = d.process_title || {};
  const official = titles.en || titles[Object.keys(titles)[0]] || "";
  return {
    i: id,
    l: id.replace("-", "/") + "(COD)",
    t: overrides[id] || official,
    s: latest ? latest.stage : 1,
    d: latest ? latest.date : "",
    y: latest ? latest.type : "",
    sd,
    r: /RDG[23]|CONC|CNC/i.test(d.current_stage || ""),
    f: today,
  };
}

const strip = r => { const { f, ...rest } = r; return rest; };
const needsFetch = r => {
  if (!r) return true;
  if (r.s < 7) return true;
  const ageDays = (Date.parse(today) - Date.parse(r.f || "1970-01-01")) / 864e5;
  return ageDays >= FINAL_RECHECK_DAYS;
};

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

const old = await readJson(OUT, null);
const overrides = await readJson(OVERRIDES, {});
const cache = new Map((old?.procedures || []).map(r => [r.i, r]));

console.log("Listing procedures...");
const ids = await listIds();
console.log(`${ids.length} files from ${MIN_YEAR} onwards`);

// uncached first, then oldest-checked first
const todo = ids.filter(id => needsFetch(cache.get(id)))
  .sort((a, b) => (cache.get(a)?.f || "").localeCompare(cache.get(b)?.f || ""))
  .slice(0, LIMIT);
console.log(`${todo.length} to fetch`);

let ok = 0, failed = 0;
for (const id of todo) {
  if (Date.now() - started > BUDGET_MS) { console.log("Time budget reached, stopping early"); break; }
  try {
    const j = await getJson(`${BASE}/procedures/${id}?${FMT}`);
    const d = j.data?.[0];
    if (!d) throw new Error("empty response");
    cache.set(id, buildRecord(id, d, overrides));
    ok++;
  } catch (e) {
    failed++;
    console.log(`FAILED ${id}: ${e.message}`);
  }
  await sleep(DELAY_MS);
}
console.log(`fetched ${ok}, failed ${failed}`);
if (unknownTypes.size) console.log("WARNING unknown activity types (ignored): " + [...unknownTypes].join(", "));
if (ok === 0 && todo.length > 0) { console.error("Nothing could be fetched, keeping old data"); process.exit(1); }

const procedures = ids.map(id => cache.get(id)).filter(Boolean).sort((a, b) => a.i.localeCompare(b.i));
const changedContent = JSON.stringify((old?.procedures || []).map(strip)) !== JSON.stringify(procedures.map(strip));
const now = new Date().toISOString();
const oldChecked = old?.checked ? Date.parse(old.checked) : 0;

if (!changedContent && Date.now() - oldChecked < 20 * 3600 * 1000) {
  console.log("No change and checked recently, not writing.");
} else {
  const out = {
    schema: 1,
    checked: now,
    changed: changedContent ? now : (old?.changed || now),
    latest: procedures.reduce((m, r) => (r.d > m ? r.d : m), ""),
    source: "European Parliament Open Data Portal (data.europarl.europa.eu), procedures API v2",
    procedures,
  };
  await writeFile(OUT, JSON.stringify(out) + "\n");
  console.log(`Wrote ${OUT}: ${procedures.length} files, content changed: ${changedContent}`);
}
