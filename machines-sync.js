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
const OPDB_API_TOKEN = process.env.OPDB_API_TOKEN;
const OPDB_BASE = "https://opdb.org";

if (!MATCHPLAY_API_TOKEN) {
  console.error("Missing MATCHPLAY_API_TOKEN environment variable.");
  process.exit(1);
}
if (!OPDB_API_TOKEN) {
  console.warn("Missing OPDB_API_TOKEN — machines will be written without era info.");
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

const SILVERBALL_MANIA_BASE = "https://rules.silverballmania.com";

// Silverball Mania's rules site supports a direct, deterministic lookup by
// OPDB ID (confirmed pattern from the site's own creator) — covering
// roughly 1960s through mid-1980s machines. Since it's a real ID lookup
// rather than a name-based guess, it's more reliable than search whenever
// it applies, so it's checked first for older machines specifically.
async function checkSilverballManiaUrl(opdbId) {
  if (!opdbId) return null;
  const url = `${SILVERBALL_MANIA_BASE}/rules/${encodeURIComponent(opdbId)}`;
  try {
    const res = await fetch(url);
    return res.ok ? url : null;
  } catch (err) {
    return null;
  }
}

const PINBALL_PRIMER_BASE = "https://pinballprimer.github.io";
const PINBALL_PRIMER_REPO_TREE_URL =
  "https://api.github.com/repos/pinballprimer/pinballprimer.github.io/git/trees/main?recursive=1";

// Pinball Primer's page filenames encode the OPDB GROUP id, e.g.
// "avengersiq_Gj66P.html" for group "Gj66P" — this is a real, exact
// identifier match (not a name guess), same reliability tier as
// Silverball Mania. Fetches the repo's full file list once via GitHub's
// API and builds a groupId -> URL map.
async function fetchPinballPrimerIndex() {
  const res = await fetch(PINBALL_PRIMER_REPO_TREE_URL);
  if (!res.ok) throw new Error(`Pinball Primer repo tree fetch -> HTTP ${res.status}`);
  const data = await res.json();
  const tree = data.tree || [];

  const index = {};
  const filenameRegex = /^([^/]+)_([A-Za-z0-9]+)\.html$/;
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    const match = entry.path.match(filenameRegex);
    if (!match) continue;
    const groupId = match[2];
    index[groupId] = `${PINBALL_PRIMER_BASE}/${entry.path}`;
  }
  console.log(`Parsed ${Object.keys(index).length} Pinball Primer pages (indexed by OPDB group ID).`);
  return index;
}

function findPinballPrimerUrl(opdbId, primerIndex) {
  if (!opdbId) return null;
  const groupId = opdbId.split("-")[0];
  return primerIndex[groupId] || null;
}

