/** Self-contained dashboard. Fetches /api/snapshot and follows /api/events. */
export function monitorPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Goal monitor</title>
  <style>
    :root {
      --bg: #0e1218;
      --panel: #171e28;
      --line: #2a3545;
      --text: #e8eef6;
      --muted: #8b9bb0;
      --active: #7dd3a8;
      --pending: #8b9bb0;
      --done: #7eb8e8;
      --blocked: #e07a7a;
      --gold: #e7c37a;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: ui-sans-serif, system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 var(--sans); }
    header {
      display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: baseline;
      padding: 16px 20px; border-bottom: 1px solid var(--line); position: sticky; top: 0;
      background: var(--bg); z-index: 2;
    }
    header h1 { font-size: 15px; font-weight: 650; margin: 0; letter-spacing: .02em; }
    .live { color: var(--active); font-family: var(--mono); font-size: 12px; }
    .live.stale { color: var(--blocked); }
    .meta { color: var(--muted); font-family: var(--mono); font-size: 12px; }
    .grid {
      display: grid; gap: 16px; padding: 16px 20px;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    section {
      background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px;
      min-width: 0;
    }
    h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    .statrow { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 10px; }
    .stat { font-family: var(--mono); font-size: 12px; }
    .stat b { color: var(--gold); font-weight: 650; }
    ul { margin: 0; padding: 0 0 0 18px; }
    li { margin: 0 0 4px; }
    .stage { margin: 0 0 10px; padding: 8px 10px; border-left: 3px solid var(--pending); background: #121821; }
    .stage.active { border-color: var(--active); }
    .stage.complete { border-color: var(--done); opacity: .85; }
    .stage .title { font-weight: 650; }
    .badge { font-family: var(--mono); font-size: 11px; color: var(--muted); }
    pre, .snap {
      font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-word;
      background: #0b0f14; border: 1px solid var(--line); border-radius: 6px; padding: 10px; max-height: 280px; overflow: auto;
      margin: 8px 0 0;
    }
    .timeline { list-style: none; padding: 0; max-height: 420px; overflow: auto; }
    .timeline li { padding: 8px 0; border-bottom: 1px solid var(--line); }
    .empty { color: var(--muted); }
    .wide { grid-column: 1 / -1; }
  </style>
</head>
<body>
  <header>
    <h1>Goal monitor</h1>
    <span id="live" class="live stale">connecting</span>
    <span id="header-meta" class="meta"></span>
  </header>
  <div class="grid">
    <section>
      <h2>Status &amp; memory</h2>
      <div id="status"></div>
    </section>
    <section>
      <h2>Steps &amp; criteria</h2>
      <div id="steps"></div>
    </section>
    <section>
      <h2>Compaction vs DAG isolation</h2>
      <div id="compaction"></div>
    </section>
    <section class="wide">
      <h2>DAG admission — context brought into the current session</h2>
      <div id="dag"></div>
    </section>
    <section class="wide">
      <h2>History</h2>
      <ol id="history" class="timeline"></ol>
    </section>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const fmtTime = (at) => {
      try { return new Date(at).toISOString().replace("T", " ").replace("Z", "Z"); }
      catch { return String(at); }
    };
    const memoryHtml = (memory) => {
      if (!memory) return '<p class="empty">No memory recorded.</p>';
      const list = (items) => items && items.length
        ? "<ul>" + items.map((item) => "<li>" + esc(item) + "</li>").join("") + "</ul>"
        : '<p class="empty">none</p>';
      return (
        '<div class="statrow"><span class="stat">revision <b>' + esc(memory.revision) + "</b></span></div>" +
        "<h2>Proved</h2>" + list(memory.proved) +
        "<h2>Unresolved</h2>" + list(memory.unresolved) +
        "<h2>Next</h2><p>" + (memory.next ? esc(memory.next) : '<span class="empty">none</span>') + "</p>"
      );
    };
    const render = (snap) => {
      const goal = snap.goal;
      $("header-meta").textContent = goal
        ? (goal.status + " · step " + goal.stage.k + "/" + goal.stage.n + " · gen " + goal.execution.generation)
        : "no goal";
      if (!goal) {
        $("status").innerHTML = '<p class="empty">No goal is currently set. Start one with /goal or /goal-multi.</p>';
        $("steps").innerHTML = "";
      } else {
        const ex = goal.execution;
        $("status").innerHTML =
          '<div class="statrow">' +
            '<span class="stat">id <b>' + esc(goal.goalId.slice(0, 8)) + "</b></span>" +
            '<span class="stat">no-progress <b>' + ex.noProgressRemaining + "/" + ex.noProgressLimit + "</b></span>" +
            '<span class="stat">requests <b>' + ex.totalRemaining + "/" + ex.totalLimit + "</b></span>" +
            '<span class="stat">lifetime <b>' + ex.lifetimeRequests + "</b></span>" +
          "</div>" +
          (goal.pauseReason ? "<p>Paused: " + esc(goal.pauseReason) + "</p>" : "") +
          memoryHtml(goal.memory);
        $("steps").innerHTML = goal.stages.map((stage) => {
          const mark = stage.status === "complete" ? "x" : stage.status === "active" ? ">" : " ";
          const criteria = stage.criteria.length
            ? "<ul>" + stage.criteria.map((c) =>
                "<li>" + esc(c.text) + (c.requiresHumanDecision ? ' <span class="badge">human decision</span>' : "") + "</li>"
              ).join("") + "</ul>"
            : '<p class="empty">criteria awaiting confirmation</p>';
          return '<div class="stage ' + stage.status + '"><div class="title">[' + mark + "] " +
            (stage.index + 1) + ". " + esc(stage.title) +
            ' <span class="badge">' + esc(stage.status) + "</span></div>" + criteria + "</div>";
        }).join("");
      }
      const c = snap.compaction;
      $("compaction").innerHTML =
        '<div class="statrow">' +
          '<span class="stat">isolated steps <b>' + c.isolatedSteps + "</b></span>" +
          '<span class="stat">host compactions <b>' + c.hostCompactions + "</b></span>" +
          '<span class="stat">contexts that would have been compacted <b>' + c.contextsWouldHaveBeenCompacted + "</b></span>" +
          '<span class="stat">messages dropped at isolation <b>' + c.droppedAtIsolation + "</b></span>" +
        "</div>" +
        (c.events.length
          ? "<ul>" + c.events.slice().reverse().map((ev) =>
              "<li>" + fmtTime(ev.at) + " · step " + ev.step + " · " + esc(ev.reason || "compact") +
              (ev.tokensBefore != null ? " · tokensBefore " + ev.tokensBefore : "") + "</li>"
            ).join("") + "</ul>"
          : '<p class="empty">No host compactions yet. Step isolation still replaces a context at each completed stage.</p>');
      const dag = snap.dag.lastAdmission;
      if (!dag) {
        $("dag").innerHTML = '<p class="empty">No provider context observed yet. After a step starts or advances, this shows the exact snapshot and surviving messages brought into the new session.</p>';
      } else {
        const kept = dag.kept.map((m) =>
          "<li>" + esc(m.label) + (m.timestamp != null ? ' <span class="badge">' + m.timestamp + "</span>" : "") + "</li>"
        ).join("");
        $("dag").innerHTML =
          '<div class="statrow">' +
            '<span class="stat">step <b>' + dag.step + "</b></span>" +
            '<span class="stat">generation <b>' + dag.generation + "</b></span>" +
            '<span class="stat">cutoff <b>' + (dag.isolationCutoff ?? "none") + "</b></span>" +
            '<span class="stat">kept <b>' + dag.keptCount + "</b></span>" +
            '<span class="stat">dropped <b>' + dag.droppedCount + "</b></span>" +
          "</div>" +
          (dag.handoff ? "<p>Handoff: " + esc(dag.handoff) + "</p>" : "") +
          "<h2>Kept messages</h2><ul>" + (kept || '<li class="empty">none</li>') + "</ul>" +
          "<h2>Injected snapshot</h2><pre class='snap'>" + esc(dag.injectedSnapshot) + "</pre>";
      }
      const hist = snap.history.slice().reverse();
      $("history").innerHTML = hist.length
        ? hist.map((ev) => {
            if (ev.kind === "clear") {
              return "<li><span class='badge'>" + fmtTime(ev.at) + "</span> cleared" +
                (ev.goalId ? " " + esc(ev.goalId.slice(0, 8)) : "") + "</li>";
            }
            const mem = ev.memory
              ? " · mem r" + ev.memoryRevision +
                (ev.memory.next ? " next: " + esc(ev.memory.next) : "")
              : "";
            return "<li><span class='badge'>" + fmtTime(ev.at) + "</span> " +
              esc(ev.source) + " · " + esc(ev.status) +
              " · step " + ev.step + "/" + ev.stages +
              " · gen " + ev.generation +
              (ev.stageTitle ? " · " + esc(ev.stageTitle) : "") +
              mem + "</li>";
          }).join("")
        : '<li class="empty">No goal history yet.</li>';
    };
    const mark = (ok) => {
      const el = $("live");
      el.textContent = ok ? "live" : "reconnecting";
      el.className = "live" + (ok ? "" : " stale");
    };
    const apply = (snap) => { mark(true); render(snap); };
    const poll = () => fetch("/api/snapshot").then((r) => r.json()).then(apply).catch(() => mark(false));
    poll();
    setInterval(poll, 2000);
    try {
      const es = new EventSource("/api/events");
      es.onmessage = (ev) => apply(JSON.parse(ev.data));
      es.onerror = () => mark(false);
    } catch {
      /* polling is enough */
    }
  </script>
</body>
</html>`;
}
