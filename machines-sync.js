<!--
==========================================================================
 MACHINES PAGE — for Squarespace Code Block
 --------------------------------------------------------------------------
 Pulls the current machine lineup live from machines.json, which your
 GitHub Action generates by reading the arena list from your most recent
 Monday/Tuesday league night on Match Play. No manual list to maintain —
 whenever the machine lineup changes and a league night runs on the new
 lineup, this page updates itself on the next scheduled sync.

 If the list looks empty or wrong after publishing, the most likely cause
 is the machine-name field guess in sync.js needing adjustting — see the
 "RAW ARENA RESPONSE" debug block in that script's Action log to confirm
 the real field name Match Play uses.
==========================================================================
-->

<div id="ipc-machines" class="ipc-machines">
  <div class="ipc-machines-head">
    <h2 class="ipc-machines-title">Current Machine Lineup</h2>
    <p class="ipc-machines-source" id="ipc-machines-source">Loading&hellip;</p>
  </div>
  <div class="ipc-machines-body" id="ipc-machines-grid">
    <p class="ipc-machines-loading">Loading machines&hellip;</p>
  </div>
</div>

<style>
  #ipc-machines, #ipc-machines * { box-sizing: border-box; }

  .ipc-machines {
    --ink: #0f1214;
    --muted: #5b6b76;
    --line: #dfe3e5;
    --surface: #ffffff;
    --panel: #f4f6f7;
    --accent: #d94f30;
    --accent-tint: #fcecdc;
    --font-display: 'Sora', -apple-system, BlinkMacSystemFont, sans-serif;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    max-width: 1250px;
    margin: 2.5rem auto;
    padding: 0 1rem;
    color: var(--ink);
  }

  .ipc-machines-head {
    margin-bottom: 1.5rem;
  }

  .ipc-machines-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.5rem;
    margin: 0 0 0.4rem;
    color: var(--ink);
  }

  .ipc-machines-source {
    font-size: 0.85rem;
    color: var(--muted);
    margin: 0;
  }

  .ipc-machines-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
    margin-bottom: 1.75rem;
  }

  .ipc-machines-grid:last-child {
    margin-bottom: 0;
  }

  .ipc-machines-section-title {
    font-family: var(--font-display);
    font-size: 0.95rem;
    font-weight: 700;
    color: #1d8a5f;
    margin: 0 0 0.75rem;
  }

  .ipc-machines-section-title-inactive {
    color: var(--muted);
  }

  .ipc-machines-loading, .ipc-machines-empty {
    font-size: 0.9rem;
    color: var(--muted);
    grid-column: 1 / -1;
  }

  .ipc-machine-card {
    border: 1px solid var(--line);
    border-left: 4px solid #1d8a5f;
    border-radius: 12px;
    background: var(--surface);
    padding: 1.2rem 1.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    box-shadow: 0 1px 2px rgba(15, 18, 20, 0.03);
    transition: box-shadow 0.15s ease, transform 0.15s ease, opacity 0.15s ease;
  }

  .ipc-machine-card.is-inactive {
    border-left-color: #d94f30;
    opacity: 0.75;
  }

  .ipc-machine-name {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--ink);
    min-width: 0;
  }

  .ipc-machine-badge {
    flex-shrink: 0;
    font-size: 0.64rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.18rem 0.5rem;
    border-radius: 999px;
    white-space: nowrap;
  }

  .ipc-machine-badge-active {
    background: #e1f4eb;
    color: #1d8a5f;
  }

  .ipc-machine-badge-inactive {
    background: var(--panel);
    color: var(--muted);
  }

  .ipc-machine-card:hover {
    box-shadow: 0 4px 12px -6px rgba(15, 18, 20, 0.2);
    transform: translateY(-1px);
  }

  @media (prefers-reduced-motion: reduce) {
    .ipc-machine-card:hover { transform: none; }
  }

  @media (max-width: 640px) {
    .ipc-machines-title { font-size: 1.25rem; }
    .ipc-machines-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  }
</style>

<script>
(function () {
  var MACHINES_JSON_URL = "https://raw.githubusercontent.com/murrayboycee/ipc-machines-sync/main/machines.json";

  var sourceEl = document.getElementById("ipc-machines-source");
  var grid = document.getElementById("ipc-machines-grid");

  function fmtDate(iso) {
    if (!iso) return "";
    var parts = iso.split("-");
    var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }

  fetch(MACHINES_JSON_URL, { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      var machines = (data && Array.isArray(data.machines)) ? data.machines : [];

      if (machines.length === 0) {
        sourceEl.textContent = "Machine list unavailable right now.";
        grid.innerHTML = '<p class="ipc-machines-empty">Check back soon — the machine list couldn\'t be loaded.</p>';
        return;
      }

      var activeMachines = machines.filter(function (m) { return m.active; });
      var inactiveMachines = machines.filter(function (m) { return !m.active; });

      sourceEl.textContent = activeMachines.length + " active, " + inactiveMachines.length + " inactive · lineup from " +
        (data.sourceName || "the latest league night") +
        (data.sourceDate ? " (" + fmtDate(data.sourceDate) + ")" : "");

      function cardHtml(m) {
        return '<div class="ipc-machine-card' + (m.active ? "" : " is-inactive") + '">' +
          '<span class="ipc-machine-name">' + m.name + '</span>' +
          '</div>';
      }

      var sectionsHtml = "";

      if (activeMachines.length > 0) {
        sectionsHtml += '<h3 class="ipc-machines-section-title">Active (' + activeMachines.length + ')</h3>' +
          '<div class="ipc-machines-grid">' + activeMachines.map(cardHtml).join("") + '</div>';
      }

      if (inactiveMachines.length > 0) {
        sectionsHtml += '<h3 class="ipc-machines-section-title ipc-machines-section-title-inactive">Inactive (' + inactiveMachines.length + ')</h3>' +
          '<div class="ipc-machines-grid">' + inactiveMachines.map(cardHtml).join("") + '</div>';
      }

      grid.innerHTML = sectionsHtml;
    })
    .catch(function (err) {
      console.warn("Machines widget: could not load machine list.", err);
      sourceEl.textContent = "Machine list unavailable right now.";
      grid.innerHTML = '<p class="ipc-machines-empty">Couldn\'t load the machine list — please check back soon.</p>';
    });
})();
</script>
