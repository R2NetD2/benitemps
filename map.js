// BeniTemps interactive map: OpenStreetMap basemap + model layer + click-for-value.
// Plain JS, no build step, nothing loaded from outside this site:
//   vendor/maplibre-gl.mjs (+ -shared, -worker, .css)   MapLibre GL JS, BSD-3-Clause
//   vendor/pmtiles.js                                    PMTiles reader, BSD-3-Clause
//   basemap/basemap.json + *.pmtiles + fonts/            built by `wrfrun basemap` (optional:
//                                                        without it the model layer shows on a plain background)
// Model values come from runs/<id>/web/dNN/<var>_<time>.png (see src/wrfrun/webgrid.py for the
// encoding) and are located with the WRF Lambert projection in meta.json domains[].grid.
// Exposes window.BeniMap; app.js falls back to the static PNG maps when init() resolves false.
"use strict";

(function () {
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  var WATER = "#aad3df", LAND = "#f2efe9", PLAIN = "#e8e4dc";
  // Precipitation-like fields carry their own per-pixel alpha (ALPHA_RAMP), so the layer itself is opaque;
  // continuous fields cover the whole domain and get a uniform, lighter layer opacity instead.
  var OPACITY = { rain_total: 1, rain_step: 1, refl: 1, wind10: 0.55, t2: 0.5, mslp: 0.45 };
  var RAMPED = { rain_total: true, rain_step: true, refl: true };
  // alpha per legend bin (0 = lowest coloured bin): light rain lets the basemap show through, cores stay solid
  var ALPHA_RAMP = [0.3, 0.42, 0.54, 0.66, 0.75], ALPHA_MAX = 0.8;
  var CARDINAL = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];

  var M = null, map = null, bm = null, popup = null, objUrl = null, markers = [];
  var cache = {};
  var cur = { runBase: "", dom: null, view: null, variable: null, frame: null, data: null, click: null,
              describe: null, token: 0 };

  // ------------------------------------------------------------------ projection (mirror of webgrid.py)
  function coneOf(g) {
    if (g._n !== undefined) { return g._n; }
    var t1 = g.truelat1 * D2R, t2 = g.truelat2 * D2R;
    g._n = Math.abs(g.truelat1 - g.truelat2) < 1e-6 ? Math.sin(t1) :
      (Math.log(Math.cos(t1)) - Math.log(Math.cos(t2))) /
      (Math.log(Math.tan(Math.PI / 4 + t2 / 2)) - Math.log(Math.tan(Math.PI / 4 + t1 / 2)));
    g._f = Math.cos(t1) * Math.pow(Math.tan(Math.PI / 4 + t1 / 2), g._n) / g._n;
    return g._n;
  }

  function lccXY(lat, lon, g) {
    var n = coneOf(g);
    var dlon = ((lon - g.stand_lon + 540) % 360) - 180;
    var rho = g.earth_r_m * g._f / Math.pow(Math.tan(Math.PI / 4 + lat * D2R / 2), n);
    var th = n * dlon * D2R;
    return [rho * Math.sin(th), -rho * Math.cos(th)];
  }

  // fractional mass-point indices [j, i] of lat/lon
  function lccIJ(lat, lon, g) {
    if (!g._xy0) { g._xy0 = lccXY(g.lat0, g.lon0, g); }
    var p = lccXY(lat, lon, g);
    return [(p[1] - g._xy0[1]) / g.dx_m, (p[0] - g._xy0[0]) / g.dx_m];
  }

  // lat/lon of fractional mass-point indices (inverse of lccIJ)
  function lccLL(j, i, g) {
    var n = coneOf(g);
    if (!g._xy0) { g._xy0 = lccXY(g.lat0, g.lon0, g); }
    var x = g._xy0[0] + i * g.dx_m, y = g._xy0[1] + j * g.dx_m;
    var rho = (n < 0 ? -1 : 1) * Math.sqrt(x * x + y * y);
    var th = n < 0 ? Math.atan2(-x, y) : Math.atan2(x, -y);
    var lat = 2 * Math.atan(Math.pow(g.earth_r_m * g._f / rho, 1 / n)) * R2D - 90;
    var lon = ((g.stand_lon + th / n * R2D + 540) % 360) - 180;
    return [lat, lon];
  }

  function mercY(lat) { return Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2)); }
  function invMercY(y) { return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * R2D; }

  // cell index in the value image (row 0 = north) or -1 outside the grid
  function cellIndex(lat, lon, g) {
    var ji = lccIJ(lat, lon, g);
    var j = Math.round(ji[0]), i = Math.round(ji[1]);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) { return -1; }
    return (g.ny - 1 - j) * g.nx + i;
  }

  // Web-Mercator-aligned canvas over the domain, with a precomputed pixel -> fractional cell lookup
  // (fj, fi; NaN outside the grid). paint() interpolates between cells, so the colour boundaries follow
  // smooth contours instead of the 1-cell staircase.
  function makeView(dom) {
    var g = dom.grid, ring = dom.outline;
    var w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    ring.forEach(function (p) { w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]); });
    var W = Math.max(256, Math.min(1600, Math.round(g.nx * 4)));
    var H = Math.max(64, Math.round(W * (mercY(n) - mercY(s)) / ((e - w) * D2R)));
    var fj = new Float32Array(W * H), fi = new Float32Array(W * H);
    var yN = mercY(n), yS = mercY(s);
    for (var y = 0; y < H; y++) {
      var lat = invMercY(yN - (y + 0.5) / H * (yN - yS));
      for (var x = 0; x < W; x++) {
        var ji = lccIJ(lat, w + (x + 0.5) / W * (e - w), g), q = y * W + x;
        var out = ji[0] < -0.5 || ji[1] < -0.5 || ji[0] > g.ny - 0.5 || ji[1] > g.nx - 0.5;   // same cells as cellIndex()
        fj[q] = out ? NaN : ji[0];
        fi[q] = out ? NaN : ji[1];
      }
    }
    var canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    return { W: W, H: H, fj: fj, fi: fi, canvas: canvas, bounds: [w, s, e, n],
             coords: [[w, n], [e, n], [e, s], [w, s]] };
  }

  // ------------------------------------------------------------------ values
  function decodeImage(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) { throw new Error(url + ": HTTP " + r.status); }
      return r.blob();
    }).then(function (blob) {
      return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    }).then(function (bmp) {
      var c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      var ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    });
  }

  function loadValues(url, enc) {
    if (!cache[url]) {
      cache[url] = decodeImage(url).then(function (px) {
        var n = px.length / 4, vals = new Float32Array(n), dir = new Uint8Array(n);
        for (var k = 0; k < n; k++) {
          vals[k] = px[4 * k + 3] ? (px[4 * k] * 256 + px[4 * k + 1]) / enc.scale + enc.offset : NaN;
          dir[k] = px[4 * k + 2];
        }
        return { vals: vals, dir: dir };
      });
      cache[url].catch(function () { delete cache[url]; });
    }
    return cache[url];
  }

  function hexRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function palette(leg) {
    if (leg._p) { return leg._p; }
    leg._p = { lv: leg.levels, bins: leg.colors.map(hexRgb), under: leg.under ? hexRgb(leg.under) : null,
               over: hexRgb(leg.over) };
    return leg._p;
  }

  // legend bin of a value: -1 below levels[0] ("under"), p.bins.length at or above the last level ("over")
  function binOf(p, v) {
    var lv = p.lv;
    if (v < lv[0]) { return -1; }
    if (v >= lv[lv.length - 1]) { return p.bins.length; }
    var lo = 0, hi = lv.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (v >= lv[mid]) { lo = mid; } else { hi = mid; } }
    return Math.min(lo, p.bins.length - 1);
  }

  function colorOfBin(p, b) { return b < 0 ? p.under : (b >= p.bins.length ? p.over : p.bins[b]); }

  // bilinear value at fractional mass-point indices; falls back to the nearest cell next to missing data
  function sample(vals, g, fj, fi) {
    var j = Math.min(Math.max(fj, 0), g.ny - 1), i = Math.min(Math.max(fi, 0), g.nx - 1);
    var j0 = Math.max(0, Math.min(Math.floor(j), g.ny - 2)), i0 = Math.max(0, Math.min(Math.floor(i), g.nx - 2));
    var ty = j - j0, tx = i - i0;
    var r0 = (g.ny - 1 - j0) * g.nx, r1 = r0 - g.nx;   // image rows of grid rows j0 and j0 + 1 (row 0 = north)
    var v = (vals[r0 + i0] * (1 - tx) + vals[r0 + i0 + 1] * tx) * (1 - ty) +
            (vals[r1 + i0] * (1 - tx) + vals[r1 + i0 + 1] * tx) * ty;
    return v === v ? v : vals[(g.ny - 1 - Math.round(j)) * g.nx + Math.round(i)];
  }

  function paint() {
    var view = cur.view, data = cur.data, v = cur.variable;
    if (!view || !map.getSource("model")) { return; }
    var ctx = view.canvas.getContext("2d");
    var img = ctx.createImageData(view.W, view.H), out = img.data;
    if (data && v && v.legend && cur.dom) {
      var p = palette(v.legend), g = cur.dom.grid, fjs = view.fj, fis = view.fi, vals = data.vals;
      var ramped = RAMPED[v.kind];
      for (var q = 0; q < fjs.length; q++) {
        var fj = fjs[q];
        if (fj !== fj) { continue; }      // outside the grid
        var val = sample(vals, g, fj, fis[q]);
        if (val !== val) { continue; }    // NaN
        var b = binOf(p, val), c = colorOfBin(p, b);
        if (!c) { continue; }
        var a = !ramped ? 1 : (b < 0 ? ALPHA_RAMP[0] : (b < ALPHA_RAMP.length ? ALPHA_RAMP[b] : ALPHA_MAX));
        out[4 * q] = c[0]; out[4 * q + 1] = c[1]; out[4 * q + 2] = c[2]; out[4 * q + 3] = Math.round(255 * a);
      }
    }
    ctx.putImageData(img, 0, 0);
    view.canvas.toBlob(function (blob) {
      if (!blob) { return; }
      var url = URL.createObjectURL(blob);
      map.getSource("model").updateImage({ url: url, coordinates: view.coords });
      if (objUrl) { URL.revokeObjectURL(objUrl); }
      objUrl = url;
    });
    if (v) { map.setPaintProperty("model", "raster-opacity", OPACITY[v.kind] || 0.7); }
  }

  // ------------------------------------------------------------------ basemap style
  var LANDCOVER = ["match", ["get", "kind"], "forest", "#cfe3c3", "farmland", "#eef0d5", "grassland", "#e2edc8",
                   "scrub", "#dfe8c9", "barren", "#ece6da", "urban_area", "#e2ddd8", "glacier", "#ffffff", LAND];
  var LANDUSE = ["match", ["get", "kind"],
                 "residential", "#e3dfda", ["industrial", "railway"], "#e6dde6", ["commercial", "retail"], "#ecdfe2",
                 ["farmland", "farmyard", "allotments"], "#edf0d2", ["orchard", "vineyard", "plant_nursery"], "#dcebc4",
                 ["forest", "wood"], "#c9e0bd", ["park", "garden", "grass", "meadow", "recreation_ground", "village_green",
                 "nature_reserve", "national_park", "protected_area", "golf_course", "pitch"], "#d6eac6",
                 ["cemetery"], "#d3e0cd", ["aerodrome", "airfield"], "#e6e4ee", ["military", "naval_base"], "#efdcdc",
                 ["beach", "sand"], "#f2e8cc", ["wetland"], "#d4e8e3", ["scrub", "heath"], "#dfe8c9",
                 ["school", "university", "college", "hospital", "kindergarten"], "#efe6d8",
                 "rgba(0,0,0,0)"];

  function osmLayers(id, z0, z1) {
    var fills = [
      { id: id + "-earth", type: "fill", source: id, "source-layer": "earth", minzoom: z0, paint: { "fill-color": LAND } },
      { id: id + "-landcover", type: "fill", source: id, "source-layer": "landcover", minzoom: z0,
        paint: { "fill-color": LANDCOVER } },
      { id: id + "-landuse", type: "fill", source: id, "source-layer": "landuse", minzoom: z0,
        paint: { "fill-color": LANDUSE } },
      { id: id + "-water", type: "fill", source: id, "source-layer": "water", minzoom: z0,
        filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": WATER } },
      { id: id + "-buildings", type: "fill", source: id, "source-layer": "buildings", minzoom: Math.max(z0, 13),
        paint: { "fill-color": "#d9d0c8", "fill-opacity": 0.7 } }
    ];
    var w = function (a, b) { return ["interpolate", ["exponential", 1.6], ["zoom"], 6, a, 14, b]; };
    var road = function (kinds, color, a, b, zmin) {
      return { id: id + "-road-" + kinds[0], type: "line", source: id, "source-layer": "roads",
               minzoom: Math.max(z0, zmin), maxzoom: z1, filter: ["in", ["get", "kind"], ["literal", kinds]],
               layout: { "line-cap": "round", "line-join": "round" },
               paint: { "line-color": color, "line-width": w(a, b) } };
    };
    var lines = [
      { id: id + "-waterway", type: "line", source: id, "source-layer": "water", minzoom: z0, maxzoom: z1,
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#7fb3d5", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.3, 14, 1.4] } },
      // boundaries sit on top of the model layer: a white casing keeps them readable over any colour
      { id: id + "-boundary-casing", type: "line", source: id, "source-layer": "boundaries", minzoom: z0, maxzoom: z1,
        filter: ["in", ["get", "kind"], ["literal", ["country", "region"]]],
        layout: { "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-opacity": 0.75,
                 "line-width": ["match", ["get", "kind"], "country", 4.5, 3.2] } },
      { id: id + "-boundary-region", type: "line", source: id, "source-layer": "boundaries", minzoom: z0, maxzoom: z1,
        filter: ["==", ["get", "kind"], "region"],
        layout: { "line-join": "round" },
        paint: { "line-color": "#5a4a66", "line-width": 1.4, "line-dasharray": [3, 1.5] } },
      { id: id + "-boundary-country", type: "line", source: id, "source-layer": "boundaries", minzoom: z0, maxzoom: z1,
        filter: ["==", ["get", "kind"], "country"],
        layout: { "line-join": "round" },
        paint: { "line-color": "#3d2f4a", "line-width": 2, "line-dasharray": [4, 1.5] } },
      road(["minor_road"], "#cfc8bf", 0.1, 1.2, 12),
      road(["major_road"], "#e9c48a", 0.2, 2.6, 7),
      road(["highway"], "#de8c66", 0.5, 3.4, 5),
      { id: id + "-rail", type: "line", source: id, "source-layer": "roads", minzoom: Math.max(z0, 9), maxzoom: z1,
        filter: ["==", ["get", "kind"], "rail"],
        paint: { "line-color": "#8f8f8f", "line-width": 0.8, "line-dasharray": [4, 2] } }
    ];
    var place = function (suffix, details, zmin, font, a, b) {
      return { id: id + "-place-" + suffix, type: "symbol", source: id, "source-layer": "places",
               minzoom: Math.max(z0, zmin), maxzoom: z1,
               filter: ["all", ["==", ["get", "kind"], "locality"], ["in", ["get", "kind_detail"], ["literal", details]]],
               layout: { "text-field": ["get", "name"], "text-font": [font], "text-max-width": 8,
                         "text-size": ["interpolate", ["linear"], ["zoom"], 6, a, 14, b] },
               paint: { "text-color": "#1c1c1c", "text-halo-color": "#ffffff", "text-halo-width": 2,
                        "text-halo-blur": 0.3 } };
    };
    var labels = [
      place("city", ["city"], 0, "Noto Sans Medium", 13, 20),
      place("town", ["town"], 8, "Noto Sans Medium", 11, 16),
      place("village", ["village", "suburb", "hamlet"], 11, "Noto Sans Regular", 10, 14)
    ].filter(function (l) { return l.minzoom < z1; });
    return { fills: fills, lines: lines, labels: labels };
  }

  function buildStyle() {
    var base = new URL("basemap/", location.href).href;
    var sources = {}, fills = [], shades = [], lines = [], labels = [];
    if (bm) {
      bm.osm.forEach(function (t, k) {
        var id = "osm-" + t.tier, next = bm.osm[k + 1];
        sources[id] = { type: "vector", url: "pmtiles://" + base + t.file };
        var L = osmLayers(id, t.minzoom, next ? next.minzoom : 24);
        fills = fills.concat(L.fills);
        lines = lines.concat(L.lines);
        labels = labels.concat(L.labels);
      });
      bm.dem.forEach(function (t, k) {
        var id = "dem-" + t.tier, next = bm.dem[k + 1];
        sources[id] = { type: "raster-dem", url: "pmtiles://" + base + t.file, encoding: t.encoding || "terrarium",
                        tileSize: 512 };
        shades.push({ id: id + "-hillshade", type: "hillshade", source: id, minzoom: t.minzoom,
                      maxzoom: next ? next.minzoom : 24,
                      paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#5b5048",
                               "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#7a6e64" } });
      });
      var first = Object.keys(sources)[0];
      if (first) { sources[first].attribution = bm.attribution; }
    }
    sources.model = { type: "image", url: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
                      coordinates: [[-1, 1], [1, 1], [1, -1], [-1, -1]] };
    sources.mask = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
    var layers = [{ id: "bg", type: "background", paint: { "background-color": bm ? WATER : PLAIN } }]
      .concat(fills, shades, [
        { id: "model", type: "raster", source: "model", paint: { "raster-opacity": 0.75, "raster-resampling": "linear",
                                                                 "raster-fade-duration": 0 } }
      ], lines, [
        { id: "mask", type: "fill", source: "mask", filter: ["==", ["get", "role"], "outside"],
          paint: { "fill-color": "#7a7a7a", "fill-opacity": 0.38 } },
        { id: "mask-edge", type: "line", source: "mask", filter: ["==", ["get", "role"], "edge"],
          paint: { "line-color": "#444444", "line-width": 1.2 } }
      ], labels);
    var style = { version: 8, sources: sources, layers: layers };
    if (bm) { style.glyphs = base + bm.glyphs; }
    return style;
  }

  // ------------------------------------------------------------------ popup
  function fmt(v, d) { return Number(v).toLocaleString("es-ES", { maximumFractionDigits: d, minimumFractionDigits: d }); }

  // one value as text with its unit; long adds the wind direction in degrees
  function fmtValue(v, val, dirByte, long) {
    if (val !== val) { return "Sin dato"; }
    if (v.kind === "wind10") {
      var deg = dirByte * 360 / 255, card = CARDINAL[Math.round(deg / 22.5) % 16];
      return fmt(val, 0) + " km/h · del " + card + (long ? " (" + fmt(deg, 0) + "°)" : "");
    }
    if (v.kind === "rain_total" || v.kind === "rain_step") { return val < 0.05 ? "0 mm" : fmt(val, val < 10 ? 1 : 0) + " mm"; }
    if (v.kind === "refl") { return val < 5 ? "Sin eco" : fmt(val, 0) + " dBZ"; }
    return fmt(val, 1) + " " + v.units;
  }

  function describe(lngLat) {
    var dom = cur.dom, v = cur.variable, f = cur.frame, data = cur.data;
    if (!dom || !v || !f) { return null; }
    var k = cellIndex(lngLat.lat, lngLat.lng, dom.grid);
    if (k < 0) { return "<strong>Fuera de la zona calculada</strong>"; }
    if (!data) { return "Cargando…"; }
    var head = fmtValue(v, data.vals[k], data.dir[k], true);
    var what = cur.describe ? cur.describe(v, f) : "";
    return "<strong>" + head + "</strong><br><span class=\"pop-what\">" + what + "</span><br><span class=\"pop-where\">" +
      fmt(lngLat.lat, 3) + ", " + fmt(lngLat.lng, 3) + " · " + dom.name + " (" + dom.dx_km + " km)</span>";
  }

  function refreshPopup() {
    if (!cur.click || !popup || !popup.isOpen()) { return; }
    var html = describe(cur.click);
    if (html) { popup.setHTML(html); }
  }

  // ------------------------------------------------------------------ public API
  function supported() {
    try {
      var c = document.createElement("canvas");
      return Boolean(window.WebGL2RenderingContext && c.getContext("webgl2")) && typeof createImageBitmap === "function";
    } catch (e) {
      return false;
    }
  }

  function init(container, opts) {
    cur.describe = opts && opts.describe;
    if (!supported() || !window.pmtiles) { return Promise.resolve(false); }
    var bmP = fetch("basemap/basemap.json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    return Promise.all([import("./vendor/maplibre-gl.mjs"), bmP]).then(function (res) {
      M = res[0];
      bm = res[1];
      var protocol = new window.pmtiles.Protocol();
      M.addProtocol("pmtiles", protocol.tile);
      var focus = bm && bm.focus;
      // a hidden (0 x 0) container never fires "load": show it now; app.js hides it again if unused
      var el = document.getElementById(container);
      el.hidden = false;
      map = new M.Map({
        container: container,
        style: buildStyle(),
        center: focus ? focus.center : [-0.38, 39.47],
        zoom: focus ? focus.zoom : 9,
        minZoom: 3,
        maxZoom: 14.5,   // MapLibre zooms: about openstreetmap.org's 15.5; the 1 km cells are big blocks by then
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false
      });
      map.touchZoomRotate.disableRotation();
      // the container changes size with the page layout (cards wrap, tabs, phone rotation), not only on window resize
      if (window.ResizeObserver) { new ResizeObserver(function () { map.resize(); }).observe(el); }
      map.addControl(new M.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new M.ScaleControl({ unit: "metric" }), "bottom-left");
      popup = new M.Popup({ closeButton: true, closeOnClick: false, maxWidth: "260px" });
      map.on("click", function (e) {
        cur.click = e.lngLat;
        var html = describe(e.lngLat);
        if (html) { popup.setLngLat(e.lngLat).setHTML(html).addTo(map); }
      });
      // wait for the style only: "load" also waits for a first render, which a background tab never does
      return new Promise(function (resolve) {
        if (map.isStyleLoaded()) { resolve(true); return; }
        map.once("style.load", function () { resolve(true); });
        map.on("error", function (e) { if (window.console) { console.warn("map:", e && e.error && e.error.message); } });
      });
    }).catch(function (e) {
      if (window.console) { console.warn("interactive map unavailable:", e); }
      return false;
    });
  }

  function hasGrid(dom) { return Boolean(dom && dom.grid && dom.outline); }

  function setDomain(dom, runBase, fit) {
    cur.runBase = runBase;
    if (cur.dom !== dom) {
      cur.dom = dom;
      cur.view = hasGrid(dom) ? makeView(dom) : null;
      cur.data = null;
      var ring = dom.outline || [];
      map.getSource("mask").setData({ type: "FeatureCollection", features: ring.length ? [
        { type: "Feature", properties: { role: "outside" },
          geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
                                                     ring.slice().reverse()] } },
        { type: "Feature", properties: { role: "edge" }, geometry: { type: "LineString", coordinates: ring } }
      ] : [] });
    }
    if (fit && cur.view) {
      var b = cur.view.bounds, focus = bm && bm.focus;
      var inFocus = focus && focus.center[0] > b[0] && focus.center[0] < b[2] && focus.center[1] > b[1] &&
        focus.center[1] < b[3] && (b[2] - b[0]) > (focus.bbox[2] - focus.bbox[0]);
      if (inFocus && dom.dx_km <= 1.5) {
        map.jumpTo({ center: focus.center, zoom: focus.zoom });
      } else {
        map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 16, animate: false });
      }
    }
  }

  function showFrame(variable, frame) {
    cur.variable = variable;
    cur.frame = frame;
    var token = ++cur.token;
    if (!cur.view || !frame || !frame.values || !variable.encoding) {
      cur.data = null;
      paint();
      return Promise.resolve(false);
    }
    var url = cur.runBase + frame.values;
    return loadValues(url, variable.encoding).then(function (data) {
      if (token !== cur.token) { return true; }
      cur.data = data;
      paint();
      refreshPopup();
      return true;
    }).catch(function (e) {
      if (window.console) { console.warn(e); }
      cur.data = null;
      paint();
      return false;
    });
  }

  function prefetch(variable, frame) {
    if (frame && frame.values && variable && variable.encoding) {
      loadValues(cur.runBase + frame.values, variable.encoding).catch(function () {});
    }
  }

  function setPoints(points) {
    markers.forEach(function (m) { m.remove(); });
    markers = [];
    (points || []).forEach(function (p) {
      var el = document.createElement("div");
      el.className = "pt";
      var dot = document.createElement("span");
      dot.className = "pt-dot";
      var lbl = document.createElement("span");
      lbl.className = "pt-lbl";
      lbl.textContent = p.name;
      el.appendChild(dot);
      el.appendChild(lbl);
      markers.push(new M.Marker({ element: el, anchor: "left", offset: [-5, 0] }).setLngLat([p.lon, p.lat]).addTo(map));
    });
  }

  // one row of equal-width colour steps, each labelled with its lower bound; long scales label every other step
  function legendHtml(variable) {
    var leg = variable && variable.legend;
    if (!leg) { return ""; }
    var steps = [];
    if (leg.under) { steps.push([leg.under, "<" + num(leg.levels[0])]); }
    leg.colors.forEach(function (c, k) { steps.push([c, num(leg.levels[k])]); });
    steps.push([leg.over, "≥" + num(leg.levels[leg.levels.length - 1])]);
    var every = steps.length > 18 ? 2 : 1, last = steps.length - 1;
    return "<div class=\"lg-row\">" + steps.map(function (s, k) {
      var show = k % every === 0 && (k === last || last - k >= every);
      return "<div class=\"lg-step\" title=\"" + s[1] + "\"><span class=\"lg-sw\" style=\"background:" + s[0] +
        "\"></span><span class=\"lg-lab\">" + (show || k === last ? s[1] : "&nbsp;") + "</span></div>";
    }).join("") + "</div>";
  }
  function num(v) { return Number(v).toLocaleString("es-ES", { maximumFractionDigits: 1 }); }

  // value of the shown frame at a lat/lon, as text (null while loading or outside the grid)
  function valueAt(lat, lon) {
    var dom = cur.dom, v = cur.variable, data = cur.data;
    if (!dom || !v || !data || !hasGrid(dom)) { return null; }
    var k = cellIndex(lat, lon, dom.grid);
    if (k < 0 || data.vals[k] !== data.vals[k]) { return null; }
    return fmtValue(v, data.vals[k], data.dir[k], false);
  }

  // largest (or smallest) value of the shown frame and the centre of its cell
  function extreme(smallest) {
    var dom = cur.dom, v = cur.variable, data = cur.data;
    if (!dom || !v || !data || !hasGrid(dom)) { return null; }
    var vals = data.vals, best = -1;
    for (var k = 0; k < vals.length; k++) {
      var x = vals[k];
      if (x === x && (best < 0 || (smallest ? x < vals[best] : x > vals[best]))) { best = k; }
    }
    if (best < 0) { return null; }
    var g = dom.grid, j = g.ny - 1 - Math.floor(best / g.nx), i = best % g.nx;   // row 0 = north
    var ll = lccLL(j, i, g);
    return { value: vals[best], text: fmtValue(v, vals[best], data.dir[best], false), lat: ll[0], lon: ll[1] };
  }

  // centre the map on a place and open the value popup there
  function showAt(lat, lon) {
    if (!map) { return; }
    var p = { lat: lat, lng: lon };
    map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 10) });
    cur.click = p;
    var html = describe(p);
    if (html) { popup.setLngLat(p).setHTML(html).addTo(map); }
  }

  window.BeniMap = {
    init: init,
    hasGrid: hasGrid,
    setDomain: setDomain,
    showFrame: showFrame,
    prefetch: prefetch,
    setPoints: setPoints,
    legendHtml: legendHtml,
    valueAt: valueAt,
    extreme: extreme,
    showAt: showAt,
    resize: function () { if (map) { map.resize(); } }
  };
})();
