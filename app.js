// WRF Valencia static site. Plain JS, no build step, no external resources.
// Data (all paths relative to this page):
//   runs.json                  [{run_id, name, title, event, init, end, created_at, domains, variables}]
//                              (a missing "event" means a forecast: listed under "Predicciones")
//   runs/<id>/meta.json        {run_id, title, event, init, end, domains: [{id, name, dx_km, times,
//                               variables: {<key>: {kind, label, units, frames: [{time, file}]}}}],
//                               points, model, physics_summary, created_at}
//   runs/<id>/points.json      {points: [{name, slug, chart, total_mm, max_step_mm, max_step_time, ...}]}
// Deep link: #run=<id>&var=<kind>&d=<n>&t=<ISO UTC>
"use strict";

(function () {
  var KINDS = [
    ["rain_total", "Lluvia total"],
    ["rain_step", "Lluvia por hora"],
    ["wind10", "Viento"],
    ["t2", "Temperatura"],
    ["mslp", "Presión"],
    ["refl", "Radar"]
  ];
  var PLAY_MS = 900;

  var state = { runs: [], meta: null, points: [], runId: null, kind: "rain_total", dom: null, idx: 0,
                timer: null, wantTime: null };

  function $(id) { return document.getElementById(id); }

  var fmtLocal = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
  var fmtLocalShort = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
  });
  var fmtUtc = new Intl.DateTimeFormat("es-ES", {
    timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
  });

  function parseIso(s) { return new Date(s); }
  function local(s) { return fmtLocal.format(parseIso(s)); }
  function localShort(s) { return fmtLocalShort.format(parseIso(s)); }
  function utc(s) { return fmtUtc.format(parseIso(s)) + " UTC"; }

  function showError(msg) {
    var e = $("error");
    e.textContent = msg;
    e.hidden = !msg;
  }

  function getJson(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) { throw new Error(url + ": HTTP " + r.status); }
      return r.json();
    });
  }

  // ------------------------------------------------------------------ deep links
  // A malformed hash (e.g. a stray "%") is ignored as a whole: the defaults are loaded instead.
  function readHash() {
    var out = {};
    try {
      location.hash.replace(/^#/, "").split("&").forEach(function (kv) {
        if (!kv) { return; }
        var i = kv.indexOf("=");
        if (i > 0) { out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); }
      });
    } catch (e) {
      return {};
    }
    return out;
  }

  function writeHash() {
    var f = currentFrames()[state.idx];
    var parts = ["run=" + encodeURIComponent(state.runId), "var=" + encodeURIComponent(state.kind),
                 "d=" + encodeURIComponent(state.dom)];
    if (f) { parts.push("t=" + encodeURIComponent(f.time)); }
    history.replaceState(null, "", "#" + parts.join("&"));
  }

  function kindOf(v) {
    if (!v) { return null; }
    if (v === "rain_total") { return v; }
    if (/^rain_/.test(v)) { return "rain_step"; }
    return v;
  }

  // ------------------------------------------------------------------ model helpers
  function domain() {
    if (!state.meta) { return null; }
    for (var i = 0; i < state.meta.domains.length; i++) {
      if (state.meta.domains[i].id === state.dom) { return state.meta.domains[i]; }
    }
    return null;
  }

  function variableOf(dom, kind) {
    if (!dom) { return null; }
    var keys = Object.keys(dom.variables);
    for (var i = 0; i < keys.length; i++) {
      if (dom.variables[keys[i]].kind === kind) { return dom.variables[keys[i]]; }
    }
    return null;
  }

  function currentVar() { return variableOf(domain(), state.kind); }
  function currentFrames() { var v = currentVar(); return v ? v.frames : []; }

  function tabLabel(kind, v) {
    if (kind === "rain_step" && v && v.interval_min && v.interval_min !== 60) {
      return v.interval_min % 60 === 0 ? "Lluvia cada " + (v.interval_min / 60) + " h"
                                       : "Lluvia cada " + v.interval_min + " min";
    }
    for (var i = 0; i < KINDS.length; i++) { if (KINDS[i][0] === kind) { return KINDS[i][1]; } }
    return kind;
  }

  function closestIndex(frames, iso) {
    if (!iso || !frames.length) { return 0; }
    var t = parseIso(iso).getTime(), best = 0, bestD = Infinity;
    frames.forEach(function (f, i) {
      var d = Math.abs(parseIso(f.time).getTime() - t);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // ------------------------------------------------------------------ rendering
  function fillRuns() {
    var sel = $("run");
    sel.textContent = "";
    var groups = [["Eventos", true], ["Predicciones", false]];
    groups.forEach(function (g) {
      var runs = state.runs.filter(function (r) { return Boolean(r.event) === g[1]; });
      if (!runs.length) { return; }
      var og = document.createElement("optgroup");
      og.label = g[0];
      runs.forEach(function (r) {
        var o = document.createElement("option");
        o.value = r.run_id;
        o.textContent = (r.title || r.name || r.run_id) + " · inicio " + utc(r.init);
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = state.runId;
  }

  function fillDomains() {
    var sel = $("domain");
    sel.textContent = "";
    state.meta.domains.forEach(function (d) {
      var o = document.createElement("option");
      o.value = String(d.id);
      o.textContent = d.name + " · " + d.dx_km + " km";
      sel.appendChild(o);
    });
    sel.value = String(state.dom);
  }

  function fillTabs() {
    var box = $("vars");
    box.textContent = "";
    var dom = domain();
    KINDS.forEach(function (k) {
      var v = variableOf(dom, k[0]);
      if (!v) { return; }
      var b = document.createElement("button");
      b.type = "button";
      b.className = "tab";
      b.textContent = tabLabel(k[0], v);
      b.setAttribute("aria-pressed", String(k[0] === state.kind));
      b.addEventListener("click", function () { selectKind(k[0]); });
      box.appendChild(b);
    });
  }

  function showFrame() {
    var frames = currentFrames();
    var v = currentVar();
    var dom = domain();
    var slider = $("time");
    slider.max = String(Math.max(0, frames.length - 1));
    slider.value = String(state.idx);
    slider.disabled = frames.length <= 1;
    $("prev").disabled = $("next").disabled = $("play").disabled = frames.length <= 1;
    var f = frames[state.idx];
    var img = $("map");
    if (!f) {
      img.removeAttribute("src");
      img.alt = "Sin mapa para esta selección";
      $("time-label").textContent = "";
      return;
    }
    img.src = "runs/" + encodeURIComponent(state.runId) + "/" + f.file;
    var label = tabLabel(state.kind, v);
    img.alt = label + " (" + v.units + ") en " + dom.name + " (" + dom.dx_km + " km), válido el " +
      local(f.time) + " hora local (" + utc(f.time) + ")";
    $("caption").textContent = label + " · " + dom.name + " (" + dom.dx_km + " km)" +
      (state.kind === "rain_total" ? " · acumulada en toda la simulación" : "");
    $("time-label").textContent = "Válido: " + local(f.time) + " hora local · " + utc(f.time) +
      (frames.length > 1 ? " · " + (state.idx + 1) + "/" + frames.length : "");
    var nxt = frames[(state.idx + 1) % frames.length];
    if (nxt && nxt !== f) { (new Image()).src = "runs/" + encodeURIComponent(state.runId) + "/" + nxt.file; }
    writeHash();
  }

  function fillPoints() {
    var sec = $("points-section");
    var body = $("points-body");
    var charts = $("point-charts");
    body.textContent = "";
    charts.textContent = "";
    var pts = state.points.length ? state.points : (state.meta.points || []);
    sec.hidden = !pts.length;
    pts.forEach(function (p) {
      var tr = document.createElement("tr");
      // max_step_time is the END of the wettest interval
      var when = p.max_step_time ? "hasta las " + localShort(p.max_step_time) : "—";
      var cells = [p.name, "d" + String(p.domain).padStart(2, "0") + " (" + p.dx_km + " km)",
                   fmtNum(p.total_mm), fmtNum(p.max_step_mm) + (p.step_label ? " en " + p.step_label : ""), when];
      cells.forEach(function (c, i) {
        var td = document.createElement(i === 0 ? "th" : "td");
        if (i === 0) { td.scope = "row"; }
        td.textContent = c;
        tr.appendChild(td);
      });
      body.appendChild(tr);
      if (p.chart) {
        var fig = document.createElement("figure");
        var img = document.createElement("img");
        img.loading = "lazy";
        img.src = "runs/" + encodeURIComponent(state.runId) + "/" + p.chart;
        img.alt = "Serie temporal en " + p.name + ": lluvia por intervalo y acumulada, temperatura a 2 m y viento a 10 m";
        img.width = 576;
        img.height = 378;
        var cap = document.createElement("figcaption");
        cap.className = "muted";
        cap.textContent = p.name + " · celda " + p.grid_lat + ", " + p.grid_lon + " (" + Math.round(p.hgt_m) + " m)";
        fig.appendChild(img);
        fig.appendChild(cap);
        charts.appendChild(fig);
      }
    });
  }

  function fmtNum(v) {
    if (v === null || v === undefined) { return "—"; }
    return Number(v).toLocaleString("es-ES", { maximumFractionDigits: 1 });
  }

  function fillInfo() {
    var m = state.meta;
    $("run-title").textContent = m.title || m.name;
    $("run-info").textContent = (m.event ? "Evento" : "Predicción") + " · inicio " + local(m.init) +
      " hora local (" + utc(m.init) + ") · hasta " + local(m.end) + " hora local";
    var mod = m.model || {};
    $("model-info").textContent = "Modelo WRF " + (mod.wrf || "?") + " · condiciones iniciales y de contorno " +
      (mod.ic_bc || "?") + (mod.boundary_interval_hours ? " cada " + mod.boundary_interval_hours + " h" : "") +
      (mod.e_vert ? " · " + mod.e_vert + " niveles verticales" : "") + ". " + (m.physics_summary || "") +
      ". Mapas generados el " + (m.created_at ? local(m.created_at) : "?") + " hora local.";
    document.title = (m.title || m.name) + " · WRF Valencia";
  }

  // ------------------------------------------------------------------ actions
  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    $("play").setAttribute("aria-pressed", "false");
    $("play").textContent = "Reproducir";
  }

  function togglePlay() {
    if (state.timer) { stop(); return; }
    $("play").setAttribute("aria-pressed", "true");
    $("play").textContent = "Pausa";
    state.timer = setInterval(function () { step(1, true); }, PLAY_MS);
  }

  function step(delta, fromTimer) {
    var n = currentFrames().length;
    if (n <= 1) { return; }
    if (!fromTimer) { stop(); }
    state.idx = (state.idx + delta + n) % n;
    showFrame();
  }

  function selectKind(kind) {
    var frames = currentFrames();
    var keep = frames[state.idx] ? frames[state.idx].time : null;
    state.kind = kind;
    state.idx = closestIndex(currentFrames(), keep);
    fillTabs();
    showFrame();
  }

  function selectDomain(id) {
    var frames = currentFrames();
    var keep = frames[state.idx] ? frames[state.idx].time : null;
    state.dom = id;
    if (!currentVar()) { state.kind = "rain_total"; }
    state.idx = closestIndex(currentFrames(), keep);
    fillTabs();
    showFrame();
  }

  function loadRun(id, wanted) {
    stop();
    showError("");
    state.runId = id;
    return Promise.all([
      getJson("runs/" + encodeURIComponent(id) + "/meta.json"),
      getJson("runs/" + encodeURIComponent(id) + "/points.json").catch(function () { return { points: [] }; })
    ]).then(function (res) {
      state.meta = res[0];
      state.points = (res[1] && res[1].points) || [];
      var doms = state.meta.domains.map(function (d) { return d.id; });
      var finest = state.meta.domains.slice().sort(function (a, b) { return a.dx_km - b.dx_km || b.id - a.id; })[0];
      var d = wanted && wanted.d ? parseInt(wanted.d, 10) : NaN;
      state.dom = doms.indexOf(d) >= 0 ? d : finest.id;
      var k = kindOf(wanted && wanted["var"]);
      state.kind = k && variableOf(domain(), k) ? k : "rain_total";
      state.idx = closestIndex(currentFrames(), wanted && wanted.t);
      fillRuns();
      fillInfo();
      fillDomains();
      fillTabs();
      fillPoints();
      showFrame();
    }).catch(function (e) {
      showError("No se pudo cargar la simulación " + id + " (" + e.message + ").");
    });
  }

  function init() {
    $("run").addEventListener("change", function (e) { loadRun(e.target.value, null); });
    $("domain").addEventListener("change", function (e) { selectDomain(parseInt(e.target.value, 10)); });
    $("time").addEventListener("input", function (e) { stop(); state.idx = parseInt(e.target.value, 10) || 0; showFrame(); });
    $("prev").addEventListener("click", function () { step(-1); });
    $("next").addEventListener("click", function () { step(1); });
    $("play").addEventListener("click", togglePlay);
    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.altKey || e.ctrlKey || e.metaKey) { return; }
      if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
      if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
    });
    window.addEventListener("hashchange", function () {
      var h = readHash();
      var f = currentFrames()[state.idx];
      if (h.run && h.run !== state.runId) { loadRun(h.run, h); return; }
      if (f && h.t === f.time && kindOf(h["var"]) === state.kind && parseInt(h.d, 10) === state.dom) { return; }
      if (h.run && state.meta) { loadRun(h.run, h); }
    });

    getJson("runs.json").then(function (runs) {
      state.runs = Array.isArray(runs) ? runs : [];
      if (!state.runs.length) { showError("Todavía no hay simulaciones publicadas."); return; }
      var h = readHash();
      var ids = state.runs.map(function (r) { return r.run_id; });
      var id = ids.indexOf(h.run) >= 0 ? h.run : ids[0];
      return loadRun(id, id === h.run ? h : null);
    }).catch(function (e) {
      showError("No se pudo cargar la lista de simulaciones (" + e.message + ").");
    });
  }

  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); } else { init(); }
})();
