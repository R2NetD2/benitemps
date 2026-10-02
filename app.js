// BeniTemps (WRF Valencia) static site. Plain JS, no build step, no external resources.
// Data (all paths relative to this page):
//   runs.json                  [{run_id, name, title, event, init, end, created_at, domains, variables}]
//                              (a missing "event" means a forecast: listed under "Predicciones")
//   runs/<id>/meta.json        {run_id, title, event, init, end, domains: [{id, name, dx_km, times,
//                               variables: {<key>: {kind, label, units, frames: [{time, file}]}}}],
//                               points, model, physics_summary, created_at}
//   runs/<id>/points.json      {points: [{name, slug, chart, total_mm, max_step_mm, max_step_time, series, ...}]}
//   runs/<id>/web/dNN/...png    value grids for the interactive map (map.js); meta.json domains carry
//                              grid + outline, variables carry legend + encoding, frames carry "values"
// Deep link: #run=<id>&var=<kind>&d=<n>&t=<ISO UTC>
// The interactive map (map.js, MapLibre + OSM basemap) is used when the browser supports it and the
// domain has value grids; otherwise the static PNG maps are shown, as before.
// The side cards ("En tus puntos", "Máximo en el dominio") read the same value grids as the map; without
// them the point values fall back to points.json and the maximum card is hidden. Nothing is estimated.
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
  // what the map shows, for the caption under it
  var CAPTIONS = {
    rain_total: "Precipitación acumulada en toda la simulación",
    wind10: "Viento a 10 m en el instante elegido",
    t2: "Temperatura a 2 m en el instante elegido",
    mslp: "Presión a nivel del mar en el instante elegido",
    refl: "Reflectividad simulada (radar) en el instante elegido"
  };
  // tab icons (24 x 24 stroke paths)
  var ICONS = {
    rain_total: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    rain_step: '<path d="M7 15a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 6a4.5 4.5 0 0 1 .5 8.97"/><path d="M9 18l-1 3"/>' +
               '<path d="M13 18l-1 3"/><path d="M17 17l-1 3"/>',
    wind10: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
    t2: '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>',
    mslp: '<circle cx="12" cy="13" r="8"/><path d="M12 13l3-4"/><path d="M12 3v2"/>',
    refl: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/>'
  };
  var PLAY_MS = 900;

  var state = { runs: [], meta: null, points: [], runId: null, kind: "rain_total", dom: null, idx: 0,
                timer: null, wantTime: null, interactive: false, mapReady: null, fitPending: true, maxAt: null };

  function $(id) { return document.getElementById(id); }

  var fmtLocal = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
  var fmtLocalShort = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
  });
  var fmtLocalDay = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", weekday: "short", day: "numeric", month: "short"
  });
  var fmtLocalHm = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });
  var fmtLocalH = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" });
  var fmtUtc = new Intl.DateTimeFormat("es-ES", {
    timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
  });
  var fmtUtcHm = new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });

  function parseIso(s) { return new Date(s); }
  function local(s) { return fmtLocal.format(parseIso(s)); }
  function localShort(s) { return fmtLocalShort.format(parseIso(s)); }
  // "mié, 16 sept · 08:00"
  function localDayTime(s) { return fmtLocalDay.format(parseIso(s)) + " · " + fmtLocalHm.format(parseIso(s)); }
  function utc(s) { return fmtUtc.format(parseIso(s)) + " UTC"; }
  function utcHm(s) { return fmtUtcHm.format(parseIso(s)); }
  function hoursBetween(a, b) { return Math.round((parseIso(b) - parseIso(a)) / 36e5); }

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

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined) { e.textContent = text; }
    return e;
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

  // t= is the instant the visitor chose; on "Lluvia total" (one frame) it keeps the last instant seen
  // elsewhere, so a shared link and a switch back to a timed variable both land on the same time
  function writeHash() {
    var parts = ["run=" + encodeURIComponent(state.runId), "var=" + encodeURIComponent(state.kind),
                 "d=" + encodeURIComponent(state.dom)];
    if (state.wantTime) { parts.push("t=" + encodeURIComponent(state.wantTime)); }
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

  function stepText(mins) { return mins % 60 === 0 ? (mins / 60) + " h" : mins + " min"; }

  function tabLabel(kind, v) {
    if (kind === "rain_step" && v && v.interval_min && v.interval_min !== 60) {
      return v.interval_min % 60 === 0 ? "Lluvia cada " + (v.interval_min / 60) + " h"
                                       : "Lluvia cada " + v.interval_min + " min";
    }
    for (var i = 0; i < KINDS.length; i++) { if (KINDS[i][0] === kind) { return KINDS[i][1]; } }
    return kind;
  }

  function captionOf(v) {
    if (v.kind === "rain_step") {
      return "Precipitación en " + (v.interval_min && v.interval_min !== 60 ? "los " + stepText(v.interval_min)
        : "la hora") + " anterior" + (v.interval_min && v.interval_min !== 60 ? "es" : "") + " al instante elegido";
    }
    return CAPTIONS[v.kind] || tabLabel(v.kind, v);
  }

  function unitsOf(v) {
    return v.kind === "rain_step" ? v.units + " / " + stepText(v.interval_min || 60) : v.units;
  }

  function domText(dom) { return dom.name + " · " + dom.dx_km + " km"; }

  function closestIndex(frames, iso) {
    if (!iso || !frames.length) { return 0; }
    var t = parseIso(iso).getTime(), best = 0, bestD = Infinity;
    frames.forEach(function (f, i) {
      var d = Math.abs(parseIso(f.time).getTime() - t);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  function runBase() { return "runs/" + encodeURIComponent(state.runId) + "/"; }

  function useInteractive() { return state.interactive && window.BeniMap.hasGrid(domain()); }

  // popup text for the interactive map: what the value is and when it is valid
  function describeValue(v, f) {
    if (v.kind === "rain_total") { return "Lluvia acumulada en toda la simulación"; }
    if (v.kind === "rain_step") {
      var mins = f.interval_min || v.interval_min || 60;
      return "Lluvia en " + stepText(mins) + ", hasta las " + localShort(f.time);
    }
    return tabLabel(v.kind, v) + " · " + localShort(f.time) + " hora local";
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

  // domain segmented control: one button per meta.domains entry
  function fillDomains() {
    var box = $("domain");
    box.textContent = "";
    state.meta.domains.forEach(function (d) {
      var b = el("button");
      b.type = "button";
      b.appendChild(document.createTextNode(d.name + " "));
      b.appendChild(el("span", "mono", d.dx_km + " km"));
      b.setAttribute("aria-pressed", String(d.id === state.dom));
      b.addEventListener("click", function () { if (d.id !== state.dom) { selectDomain(d.id); } });
      box.appendChild(b);
    });
  }

  function markDomains() {
    var btns = $("domain").children;
    state.meta.domains.forEach(function (d, i) { if (btns[i]) { btns[i].setAttribute("aria-pressed", String(d.id === state.dom)); } });
  }

  function fillTabs() {
    var box = $("vars");
    box.textContent = "";
    var dom = domain();
    KINDS.forEach(function (k) {
      var v = variableOf(dom, k[0]);
      if (!v) { return; }
      var b = el("button", "tab");
      b.type = "button";
      b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[k[0]] + "</svg>";
      b.appendChild(document.createTextNode(tabLabel(k[0], v)));
      b.setAttribute("aria-pressed", String(k[0] === state.kind));
      b.addEventListener("click", function () { selectKind(k[0]); });
      box.appendChild(b);
    });
  }

  // local-hour ticks under the slider, placed at their frame's position
  function fillTicks(frames) {
    var box = $("ticks");
    box.textContent = "";
    var n = frames.length;
    if (n < 2) { return; }
    var want = Math.min(7, n), last = -1;
    for (var t = 0; t < want; t++) {
      var i = Math.round(t * (n - 1) / (want - 1));
      if (i === last) { continue; }
      last = i;
      var s = el("span", "", fmtLocalH.format(parseIso(frames[i].time)));
      s.style.left = (100 * i / (n - 1)) + "%";
      box.appendChild(s);
    }
  }

  function showFrame() {
    var frames = currentFrames();
    var v = currentVar();
    var dom = domain();
    var slider = $("time");
    var single = frames.length <= 1;
    slider.max = String(Math.max(0, frames.length - 1));
    slider.value = String(state.idx);
    slider.disabled = single;
    $("prev").disabled = $("next").disabled = $("play").disabled = single;
    var f = frames[state.idx];
    var img = $("map");
    var live = useInteractive();
    $("mapgl").hidden = !live;
    $("static-fig").hidden = live;
    $("legend").hidden = !live;
    // "Lluvia total" is one frame over the whole run: show its window instead of a player that does nothing
    var accum = state.kind === "rain_total";
    $("accum").hidden = !accum;
    $("player").hidden = accum;
    var dataP = Promise.resolve(false);
    if (live) {
      if (state.fitPending) { window.BeniMap.setDomain(dom, runBase(), true); state.fitPending = false; }
      dataP = window.BeniMap.showFrame(v, f);
      $("legend").innerHTML = window.BeniMap.legendHtml(v);
      var after = frames[(state.idx + 1) % frames.length];
      if (after && after !== f) { window.BeniMap.prefetch(v, after); }
    }
    var link = $("static-link");
    link.hidden = !f;
    if (f) { link.href = runBase() + f.file; }
    if (!f || !v) {
      img.removeAttribute("src");
      img.alt = "Sin mapa para esta selección";
      $("time-label").textContent = "";
      $("map-chip").textContent = "";
      updateSide(false);
      return;
    }
    if (!live) { img.src = runBase() + f.file; }
    var label = tabLabel(state.kind, v);
    img.alt = label + " (" + v.units + ") en " + dom.name + " (" + dom.dx_km + " km), válido el " +
      local(f.time) + " hora local (" + utc(f.time) + ")";
    var chip = $("map-chip");
    chip.textContent = "";
    chip.appendChild(el("b", "", label));
    chip.appendChild(el("span", "sep", "·"));
    chip.appendChild(el("span", "mono", domText(dom)));
    $("caption").textContent = captionOf(v);
    $("legend-units").textContent = unitsOf(v);
    if (accum) {
      var start = state.meta.init;
      $("accum-span").textContent = hoursBetween(start, f.time) + " h · toda la simulación";
      $("accum-start").textContent = localDayTime(start);
      $("accum-end").textContent = localDayTime(f.time);
    } else {
      fillTicks(frames);
      state.wantTime = f.time;
    }
    var tl = $("time-label");
    tl.textContent = "";
    tl.appendChild(el("span", "tl-local", localDayTime(f.time)));
    tl.appendChild(el("span", "tl-utc", utc(f.time) + (frames.length > 1 ? " · " + (state.idx + 1) + "/" + frames.length : "")));
    var nxt = frames[(state.idx + 1) % frames.length];
    if (!live && nxt && nxt !== f) { (new Image()).src = runBase() + nxt.file; }
    writeHash();
    updateSide(false);
    dataP.then(function (ok) { if (ok) { updateSide(true); } });
  }

  // ------------------------------------------------------------------ side cards
  function pointList() { return state.points.length ? state.points : ((state.meta && state.meta.points) || []); }

  // value at a point from points.json, only when it describes the shown domain and instant
  function seriesValue(p, v, f) {
    if (p.domain !== state.dom) { return null; }
    if (v.kind === "rain_total") { return p.total_mm === null || p.total_mm === undefined ? null : fmtNum(p.total_mm) + " mm"; }
    var s = p.series;
    var key = { rain_step: "rain_step_mm", t2: "t2_c", wind10: "wind_kmh" }[v.kind];
    if (!s || !key || !s[key] || !s.times) { return null; }
    if (v.kind === "rain_step" && p.step_min && v.interval_min && p.step_min !== v.interval_min) { return null; }
    var i = s.times.indexOf(f.time);
    if (i < 0 || s[key][i] === null || s[key][i] === undefined) { return null; }
    return fmtNum(s[key][i]) + " " + (v.kind === "rain_step" ? "mm" : v.units);
  }

  function updateSide(withGrid) {
    var v = currentVar(), dom = domain(), f = currentFrames()[state.idx];
    var pts = pointList();
    $("pts-card").hidden = !pts.length || !v;
    var ul = $("pts-now");
    ul.textContent = "";
    var fromGrid = withGrid && useInteractive();
    if (v && f) {
      pts.forEach(function (p) {
        var val = fromGrid ? window.BeniMap.valueAt(p.lat, p.lon) : seriesValue(p, v, f);
        var li = el("li");
        li.appendChild(el("span", "pname", p.name));
        li.appendChild(el("span", "pval", val || "—"));
        ul.appendChild(li);
      });
      $("pts-note").textContent = (v.kind === "rain_total" ? "Total de la simulación" : localDayTime(f.time)) +
        " · celda de " + domText(dom) + " que contiene cada punto";
    }
    var mx = fromGrid && v ? window.BeniMap.extreme(v.kind === "mslp") : null;
    state.maxAt = mx;
    $("max-card").hidden = !mx;
    if (mx) {
      $("max-h").textContent = v.kind === "mslp" ? "Mínimo en el dominio" : "Máximo en el dominio";
      var m = /^(-?[\d.,]+) (.+)$/.exec(mx.text);   // "103 mm" -> number + unit; "Sin eco" stays whole
      $("max-val").textContent = m ? m[1] : mx.text;
      $("max-units").textContent = m ? m[2] : "";
      $("max-where").textContent = "En " + coordText(mx.lat, mx.lon) + " · " + domText(dom) +
        (v.kind === "rain_total" ? "" : " · " + localDayTime(f.time));
    }
  }

  function coordText(lat, lon) {
    return fmtNum3(Math.abs(lat)) + "° " + (lat >= 0 ? "N" : "S") + ", " + fmtNum3(Math.abs(lon)) + "° " + (lon >= 0 ? "E" : "O");
  }
  function fmtNum3(v) { return Number(v).toLocaleString("es-ES", { minimumFractionDigits: 3, maximumFractionDigits: 3 }); }

  function fillPoints() {
    var sec = $("points-section");
    var body = $("points-body");
    var charts = $("point-charts");
    body.textContent = "";
    charts.textContent = "";
    var pts = pointList();
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
        var cap = el("figcaption", "", p.name + " · celda " + p.grid_lat + ", " + p.grid_lon + " (" + Math.round(p.hgt_m) + " m)");
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
    $("run-kind").textContent = m.event ? "Evento" : "Predicción";
    $("run-title").textContent = m.title || m.name;
    var info = $("run-info");
    info.textContent = localDayTime(m.init) + " → " + localDayTime(m.end) + " hora local ";
    info.appendChild(el("span", "faint", "· " + utcHm(m.init) + "–" + utcHm(m.end) + " UTC · " +
      hoursBetween(m.init, m.end) + " h"));
    var mod = m.model || {};
    var dl = $("details");
    dl.textContent = "";
    [["Inicio", localDayTime(m.init), ""],
     ["Fin", localDayTime(m.end), ""],
     ["UTC", utcHm(m.init) + " → " + utcHm(m.end), "mono"],
     ["Modelo", "WRF " + (mod.wrf || "?") + " · " + (mod.ic_bc || "?") + " · " + m.domains.length +
       (m.domains.length === 1 ? " dominio" : " dominios"), ""],
     ["Ejecución", m.run_id, "mono"]].forEach(function (r) {
      dl.appendChild(el("dt", "", r[0]));
      dl.appendChild(el("dd", r[2], r[1]));
    });
    $("model-info").textContent = "Modelo WRF " + (mod.wrf || "?") + " · condiciones iniciales y de contorno " +
      (mod.ic_bc || "?") + (mod.boundary_interval_hours ? " cada " + mod.boundary_interval_hours + " h" : "") +
      (mod.e_vert ? " · " + mod.e_vert + " niveles verticales" : "") + ". " + (m.physics_summary || "") +
      ". Mapas generados el " + (m.created_at ? local(m.created_at) : "?") + " hora local.";
    document.title = (m.title || m.name) + " · BeniTemps";
  }

  // ------------------------------------------------------------------ actions
  function setPlaying(on) {
    $("play").setAttribute("aria-pressed", String(on));
    $("play-label").textContent = on ? "Pausa" : "Reproducir";
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    setPlaying(false);
  }

  function togglePlay() {
    if (state.timer) { stop(); return; }
    setPlaying(true);
    state.timer = setInterval(function () { step(1, true); }, PLAY_MS);
  }

  function step(delta, fromTimer) {
    var n = currentFrames().length;
    if (n <= 1) { return; }
    if (!fromTimer) { stop(); }
    state.idx = (state.idx + delta + n) % n;
    showFrame();
  }

  function keepTime() {
    var f = currentFrames()[state.idx];
    return state.kind === "rain_total" && state.wantTime ? state.wantTime : (f ? f.time : null);
  }

  function selectKind(kind) {
    var keep = keepTime();
    stop();
    state.kind = kind;
    state.idx = closestIndex(currentFrames(), keep);
    fillTabs();
    showFrame();
  }

  function selectDomain(id) {
    var keep = keepTime();
    state.dom = id;
    state.fitPending = true;
    if (!currentVar()) { state.kind = "rain_total"; }
    state.idx = closestIndex(currentFrames(), keep);
    markDomains();
    fillTabs();
    showFrame();
  }

  function copyLink() {
    var url = location.href, label = $("copy-label"), status = $("copy-status");
    function done(ok) {
      label.textContent = ok ? "Enlace copiado" : "No se pudo copiar";
      status.textContent = ok ? "Enlace copiado al portapapeles" : "No se pudo copiar. Enlace: " + url;
      setTimeout(function () { label.textContent = "Copiar enlace"; status.textContent = ""; }, 2500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
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
      state.wantTime = (wanted && wanted.t) || null;
      state.idx = closestIndex(currentFrames(), state.wantTime);
      fillRuns();
      fillInfo();
      fillDomains();
      fillTabs();
      fillPoints();
      state.fitPending = true;
      return state.mapReady.then(function (ok) {
        state.interactive = ok;
        if (ok) { window.BeniMap.setPoints(state.meta.points || []); }
        showFrame();
      });
    }).catch(function (e) {
      showError("No se pudo cargar la simulación " + id + " (" + e.message + ").");
    });
  }

  function init() {
    state.mapReady = window.BeniMap
      ? window.BeniMap.init("mapgl", { describe: describeValue }).catch(function () { return false; })
      : Promise.resolve(false);
    $("run").addEventListener("change", function (e) { loadRun(e.target.value, null); });
    $("time").addEventListener("input", function (e) { stop(); state.idx = parseInt(e.target.value, 10) || 0; showFrame(); });
    $("prev").addEventListener("click", function () { step(-1); });
    $("next").addEventListener("click", function () { step(1); });
    $("play").addEventListener("click", togglePlay);
    $("copy-link").addEventListener("click", copyLink);
    $("max-show").addEventListener("click", function () {
      if (state.maxAt) { window.BeniMap.showAt(state.maxAt.lat, state.maxAt.lon); $("viewer").scrollIntoView(); }
    });
    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.altKey || e.ctrlKey || e.metaKey) { return; }
      if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
      if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
    });
    window.addEventListener("hashchange", function () {
      var h = readHash();
      if (h.run && h.run !== state.runId) { loadRun(h.run, h); return; }
      if (h.t === state.wantTime && kindOf(h["var"]) === state.kind && parseInt(h.d, 10) === state.dom) { return; }
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
