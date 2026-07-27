// machines-sync.js
//
// Standalone script: pulls the most recent PAST Monday/Tuesday league
// night's machine (arena) list from Match Play and writes machines.json.
// Only needs MATCHPLAY_API_TOKEN — no IFPA API involved at all.
//
// Confirmed API shapes (from real responses, 2026-07):
//   GET /api/tournaments?owner={id}&limit=100&page=N
//     -> { data: [{ tournamentId, name, status, startUtc, startLocal,
//                    test, seriesId, ... }] }
//   GET /api/tournaments/{id}?includeArenas=true
//     -> { data: { ..., arenas: [{ arenaId, name, status,
//                    tournamentArena: { status, ... }, ... }] } }
//        arena "status" (top-level) is the machine's general active/
//        inactive state — that's what we show on the site.

const fs = require("fs");

const MATCHPLAY_API_TOKEN = process.env.MATCHPLAY_API_TOKEN;
const MATCHPLAY_OWNER_ID = 25018;
const MATCHPLAY_BASE = "https://app.matchplay.events";

if (!MATCHPLAY_API_TOKEN) {
  console.error("Missing MATCHPLAY_API_TOKEN environment variable.");
  process.exit(1);
}

async function matchplayGet(path) {
  const url = `${MATCHPLAY_BASE}${path}`;
  const res = await fetch(url, {
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

async function main() {
  const today = toIsoDate(new Date().toISOString());
  console.log(`Today (for filtering out future tournaments): ${today}`);

  const all = await fetchAllMatchplayTournaments();

  const real = all.filter((mt) => !mt.test && !/template/i.test(mt.name || ""));
  console.log(`After excluding test/template tournaments: ${real.length}`);

  const leagueNights = real.filter((mt) => {
    const n = tokens(mt.name);
    const isLeague = (n.indexOf("monday") !== -1 || n.indexOf("tuesday") !== -1) && n.indexOf("league") !== -1;
    if (!isLeague) return false;
    const isPast = mt.status === "completed" || toIsoDate(mt.startLocal || mt.startUtc || "") <= today;
    return isPast;
  });
  console.log(`Past Monday/Tuesday league nights found: ${leagueNights.length}`);
  if (leagueNights.length > 0) {
    console.log("Most recent 3 candidates:");
    leagueNights
      .slice()
      .sort((a, b) => {
        const da = toIsoDate(a.startLocal || a.startUtc || "");
        const db = toIsoDate(b.startLocal || b.startUtc || "");
        return da < db ? 1 : -1;
      })
      .slice(0, 3)
      .forEach((mt) => console.log(`  - ${mt.name} | ${toIsoDate(mt.startLocal || mt.startUtc || "")} | status: ${mt.status}`));
  }

  if (leagueNights.length === 0) {
    console.error("No past Monday/Tuesday league tournaments found — cannot build machines.json.");
    process.exit(1);
  }

  leagueNights.sort((a, b) => {
    const da = toIsoDate(a.startLocal || a.startUtc || "");
    const db = toIsoDate(b.startLocal || b.startUtc || "");
    return da < db ? 1 : -1;
  });

  const latest = leagueNights[0];
  console.log(`\nPulling machine list from: "${latest.name}" (${toIsoDate(latest.startLocal || latest.startUtc || "")}, status: ${latest.status}, tournamentId: ${latest.tournamentId})`);

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