async function opdbGet(opdbId) {
  const url = `${OPDB_BASE}/api/machines/${encodeURIComponent(opdbId)}?api_token=${OPDB_API_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OPDB ${opdbId} -> HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

const TILTFORUMS_BASE = "https://tiltforums.com";
const RULESHEET_MASTER_LIST_URL = `${TILTFORUMS_BASE}/t/rulesheet-master-list/7230`;
let tiltforumsDebugged = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The Wiki Rulesheets community maintains a single curated index page
// listing every rulesheet by manufacturer, e.g.:
//   <a href="https://tiltforums.com/t/deadpool-rulesheet/4311">Deadpool</a>
// Fetching this ONE page and matching against it is far more reliable
// than searching per-machine (no rate limits, and it's a real curated
// list rather than a fuzzy guess). Live search is only used as a
// fallback for machines the master list doesn't cover.
async function fetchRulesheetMasterList() {
  const res = await fetch(RULESHEET_MASTER_LIST_URL);
  if (!res.ok) throw new Error(`Master list fetch -> HTTP ${res.status}`);
  const html = await res.text();

  // Match any <a ...>text</a> tag first, then pull href out of its
  // attributes separately — this doesn't assume href is the first
  // attribute or that it uses double quotes, since Discourse sometimes
  // renders extra attributes (class, data-*, etc.) before href.
  const anchorRegex = /<a\s+([^>]*)>([^<]*)<\/a>/gi;
  const entries = [];
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = match[1];
    const name = match[2].trim();
    if (!name) continue;

    const hrefMatch = attrs.match(/href\s*=\s*"([^"]+)"/i) || attrs.match(/href\s*=\s*'([^']+)'/i);
    if (!hrefMatch) continue;

    const href = hrefMatch[1];
    if (!/^https?:\/\/(www\.)?tiltforums\.com\/t\//i.test(href)) continue;

    entries.push({ name, url: href.replace(/^http:/, "https:") });
  }
  console.log(`Parsed ${entries.length} rulesheet links from the Master List.`);
  return entries;
}

// Retries on HTTP 429 (rate limited) with increasing backoff — TiltForums
// blocks anonymous search requests fairly aggressively, so a fixed short
// delay between machines isn't enough on its own.
async function tiltforumsSearch(query) {
  const url = `${TILTFORUMS_BASE}/search.json?q=${encodeURIComponent(query)}`;
  const delays = [3000, 6000, 12000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      if (attempt === delays.length) {
        throw new Error(`HTTP 429 (rate limited) after ${delays.length} retries`);
      }
      console.log(`  Rate limited, waiting ${delays[attempt] / 1000}s before retry...`);
      await sleep(delays[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

// Guards against accepting an irrelevant result (e.g. searching "Card
// Whiz" returning "Rick and Morty" as the only hit). Checks BOTH
// directions — the master list often uses a short generic name ("Batman
// 66") while our machine name is a specific edition ("Batman 66
// (Catwoman Signature Edition)"), so at least one direction needs a
// strong (50%+) overlap of meaningful words (3+ letters).
// Common short words that shouldn't count as "meaningful" overlap even
// though they clear the 3-letter length filter — "the" is exactly 3
// letters and was previously letting "The Party Zone" match "The
// Mandalorian" at exactly the 50% threshold on that word alone.
const STOPWORDS = new Set(["the", "and", "for", "with", "from"]);

function meaningfulTokens(name) {
  return tokens(name).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function overlapRatio(tokensA, tokensB) {
  if (tokensA.length === 0) return 0;
  const matched = tokensA.filter((t) => tokensB.indexOf(t) !== -1).length;
  return matched / tokensA.length;
}

function isRelevantTiltforumsMatch(machineName, candidateTitle) {
  const mTokens = meaningfulTokens(machineName);
  const cTokens = meaningfulTokens(candidateTitle || "");
  if (mTokens.length === 0 || cTokens.length === 0) return false;
  return overlapRatio(mTokens, cTokens) >= 0.5 || overlapRatio(cTokens, mTokens) >= 0.5;
}

function pickRelevantTopic(machineName, topics) {
  for (const t of topics) {
    if (isRelevantTiltforumsMatch(machineName, t.title)) return t;
  }
  return null;
}

function findInMasterList(machineName, masterListEntries) {
  for (const entry of masterListEntries) {
    if (isRelevantTiltforumsMatch(machineName, entry.name)) return entry.url;
  }
  return null;
}

// Fallback for machines not found in the master list — searches
// TiltForums directly, restricted to the Wiki Rulesheets category first,
// falling back to an unrestricted search, and rejecting irrelevant results.
async function searchTiltforumsUrl(machineName) {
  try {
    let data = await tiltforumsSearch(`${machineName} rulesheet #game-specific:rulesheet-wikis`);
    if (!tiltforumsDebugged) {
      console.log("---- FIRST RAW TILTFORUMS SEARCH RESPONSE (for field-mapping check) ----");
      console.log(JSON.stringify(data, null, 2).slice(0, 3000));
      console.log("---- end raw response ----");
      tiltforumsDebugged = true;
    }

    let topics = (data && data.topics) || [];
    let top = pickRelevantTopic(machineName, topics);

    if (!top) {
      await sleep(1500);
      data = await tiltforumsSearch(`${machineName} rulesheet`);
      topics = (data && data.topics) || [];
      top = pickRelevantTopic(machineName, topics);
    }

    if (!top || !top.slug || !top.id) {
      console.log(`  No relevant TiltForums rulesheet found for "${machineName}" — leaving blank.`);
      return null;
    }
    return `${TILTFORUMS_BASE}/t/${top.slug}/${top.id}`;
  } catch (err) {
    console.warn(`  Could not search TiltForums for "${machineName}": ${err.message}`);
    return null;
  }
}

