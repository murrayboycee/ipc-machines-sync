// machines-sync.js
//
// Pulls the club's current machine (arena) list directly from Match
// Play's organizer-level Arenas endpoint and writes machines.json.
//
// IMPORTANT: this does NOT pull status from inside a specific tournament
// anymore. That was the bug — a tournament's embedded arena list is a
// snapshot from whenever that tournament was configured, which can go
// stale the moment a machine breaks down or gets fixed afterward. The
// dedicated arenas endpoint below reflects Match Play's current,
// authoritative status for every machine, independent of any tournament.
//
// Confirmed API shape (docs.matchplay.events / app.matchplay.events/api-docs):
//   GET /api/arenas?status=active    -> currently-active machines
//   GET /api/arenas?status=inactive  -> currently-inactive machines
//   (both return { data: [{ arenaId, name, status, opdbId, ... }] },
//    same wrapper pattern as every other Match Play endpoint)

const fs = require("fs");

const MATCHPLAY_API_TOKEN = process.env.MATCHPLAY_API_TOKEN;
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

async function fetchArenasByStatus(status) {
  const res = await matchplayGet(`/api/arenas?status=${status}`);
  const list = res.data || (Array.isArray(res) ? res : []);
  console.log(`Fetched ${list.length} arenas with status=${status}.`);
  return list;
}

async function main() {
  console.log("---- FIRST RAW ARENA (active) — for field-mapping check ----");
  const activeArenas = await fetchArenasByStatus("active");
  console.log(JSON.stringify(activeArenas[0], null, 2));
  console.log("---- end raw response ----");

  const inactiveArenas = await fetchArenasByStatus("inactive");

  const machines = []
    .concat(
      activeArenas.map((a) => ({ name: (a.name || "").trim(), active: true })),
      inactiveArenas.map((a) => ({ name: (a.name || "").trim(), active: false }))
    )
    .filter((m) => m.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (machines.length === 0) {
    console.error("No arenas returned at all — nothing to write.");
    process.exit(1);
  }

  const output = {
    updatedAt: new Date().toISOString().slice(0, 10),
    machines: machines
  };

  fs.writeFileSync("machines.json", JSON.stringify(output, null, 2));
  console.log(`\nWrote ${machines.length} machines to machines.json (${activeArenas.length} active, ${inactiveArenas.length} inactive).`);
}

main().catch((err) => {
  console.error("FATAL ERROR:", err.message);
  process.exit(1);
});
