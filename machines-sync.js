// machines-sync.js
//
// Pulls the machine (arena) list from the most recent PAST qualifier-type
// tournament — Monday League, Tuesday League, or Pinawarra, whichever
// happened most recently — and writes machines.json.
//
// Deliberately NOT using Match Play's organizer-level /api/arenas
// endpoint: that list has accumulated duplicate historical records per
// machine (e.g. the same machine appearing 2-3 times with conflicting
// active/inactive status), with no reliable way to tell which record is
// current. A specific tournament's arena list (via includeArenas=true)
// is a clean, deduplicated snapshot for that one night — the tradeoff is
// it can be a few days stale on machine status, which is an acceptable
// tradeoff for a reliable, non-duplicated list.
//
// Confirmed API shapes (from real responses, 2026-07):
//   GET /api/tournaments?owner={id}&limit=100&page=N
//     -> { data: [{ tournamentId, name, status, startUtc, startLocal,
//                    test, type, ... }] }
//   GET /api/tournaments/{id}?includeArenas=true
//     -> { data: { ..., arenas: [{ arenaId, name, status, ... }] } }

const fs = require("fs");

const MATCHPLAY_API_TOKEN = process.env.MATCHPLAY_API_TOKEN;
const MATCHPLAY_OWNER_ID = 25018;
const MATCHPLAY_BASE = "https://app.matchplay.events";

if (!MATCHPLAY_API_TOKEN) {
  console.error("Missing MATCHPLAY_API_TOKEN environment variable.");
  process.exit(1);
}

async function matchplayGet(path) {
  const res = await fetch(`${MATCHPLAY_BASE}${path}`, {
    headers: { Authorization: `Bearer ${MATCHPLAY_API_TOKEN}` }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${path} -> HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

function toIsoDate(dateStr) {
  return dateStr ? dateStr.slice(0, 10) : "";
}

function tokens(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

async function fetchAllMatchplayTournaments() {
  var all = [];
  var page = 1;
  while (true) {
    var data = await matchplayGet(`/api/tournaments?owner=${MATCHPLAY_OWNER_ID}&limit=100&page=${page}`);
    var pageItems = data.data || [];
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;
    all = all.concat(pageItems);
    if (pageItems.length < 100) break;
    page++;
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`Fetched ${all.length} Match Play tournaments for owner ${MATCHPLAY_OWNER_ID}.`);
  return all;
}

// Same exclusion patterns proven out in the main events sync script —
// never treat a finals/semis/playoff/tiebreaker-type tournament as the
// source for "current machine lineup".
var ELIMINATION_TYPE_REGEX = /elimination|knockout/i;
var NON_QUALIFIER_NAME_REGEX = /\bfinal(s)?\b|\bsemi(s)?(\s*final(s)?)?\b|\bquarter(s)?(\s*final(s)?)?\b|\btop\s*\d+\b|\bplay[\s-]?off(s)?\b|\bround of \d+\b|\bseeding\b|\bbest of the rest\b|\bwildcard\b|\bconsolation\b|\bplate\b|\btie[\s-]?breaker\b|\(?\s*\d+(st|nd|rd|th)?\s*-\s*\d+(st|nd|rd|th)\b\s*\)?/i;

// Match Play's arena status for a small number of machines has proven
// wrong across every tournament we've checked (not just one stale
// snapshot — the same machines come back wrong regardless of which
// recent tournament we pull from). That points to a duplicated/outdated
// arena record on Match Play's side rather than a "picked the wrong
// date" problem, so rather than keep guessing at the API, these are
// hard-corrected here. Add a name (exact match) + the real current
// status whenever you spot another one like this.
var STATUS_OVERRIDES = {
  "Deadpool (Pro)": true,
  "Black Knight": false
};

async function main() {
  const today = toIsoDate(new Date().toISOString());
  console.log(`Today (for filtering out future tournaments): ${today}`);

  const all = await fetchAllMatchplayTournaments();

  const candidates = all.filter((mt) => {
    if (mt.test || /template/i.test(mt.name || "")) return false;
    if (NON_QUALIFIER_NAME_REGEX.test(mt.name || "")) return false;
    if (ELIMINATION_TYPE_REGEX.test(mt.type || "")) return false;

    const n = tokens(mt.name);
    const isMondayLeague = n.indexOf("monday") !== -1 && n.indexOf("league") !== -1;
    const isTuesdayLeague = n.indexOf("tuesday") !== -1 && n.indexOf("league") !== -1;
    const isPinawarra = n.length > 0 && n[0] === "pinawarra";
    if (!isMondayLeague && !isTuesdayLeague && !isPinawarra) return false;

    const d = toIsoDate(mt.startLocal || mt.startUtc || "");
    if (!d) return false;

    // Strictly in the past — today itself doesn't count — and no more
    // than 10 days ago.
    const daysAgo = (new Date(today).getTime() - new Date(d).getTime()) / (1000 * 60 * 60 * 24);
    return daysAgo > 0 && daysAgo <= 14;
  });

  console.log(`Eligible qualifier tournaments (Monday/Tuesday League or Pinawarra, 1-14 days ago): ${candidates.length}`);

  function daysAgo(mt) {
    const d = toIsoDate(mt.startLocal || mt.startUtc || "");
    return (new Date(today).getTime() - new Date(d).getTime()) / (1000 * 60 * 60 * 24);
  }

  if (candidates.length > 0) {
    const preview = candidates
      .slice()
      .sort((a, b) => daysAgo(a) - daysAgo(b));
    console.log("Candidates (most recent first):");
    preview.forEach((mt) => console.log(`  - ${mt.name} | ${toIsoDate(mt.startLocal || mt.startUtc || "")} | ${daysAgo(mt).toFixed(0)} day(s) ago | status: ${mt.status}`));
  }

  if (candidates.length === 0) {
    console.error("No eligible tournaments found in the past 14 days — cannot build machines.json.");
    process.exit(1);
  }

  candidates.sort((a, b) => daysAgo(a) - daysAgo(b));

  const latest = candidates[0];
  console.log(`\nPulling machine list from: "${latest.name}" (${toIsoDate(latest.startLocal || latest.startUtc || "")}, tournamentId: ${latest.tournamentId})`);

  const detail = await matchplayGet(`/api/tournaments/${latest.tournamentId}?includeArenas=true`);
  const tournamentObj = detail.data || detail;
  const arenas = tournamentObj.arenas || [];
  console.log(`Arenas returned: ${arenas.length}`);

  if (arenas.length === 0) {
    console.error("Tournament detail response had no arenas array — nothing to write. Raw response follows:");
    console.error(JSON.stringify(detail, null, 2).slice(0, 3000));
    process.exit(1);
  }

  const machines = arenas
    .map((a) => ({
      name: (a.name || a.arenaName || "").trim(),
      active: (a.status || "").toLowerCase() === "active"
    }))
    .filter((m) => m.name)
    .map((m) => {
      if (Object.prototype.hasOwnProperty.call(STATUS_OVERRIDES, m.name)) {
        return { name: m.name, active: STATUS_OVERRIDES[m.name] };
      }
      return m;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const output = {
    sourceName: latest.name,
    sourceDate: toIsoDate(latest.startLocal || latest.startUtc || ""),
    machines: machines
  };

  fs.writeFileSync("machines.json", JSON.stringify(output, null, 2));
  console.log(`\nWrote ${machines.length} machines to machines.json.`);
}

main().catch((err) => {
  console.error("FATAL ERROR:", err.message);
  process.exit(1);
});