// Buckets machines into a rough era based on manufacture year. Adjust
// the cutoffs here if you'd rather draw the lines differently.
function classifyEra(year) {
  if (!year) return null;
  if (year < 1977) return "EM";
  if (year < 2000) return "Classic";
  return "Modern";
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
      active: (a.status || "").toLowerCase() === "active",
      opdbId: a.opdbId || null
    }))
    .filter((m) => m.name)
    .map((m) => {
      if (Object.prototype.hasOwnProperty.call(STATUS_OVERRIDES, m.name)) {
        return { name: m.name, active: STATUS_OVERRIDES[m.name], opdbId: m.opdbId };
      }
      return m;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (OPDB_API_TOKEN) {
    console.log(`\nLooking up era info for ${machines.length} machines via OPDB...`);
    let debugged = false;
    for (const m of machines) {
      if (!m.opdbId) {
        m.era = null;
        continue;
      }
      try {
        const info = await opdbGet(m.opdbId);
        if (!debugged) {
          console.log("---- FIRST RAW OPDB RESPONSE (for field-mapping check) ----");
          console.log(JSON.stringify(info, null, 2).slice(0, 2000));
          console.log("---- end raw response ----");
          debugged = true;
        }
        const dateStr = info.manufacture_date || info.manufactureDate || "";
        const year = dateStr ? parseInt(dateStr.slice(0, 4), 10) : null;
        m.era = classifyEra(year);
        m.manufactureYear = year || null;
        m.manufacturer = (info.manufacturer && info.manufacturer.name) || null;
        m.type = info.type || null;
        m.display = info.display || null;
        m.playerCount = info.player_count || null;
        m.ipdbId = info.ipdb_id || null;
        // Use OPDB's own canonical opdb_id from the response (may resolve
        // aliases differently than what Match Play originally gave us) —
        // this is what powers the Match Play rules-sheet link.
        m.opdbId = info.opdb_id || m.opdbId;
        const img = Array.isArray(info.images) && info.images.length > 0 ? info.images[0] : null;
        m.imageUrl = (img && img.urls && (img.urls.medium || img.urls.small)) || null;
      } catch (err) {
        console.warn(`  Could not look up OPDB info for "${m.name}" (${m.opdbId}): ${err.message}`);
        m.era = null;
        m.opdbId = null;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  console.log(`\nFetching TiltForums Rulesheet Master List...`);
  let masterList = [];
  try {
    masterList = await fetchRulesheetMasterList();
  } catch (err) {
    console.warn(`Could not fetch the Master List, will rely on search only: ${err.message}`);
  }

  console.log(`\nFetching Pinball Primer index...`);
  let primerIndex = {};
  try {
    primerIndex = await fetchPinballPrimerIndex();
  } catch (err) {
    console.warn(`Could not fetch the Pinball Primer index: ${err.message}`);
  }

  console.log(`\nMatching machines against all known rulesheet sources...`);
  for (const m of machines) {
    // Silverball Mania: deterministic ID lookup, ~1960s-mid1980s coverage.
    m.silverballManiaUrl = null;
    if (m.manufactureYear && m.manufactureYear < 1986 && m.opdbId) {
      m.silverballManiaUrl = await checkSilverballManiaUrl(m.opdbId);
      await sleep(500);
    }

    // Pinball Primer: deterministic ID lookup via the pre-fetched index —
    // no extra network request per machine.
    m.pinballPrimerUrl = findPinballPrimerUrl(m.opdbId, primerIndex);

    // TiltForums: master list first (curated, no rate limit), falling
    // back to live search (rate-limit-safe, relevance-checked) only if
    // the master list doesn't cover this machine.
    const masterMatch = findInMasterList(m.name, masterList);
    if (masterMatch) {
      m.tiltforumsUrl = masterMatch;
    } else {
      m.tiltforumsUrl = await searchTiltforumsUrl(m.name);
      await sleep(3000);
    }
  }
  const resolvedCount = machines.filter((m) => m.silverballManiaUrl || m.pinballPrimerUrl || m.tiltforumsUrl).length;
  console.log(`Resolved at least one rulesheet source for ${resolvedCount} of ${machines.length} machines.`);

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
