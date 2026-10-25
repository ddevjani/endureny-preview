/**
 * ENDÛRE living background: the <endure-scene> custom element. ES module, no dependencies.
 * NYC skyline on the left, forest and peaks on the right, a winding trail with two runners,
 * birds, clouds, mist, stars, fireflies and planes, running dawn → day → dusk → night → dawn.
 *
 * Markup (snippets/scene-layer.liquid; the fixed wrapper is what pins it to the viewport):
 *   <div class="scene-layer" aria-hidden="true">
 *     <endure-scene start="dawn" cycle-seconds="15"></endure-scene>
 *   </div>
 *
 * Attributes
 *   start          Phase every page load begins at: dawn | morning | noon | golden | dusk | night,
 *                  or a day fraction 0–1. Default "dawn" (0.258). Nothing is restored from storage.
 *   cycle-seconds  Seconds for one full loop. Default 15, minimum 5. The pacing spends time where the
 *                  light changes (sunrise, sunset, the twilights) and lingers at dawn and dusk, so day
 *                  and night pass quickly; it is eased by construction and scales to any length.
 *   lock           Freeze the light at a phase (name or day fraction). `?time=<name>` in the page
 *                  URL does the same, for review.
 *
 * Methods and properties
 *   pause(), play(), paused      Stop / resume the animation (for the WCAG 2.2.2 pause button).
 *   ready                        true once the first full frame has been painted.
 *   getClock()     → { h, m, phase }   24-hour clock of the current light (06:11 at dawn).
 *   getAtmosphere()→ { phase, mist, haze, sky, light, density, day, night }
 *                  mist  = tint of the mist band, haze = horizon colour, sky = mid-sky colour,
 *                  light = colour of the light falling on the land (all RGB 0–255 arrays);
 *                  density = how thick the mist is (0–1); day / night = 0–1.
 *   getMistBand()  → { top, bottom }   where the mist is drawn, in viewport CSS px.
 *   window.endureScene                 The most recently connected element.
 *
 * Events (bubbling)
 *   endure-scene:ready        Once, after the first full frame has been painted.
 *   endure-scene:statechange  On pause() / play(). detail: { paused }.
 *
 * prefers-reduced-motion: reduce → one static dawn frame, no loop. The loop also stops while
 * document.hidden. Canvas resolution is capped at 1.5 × CSS px.
 *
 * Relighting: the static landscape (peaks, city, forests, meadow, trail) is rendered at 24 keyframes
 * evenly spaced in loop time (about every 0.6 s at 15 s per day). Every frame crossfades the two
 * keyframes around the current phase while the next one renders ahead in small time slices on a
 * CPU-backed canvas, so the land relights continuously, never swaps, and no frame pays for a whole
 * keyframe's rasterisation. At most three land canvases exist at once (~3 MB each on a phone).
 */

const { abs, ceil, cos, exp, floor, hypot, imul, max, min, pow, random, round, sign, sin, sqrt, PI } = Math;
const TAU = PI * 2;
const PHASES = { dawn: 0.258, morning: 0.32, noon: 0.5, golden: 0.715, dusk: 0.764, night: 0.93 };
const MAX_DPR = 1.5;
const LAND_SLOTS = 3;
const KEYFRAMES = 24;

/** Every loop starts (and every page load begins) at dawn. */
const LOOP_START = PHASES.dawn;

/* ---------------- math and colour ---------------- */
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgb = (c, a) => (a === undefined ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mod1 = (x) => ((x % 1) + 1) % 1;
const gauss = (x, m, s) => { let d = abs(x - m); d = min(d, 1 - d); return exp(-(d * d) / (2 * s * s)); };
function rng(seed) {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = imul(a ^ (a >>> 15), 1 | a); t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash3(a, b, c) { let h = imul(a | 0, 374761393) + imul(b | 0, 668265263) + imul(c | 0, 1442695041); h = imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function noise(seed) {
  const r = rng(seed), v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = r();
  return (x) => { const i = floor(x), f = x - i, u = f * f * (3 - 2 * f), a = v[i & 1023]; return a + (v[(i + 1) & 1023] - a) * u; };
}
function fbm(n, x, octaves = 5) { let s = 0, a = 0.5, f = 1, t = 0; for (let i = 0; i < octaves; i++) { s += a * n(x * f + i * 17.3); t += a; a *= 0.5; f *= 2.02; } return s / t; }
const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = max(1, w | 0); c.height = max(1, h | 0); return c; };
// Mobile Safari keeps canvas memory until GC unless the backing store is shrunk explicitly.
const freeCanvas = (c) => { if (c) c.width = c.height = 0; };
/* Land keyframes and their scratch band are CPU-backed on purpose: their thousands of paths are then
   rasterised inside the time-sliced render job, instead of all at once on the GPU in the frame that
   first shows the keyframe (a 50–100 ms hitch at 15 s per day). Each keyframe uploads once. */
const cpuContext = (c) => c.getContext('2d', { willReadFrequently: true });
/* Canvas shorthands: the painters below call these hundreds of times. */
const rect = (c, style, x, y, w, h) => { c.fillStyle = style; c.fillRect(x, y, w, h); };
const blend = (c, mode) => { c.globalCompositeOperation = mode; };
const alpha = (c, a) => { c.globalAlpha = a; };
/** Gradient with stops given as offset, colour, offset, colour… */
const withStops = (g, stops) => { for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]); return g; };
const linear = (c, x0, y0, x1, y1, ...stops) => withStops(c.createLinearGradient(x0, y0, x1, y1), stops);
const radial = (c, x, y, r, ...stops) => withStops(c.createRadialGradient(x, y, 0, x, y, r), stops);
/** Fill a closed polygon given as x, y, x, y… */
const poly = (c, style, ...xy) => { c.fillStyle = style; c.beginPath(); c.moveTo(xy[0], xy[1]); for (let i = 2; i < xy.length; i += 2) c.lineTo(xy[i], xy[i + 1]); c.closePath(); c.fill(); };
/** Fill circles given as x, y, r, x, y, r… as one path. */
const discs = (c, style, ...xyr) => { c.fillStyle = style; c.beginPath(); for (let i = 0; i < xyr.length; i += 3) c.arc(xyr[i], xyr[i + 1], xyr[i + 2], 0, TAU); c.fill(); };
const parsePhase = (v) => { if (v == null || v === '') return null; if (v in PHASES) return PHASES[v]; const f = parseFloat(v); return isFinite(f) ? mod1(f) : null; };

/* ---------------- light ---------------- */
const SKY_NIGHT = ['#02050d', '#081226', '#16223b'].map(hex);
const SKY_DAY = ['#2c66b0', '#6aa3da', '#d3e4f1'].map(hex);
const SKY_WARM = ['#283c78', '#c47a84', '#ffad62'].map(hex);
/** Everything the painter needs to know about the light at day fraction t (pure). */
function lightAt(t) {
  const a = (t - 0.25) * TAU, alt = sin(a);
  const day = smooth(-0.1, 0.32, alt), warm = exp(-pow((alt - 0.03) / 0.17, 2)), night = 1 - smooth(-0.28, 0, alt);
  const k = [0.5, 0.72, 0.9];
  const sky = SKY_NIGHT.map((c, i) => mix(mix(c, SKY_DAY[i], day), SKY_WARM[i], warm * k[i]));
  const amb = mix(mix([0.45, 0.55, 0.85], [1, 0.99, 0.97], day), [1.1, 0.74, 0.52], warm * 0.65);
  return {
    t, a, alt, day, warm, night, amb,
    top: sky[0], mid: sky[1], hor: sky[2],
    L: 0.12 + 0.88 * day,
    lights: (1 - smooth(-0.05, 0.2, alt)) * (1 - 0.55 * gauss(t, 0.14, 0.06)),
    mist: min(1, gauss(t, 0.268, 0.03) + 0.35 * gauss(t, 0.79, 0.03) + 0.16 * night),
  };
}
const lit = (c, S, k = 1) => [min(255, c[0] * S.amb[0] * S.L * k), min(255, c[1] * S.amb[1] * S.L * k), min(255, c[2] * S.amb[2] * S.L * k)];
const mistTint = (S) => mix(S.hor, [236, 238, 242], 0.45 * S.day + 0.1);
const sunXAt = (G, S) => G.X(0.5 - 0.44 * cos(S.a));
const WINDOW_LIGHT = ['rgb(255,214,150)', 'rgb(255,232,192)', 'rgb(208,224,255)', 'rgb(255,196,120)'];
const PALETTE = [[124, 120, 114], [128, 100, 86], [92, 106, 122], [156, 150, 138], [84, 86, 92], [110, 112, 118], [140, 128, 112]];

/** Public atmosphere snapshot for overlays (fog-reveal tints its particles with it). */
function atmosphereAt(phase) {
  const S = lightAt(phase), bytes = (c) => c.map((v) => round(clamp(v, 0, 255)));
  return { phase, mist: bytes(mistTint(S)), haze: bytes(S.hor), sky: bytes(S.mid), light: bytes(S.amb.map((v) => v * S.L * 255)), density: S.mist, day: S.day, night: S.night };
}

/* ---------------- pacing: one light-change curve drives both the clock and the keyframes ---------------- */
const STEPS = 720;
/** How much the land's light changes across each 1/720 of the day, from dawn on: ambient colour,
    horizon haze, window lights, moonlight and which side the sun lights (pure, computed once). */
const LIGHT_CHANGE = (() => {
  const probe = (t) => {
    const S = lightAt(t), sun = (0.5 - 0.44 * cos(S.a)) * (S.day * 0.6 + S.warm * 0.9);
    return [S.amb[0] * S.L, S.amb[1] * S.L, S.amb[2] * S.L, S.hor[0] / 255, S.hor[1] / 255, S.hor[2] / 255, S.lights, S.night / 2, S.day / 2, S.warm / 2, sun];
  };
  let prev = probe(LOOP_START);
  return Array.from({ length: STEPS }, (_, i) => { const v = probe(LOOP_START + (i + 1) / STEPS), d = hypot(...v.map((x, j) => x - prev[j])); prev = v; return d; });
})();
const MEAN_CHANGE = LIGHT_CHANGE.reduce((a, b) => a + b) / STEPS;
/** Running total of per-step weights, normalised to 0…1 (STEPS + 1 entries). */
const cumulative = (weights) => { const total = weights.reduce((a, b) => a + b); let acc = 0; return [0, ...weights.map((w) => (acc += w) / total)]; };
/** Day position (0…1 after LOOP_START) where a cumulative curve reaches x. */
function invert(cum, x) {
  let lo = 0, hi = STEPS;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= x) lo = mid; else hi = mid; }
  return (lo + (x - cum[lo]) / (cum[lo + 1] - cum[lo])) / STEPS;
}
/**
 * The loop's pacing. Time spent on each part of the day is proportional to how much the light
 * changes there (so the land relights at an even pace instead of flashing through sunrise and
 * sunset), with a floor so noon and night still pass, plus a lingering hold at dawn and at dusk.
 * Twilights end up long, day and night short; the curve is eased by construction and scales to any
 * cycle length. At 15 s: pre-dawn 2.4 s, dawn 2.8 s, morning–noon 1.6 s, golden 2.5 s, dusk 3.5 s, night 2.2 s.
 */
const PACE = cumulative(LIGHT_CHANGE.map((d, i) => {
  const t = LOOP_START + (i + 0.5) / STEPS, hold = (gauss(t, 0.262, 0.012) + gauss(t, 0.768, 0.012)) / (0.012 * 2.5066);
  return d + MEAN_CHANGE * (0.35 + 0.12 * hold);
}));
/** Unwrapped day position (loops + day fraction) for an unwrapped cycle position. */
const dayAt = (u) => { const loops = floor(u); return LOOP_START + loops + invert(PACE, u - loops); };
/** Cycle position in [0, 1) whose light is the given day fraction. */
const cycleAt = (phase) => { const x = mod1(phase - LOOP_START) * STEPS, i = floor(x); return PACE[i] + (PACE[i + 1] - PACE[i]) * (x - i); };

/* NYC landmarks, left to right: [kind, centre (fraction of scene width), width (U), height (fraction of
   skyline height), fog, colour, seed, tiers as [left, right, height] fractions, extras]. */
const centred = (spec) => spec.map(([wf, hf]) => [(1 - wf) / 2, (1 + wf) / 2, hf]);
const LANDMARKS = [
  ['gen', 0.035, 26, 0.25, 0.06, [96, 110, 126], 301, [[0, 1, 1]], { glass: true, slant: 0.45 }], // Hudson Yards
  ['wtc', 0.08, 30, 0.4, 0.05, null, 302, [], { spire: 0.075 }], // One World Trade
  ['gen', 0.125, 22, 0.27, 0.07, [106, 118, 128], 303, [[0, 1, 0.8], [0.12, 0.88, 0.93], [0.3, 0.7, 1]], { glass: true, antenna: [0.5, 0.05] }],
  ['gen', 0.165, 20, 0.37, 0.05, [100, 112, 124], 304, [[0, 1, 0.82], [0.14, 1, 0.95], [0.3, 0.92, 1]], { glass: true, antenna: [0.6, 0.012] }],
  ['gen', 0.19, 10, 0.35, 0.05, [150, 124, 104], 305, [[0, 1, 0.62], [0, 0.86, 0.74], [0, 0.7, 0.84], [0, 0.52, 0.92], [0, 0.34, 0.97], [0, 0.18, 1]]],
  ['gen', 0.213, 11, 0.36, 0.05, [196, 192, 184], 306, [[0, 1, 1]], { big: true }], // 432 Park
  ['esb', 0.255, 34, 0.31, 0.04, [170, 162, 148], 307, centred([[1, 0.17], [0.84, 0.25], [0.62, 0.82], [0.5, 0.88], [0.4, 0.92], [0.28, 0.96], [0.18, 1]]), { spire: 0.055 }], // Empire State
  ['chrysler', 0.302, 20, 0.27, 0.05, [176, 172, 166], 308, centred([[1, 0.62], [0.74, 0.78]]), { spire: 0.05 }],
];

/* ---------------- world geometry (built once per canvas size; seeded, so identical every load) ---------------- */
function buildWorld(w, h) {
  const VW = max(w, h * 0.82), ox = (w - VW) / 2, U = VW / 1440, HY = round(h * 0.665);
  const X = (f) => ox + f * VW, FX = (x) => (x - ox) / VW;
  const hs = min(h, VW * 0.6);
  const G = { w, h, VW, ox, U, HY, X, FX, hs };
  const r = rng(1977);
  G.far = makeRange(G, [[0.3, 0.15, 0.14], [0.43, 0.23, 0.15], [0.55, 0.3, 0.17], [0.67, 0.24, 0.13], [0.8, 0.28, 0.16], [0.94, 0.21, 0.14], [1.07, 0.25, 0.15]], 11, 0.5, HY + h * 0.01, 0.56);
  G.near = makeRange(G, [[0.48, 0.15, 0.1], [0.6, 0.21, 0.12], [0.71, 0.155, 0.1], [0.87, 0.13, 0.12]], 23, 0.45, HY + h * 0.01, 0.72);
  // Mountains are composited through a band-sized scratch canvas (not a full-screen one).
  G.bandTop = floor(min(G.far.top, G.near.top)) - 4;
  G.band = makeCanvas(w, HY + h * 0.01 + 8 - G.bandTop);
  // city
  const generic = (x, bw, bh, fog, allowRoof) => {
    const b = { x, w: bw, h: bh, fog, col: PALETTE[(r() * PALETTE.length) | 0], glass: r() < 0.25, seed: (r() * 1e6) | 0, tiers: [], roof: null };
    const setbacks = r() < 0.4 ? 1 : r() < 0.25 ? 2 : 0;
    if (!setbacks) b.tiers.push([x, x + bw, HY - bh]);
    else {
      b.tiers.push([x, x + bw, HY - bh * (0.55 + r() * 0.2)]);
      let l = x, rr = x + bw;
      for (let k = 0; k < setbacks; k++) { const ins = bw * (0.08 + r() * 0.12); l += ins; rr -= ins; b.tiers.push([l, rr, k === setbacks - 1 ? HY - bh : HY - bh * (0.78 + 0.1 * k)]); }
    }
    if (r() < 0.18 && bw > 18 * U) b.slant = bw * (0.25 + r() * 0.2);
    if (allowRoof) {
      const tt = b.tiers[b.tiers.length - 1], q = r();
      if (bh < 0.17 * hs && q < 0.5 && !b.slant) b.roof = { type: 'wt', x: tt[0] + (tt[1] - tt[0]) * (0.2 + r() * 0.5), s: 0.8 + r() * 0.5 };
      else if (q < 0.75) b.roof = { type: 'ant', x: tt[0] + (tt[1] - tt[0]) * (0.3 + r() * 0.4), hgt: bh * (0.06 + r() * 0.1) };
    }
    return b;
  };
  /** A row of generic buildings from f0 to f1 (fractions of the scene width), shorter towards the
      edge of town; the seeded draw order matches the prototype exactly. */
  const skyline = ([f0, f1, w0, w1, h0, h1, k, e0, e1, fog, roofs, g0, g1]) => {
    const row = [];
    for (let x = X(f0); x < X(f1);) {
      const bw = (w0 + r() * w1) * U, f = FX(x), bh = (h0 + r() * h1) * hs * (k + (1 - k) * smooth(e0, e1, f));
      row.push(generic(x, bw, bh, fog, roofs || r() < 0.4));
      x += bw * (g0 + r() * g1);
    }
    return row;
  };
  G.cityBack = skyline([-0.03, 0.47, 14, 30, 0.06, 0.15, 0.3, 0.48, 0.3, 0.42, false, 0.65, 0.45]);
  G.cityMid = skyline([-0.02, 0.42, 16, 30, 0.1, 0.13, 0.35, 0.43, 0.28, 0.2, true, 0.9, 0.8]);
  G.landmarks = LANDMARKS.map(([kind, fx, wU, hf, fog, col, seed, tiers, extra = {}]) => {
    const bw = wU * U, bh = hf * hs, x0 = X(fx) - bw / 2;
    return {
      kind, x: x0, w: bw, h: bh, fog, col, seed, glass: extra.glass, big: extra.big, roof: null,
      tiers: tiers.map(([l, r, k]) => [x0 + bw * l, x0 + bw * r, HY - bh * k]),
      slant: extra.slant && bw * extra.slant, spire: (extra.spire || 0) * hs, crownY: HY - bh * 0.8,
      ...(extra.antenna && { roof: { type: 'ant', x: x0 + bw * extra.antenna[0], hgt: extra.antenna[1] * hs } }),
    };
  });
  const LM = G.landmarks;
  G.cityFront = skyline([-0.03, 0.45, 18, 34, 0.035, 0.075, 0.4, 0.46, 0.32, 0.03, true, 0.85, 0.3]);
  G.avi = LM.map((b) => {
    if (b.kind !== 'gen') return [b.x + b.w / 2, HY - b.h - b.spire];
    const tt = b.tiers[b.tiers.length - 1], ant = b.roof && b.roof.type === 'ant';
    return [ant ? b.roof.x : (tt[0] + tt[1]) / 2, HY - b.h - (ant ? b.roof.hgt : 0)];
  });
  for (const b of G.cityMid) if (b.roof && b.roof.type === 'ant' && b.h > 0.17 * hs) G.avi.push([b.roof.x, HY - b.h - b.roof.hgt]);
  // park trees and lamps
  G.park = [];
  for (let row = 0; row < 2; row++) {
    for (let x = X(-0.02); x < X(row ? 0.46 : 0.52);) { const rad = (row ? 8 : 5.5) * U * (0.75 + r() * 0.6); G.park.push({ x, y: HY + (row ? h * 0.008 : h * 0.001) + r() * 2 * U, r: rad, k: 0.8 + r() * 0.4 }); x += rad * (row ? 1.25 : 1.1) * (0.7 + r() * 0.6); }
  }
  G.park.sort((a, b) => a.y - b.y);
  G.lamps = [];
  for (let f = 0.01; f < 0.42; f += 0.018 + r() * 0.01) G.lamps.push([X(f), HY + h * 0.004 + r() * U * 2]);
  // forests
  const n1 = noise(31), n2 = noise(37);
  G.top1 = (f) => HY - h * (0.012 + 0.11 * smooth(0.44, 1.0, f) + 0.025 * (fbm(n1, f * 8) - 0.5));
  G.top2 = (f) => HY + h * 0.02 - h * (0.095 * smooth(0.56, 1.0, f) + 0.02 * (fbm(n2, f * 9) - 0.5));
  G.edge1 = () => HY + h * 0.012;
  G.edge2 = (f) => HY + h * (0.03 + 0.07 * smooth(0.6, 0.95, f));
  G.f1 = makeForest(G, r, 0.44, 1.06, G.top1, G.edge1, 8, 19, 3.4, 4.5);
  G.f2 = makeForest(G, r, 0.565, 1.06, G.top2, G.edge2, 20, 46, 7, 8);
  G.f3 = [];
  for (let f = 0.86; f < 1.07; f += 0.03 + r() * 0.025) { const by = h * (0.8 + r() * 0.17); G.f3.push({ x: X(f), y: by, h: h * (0.28 + r() * 0.32) * (0.6 + (0.6 * (by / h - 0.8)) / 0.17), seed: (r() * 1e6) | 0, k: 0.85 + r() * 0.3 }); }
  G.f3.sort((a, b) => a.y - b.y);
  G.trail = makeTrail(G);
  const P = G.trail, N = P.length;
  const nearTrail = (px, py, pad) => { for (let i = 0; i < N; i += 4) { const p = P[i]; if (abs(p.x - px) < p.w * 0.6 + pad && abs(p.y - py) < p.w * 0.3 + pad) return true; } return false; };
  // meadow details
  G.bushes = [];
  for (let i = 0; i < 90; i++) { const y = HY + (h - HY) * (0.04 + 0.96 * pow(r(), 0.8)), bx = X(-0.02 + r() * 0.9), s = (y - HY) * 0.05 * (0.5 + r()); if (FX(bx) > 0.6 && y < G.edge2(FX(bx)) + s) continue; if (nearTrail(bx, y, s * 1.4)) continue; G.bushes.push({ x: bx, y, s, k: 0.75 + r() * 0.4 }); }
  G.bushes.sort((a, b) => a.y - b.y);
  for (let i = 0; i < 130; i++) r(); // the prototype's unused meadow patches: keeps every later seeded position identical
  G.tufts = [];
  for (let i = 0; i < 1700; i++) { const y = HY + (h - HY) * (0.25 + 0.75 * pow(r(), 0.55)), tx = r() * w, l = (y - HY) * 0.045 * (0.4 + r()); if (nearTrail(tx, y, 0) && r() < 0.8) continue; G.tufts.push({ x: tx, y, l, lean: (r() - 0.5) * l * 0.7, b: (r() * 3) | 0 }); }
  // sky
  G.stars = [];
  for (let i = 0; i < 560; i++) { const y = pow(r(), 1.3) * HY * 0.95; G.stars.push({ x: r() * w, y, s: (0.6 + r() * 1.4) * U, b: 0.25 + 0.75 * pow(r(), 3), f: 0.4 + r() * 2.2, p: r() * TAU, fade: 1 - smooth(HY * 0.45, HY * 0.95, y), c: r() < 0.15 ? '#ffd9b0' : r() < 0.3 ? '#cfe0ff' : '#ffffff' }); }
  G.sprites = [];
  for (let i = 0; i < 7; i++) G.sprites.push(makeCloud(r, U));
  G.clouds = [];
  for (let i = 0; i < 11; i++) { const sp = (r() * 7) | 0, hi = r() < 0.3; G.clouds.push({ sp, x: r() * w, y: h * (hi ? 0.04 + r() * 0.1 : 0.1 + r() * 0.27), sx: hi ? 1.6 + r() : 0.7 + r() * 0.7, sy: hi ? 0.35 : 0.7 + r() * 0.5, a: hi ? 0.45 : 0.85, v: (hi ? 2 : 4 + r() * 5) * U }); }
  G.mist = makeMist(r, w, h);
  G.mistT = makeCanvas(G.mist.width, G.mist.height);
  G.flies = [];
  for (let i = 0; i < 70; i++) { const park = r() < 0.25; G.flies.push({ x: park ? X(0.02 + r() * 0.4) : X(0.48 + r() * 0.5), y: park ? HY + h * (0.005 + r() * 0.03) : h * (0.69 + r() * 0.27), ph: r() * TAU, sp: 0.3 + r() * 0.8, s: 0.6 + r() * 0.8 }); }
  G.glow = makeCanvas(32, 32);
  { const c = G.glow.getContext('2d'), g = radial(c, 16, 16, 16, 0, 'rgba(236,255,170,1)', 0.25, 'rgba(210,255,120,0.55)', 1, 'rgba(180,255,90,0)'); rect(c, g, 0, 0, 32, 32); }
  G.grain = makeCanvas(256, 256);
  { const c = G.grain.getContext('2d'), id = c.createImageData(256, 256), d = id.data; for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 128 + (random() * 2 - 1) * 30; d[i + 3] = 255; } c.putImageData(id, 0, 0); }
  return G;
}
function freeWorld(G) { if (G) [G.band, G.mist, G.mistT, G.glow, G.grain, ...G.sprites.flatMap((s) => [s.cv, s.tint])].forEach(freeCanvas); }

function makeRange(G, peaks, seed, rough, baseY, snowFrac) {
  const { w, h, ox, VW } = G, n = noise(seed), n2 = noise(seed + 7), n3 = noise(seed + 13);
  const cols = ceil(w / 2) + 3, ry = new Float32Array(cols), sd = new Float32Array(cols), tex = new Float32Array(cols);
  const maxH = max(...peaks.map((p) => p[1]));
  let top = baseY;
  for (let i = 0; i < cols; i++) {
    const fx = (i * 2 - ox) / VW;
    let m = 0;
    for (const p of peaks) { const d = abs(fx - p[0]) / p[2]; if (d < 1) m = max(m, p[1] * pow(1 - d, 1.25)); }
    const hh = max(0, m + (fbm(n, fx * 22, 6) - 0.5) * rough * (0.04 + m * 0.9));
    ry[i] = baseY - hh * h;
    top = min(top, ry[i]);
    const snowH = maxH * snowFrac + (n2(fx * 30) - 0.5) * 0.03;
    sd[i] = hh > snowH ? (hh - snowH) * h * (0.6 + 1.3 * fbm(n3, fx * 95, 3)) : 0;
    tex[i] = 0.9 + 0.2 * fbm(n3, fx * 260, 2);
  }
  return { ry, sd, tex, baseY, top };
}
function makeForest(G, r, f0, f1, topFn, edgeFn, hMin, hMax, step, rowDy) {
  const U = G.U, out = [];
  for (let k = 0; k < 14; k++) {
    let x = G.X(f0) + r() * step * U;
    while (x < G.X(f1)) {
      const f = G.FX(x), y = topFn(f) + k * rowDy * U + r() * rowDy * U * 0.7;
      if (y <= edgeFn(f)) out.push({ x, y, h: (hMin + (hMax - hMin) * pow(r(), 1.3)) * U * (1 + k * 0.04), seed: (r() * 1e6) | 0, k: 0.78 + r() * 0.44, dec: r() < 0.12 });
      x += step * U * (0.6 + r() * 0.8);
    }
  }
  return out.sort((a, b) => a.y - b.y);
}
function makeTrail(G) {
  const { X, h, HY, U } = G;
  const cps = [[0.355, 0.667], [0.4, 0.688], [0.43, 0.722], [0.405, 0.772], [0.428, 0.83], [0.515, 0.885], [0.615, 0.858], [0.652, 0.802], [0.7, 0.76], [0.765, 0.733], [0.83, 0.715]].map(([a, b]) => [X(a), b * h]);
  const raw = [];
  for (let i = 0; i < cps.length - 1; i++) {
    const p0 = cps[max(i - 1, 0)], p1 = cps[i], p2 = cps[i + 1], p3 = cps[min(i + 2, cps.length - 1)];
    const cr = (k, s, s2, s3) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * s + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * s2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * s3);
    for (let s = 0; s < 1; s += 1 / 30) raw.push([cr(0, s, s * s, s * s * s), cr(1, s, s * s, s * s * s)]);
  }
  raw.push(cps[cps.length - 1]);
  const cum = [0];
  for (let i = 1; i < raw.length; i++) cum.push(cum[i - 1] + hypot(raw[i][0] - raw[i - 1][0], (raw[i][1] - raw[i - 1][1]) * 2.4));
  const N = 500, pts = [];
  for (let i = 0, j = 0; i < N; i++) {
    const d = (cum[cum.length - 1] * i) / (N - 1);
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const t = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
    pts.push({ x: raw[j][0] + (raw[j + 1][0] - raw[j][0]) * t, y: raw[j][1] + (raw[j + 1][1] - raw[j][1]) * t });
  }
  pts.forEach((p, i) => {
    const a = pts[max(0, i - 1)], b = pts[min(N - 1, i + 1)], l = hypot(b.x - a.x, b.y - a.y) || 1;
    p.tx = (b.x - a.x) / l; p.ty = (b.y - a.y) / l; p.nx = -p.ty; p.ny = p.tx;
    p.w = max(1.4 * U, (p.y - HY + h * 0.006) * 0.14);
  });
  return pts;
}
function makeCloud(r, U) {
  const cw = round((240 + r() * 380) * U), ch = round(cw * (0.3 + r() * 0.1)), cv = makeCanvas(cw, ch), c = cv.getContext('2d');
  const n = 30 + ((r() * 24) | 0);
  for (let i = 0; i < n; i++) {
    const f = 0.1 + 0.8 * r(), env = sin(PI * f), pr = ch * (0.14 + 0.22 * r()) * (0.45 + 0.55 * env), px = cw * f, py = ch * 0.64 - env * ch * 0.24 * r() - pr * 0.25;
    const g = radial(c, px, py, pr, 0, 'rgba(255,255,255,0.5)', 0.55, 'rgba(255,255,255,0.24)', 1, 'rgba(255,255,255,0)');
    rect(c, g, px - pr, py - pr, pr * 2, pr * 2);
  }
  blend(c, 'destination-out');
  const g = linear(c, 0, ch * 0.6, 0, ch * 0.9, 0, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,1)');
  rect(c, g, 0, ch * 0.6, cw, ch);
  return { cv, tint: makeCanvas(cw, ch), cw, ch };
}
function makeMist(r, w, h) {
  const mw = round(w / 2), mh = round(h * 0.14), cv = makeCanvas(mw, mh), c = cv.getContext('2d');
  for (let i = 0; i < 70; i++) {
    const x = r() * mw, y = mh * (0.45 + r() * 0.12), rad = mh * (0.18 + r() * 0.2), g = radial(c, x, y, rad, 0, 'rgba(255,255,255,0.32)', 1, 'rgba(255,255,255,0)'); c.fillStyle = g;
    c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    if (x < rad) c.fillRect(x - rad + mw, y - rad, rad * 2, rad * 2);
    if (x > mw - rad) c.fillRect(x - rad - mw, y - rad, rad * 2, rad * 2);
  }
  return cv;
}
/** Cloud top, cloud underside and mist colours for the light. */
const cloudColours = (S) => [mix(mix([62, 70, 96], [255, 255, 255], S.day), [255, 200, 160], S.warm * 0.75), mix(mix([24, 28, 44], [172, 184, 204], S.day), [150, 96, 122], S.warm * 0.7), mistTint(S)];
/** Recolour the cloud sprites and the mist strip for the current light. */
function tintSky(G, S) {
  const [top, bot, mist] = cloudColours(S);
  const paint = (dst, src, fill) => { const c = dst.getContext('2d'); blend(c, 'source-over'); c.clearRect(0, 0, dst.width, dst.height); c.drawImage(src, 0, 0); blend(c, 'source-atop'); rect(c, fill(c), 0, 0, dst.width, dst.height); blend(c, 'source-over'); };
  for (const sp of G.sprites) paint(sp.tint, sp.cv, (c) => linear(c, 0, 0, 0, sp.ch, 0.15, rgb(top), 0.85, rgb(bot)));
  paint(G.mistT, G.mist, () => rgb(mist));
}

/* ---------------- static landscape, rendered as a time-sliced generator ---------------- */
function* renderLand(c, G, S) {
  const { w, h } = G, sunX = sunXAt(G, S);
  c.clearRect(0, 0, w, h);
  yield* drawRange(c, G, G.far, S, sunX, [98, 106, 122], 0.3);
  yield* drawRange(c, G, G.near, S, sunX, [74, 80, 84], 0.22);
  for (const b of G.cityBack) drawBuilding(c, G, S, sunX, b);
  yield;
  yield* drawForest(c, G, S, sunX, G.f1, G.top1, G.edge1, 0.44, 0.42, 1, false);
  for (const b of G.cityMid) drawBuilding(c, G, S, sunX, b);
  yield;
  for (const b of G.landmarks) drawLandmark(c, G, S, sunX, b);
  yield;
  for (const b of G.cityFront) drawBuilding(c, G, S, sunX, b);
  yield;
  yield* drawGround(c, G, S, sunX);
  drawTrail(c, G, S);
  yield;
  drawPark(c, G, S, sunX);
  yield;
  yield* drawForest(c, G, S, sunX, G.f2, G.top2, G.edge2, 0.565, 0.14, 0.4, true);
  drawNearTrees(c, G, S, sunX);
  yield;
  drawTufts(c, G, S);
}
function* drawRange(c, G, R, S, sunX, base, fogA) {
  const { day, warm, hor } = S;
  const { w } = G, oy = G.bandTop, sc = cpuContext(G.band), lightAmt = day * 0.8 + warm * 0.6;
  sc.clearRect(0, 0, w, G.band.height);
  for (let i = 1; i < R.ry.length - 1; i++) {
    const x = i * 2, y = R.ry[i];
    if (y >= R.baseY - 0.5) continue;
    const face = clamp(((R.ry[i + 1] - R.ry[i - 1]) / 4) * 1.4, -1, 1), dir = clamp((sunX - x) / (w * 0.35), -1, 1), k = (1 + face * dir * 0.5 * lightAmt) * R.tex[i];
    rect(sc, rgb(lit(base, S, k)), x, y - oy, 2.6, R.baseY - y + 2);
    if (R.sd[i] > 0) { rect(sc, rgb(lit([240, 244, 250], S, 0.98 + (k - 1) * 1.4)), x, y - oy, 2.6, R.sd[i]); }
    if (!(i & 255)) yield;
  }
  blend(sc, 'source-atop');
  const g = linear(sc, 0, R.top - oy, 0, R.baseY - oy, 0, rgb(hor, fogA), 1, rgb(hor, min(0.9, fogA + 0.5)));
  rect(sc, g, 0, R.top - 2 - oy, w, R.baseY - R.top + 4);
  blend(sc, 'source-over');
  c.drawImage(G.band, 0, oy);
}
const shade = (cx, S, sunX) => { const lightAmt = S.day * 0.6 + S.warm * 0.9, right = sunX > cx; return { kS: 1 + (right ? 0.28 : -0.34) * lightAmt, kF: 1 + (right ? -0.04 : 0.1) * lightAmt }; };
function drawBuilding(c, G, S, sunX, b) {
  const { hor } = S;
  const { U, HY } = G, { kS, kF } = shade(b.x + b.w / 2, S, sunX);
  b.tiers.forEach(([l, r, t], ti) => {
    const sw = max(1, (r - l) * 0.16), fc = mix(lit(b.col, S, kF), hor, b.fog), scol = mix(lit(b.col, S, kS), hor, b.fog);
    let tt = t;
    if (b.slant && ti === b.tiers.length - 1) {
      poly(c, rgb(fc), l, HY + 1, l, t, r, t + b.slant, r, HY + 1);
      tt = t + b.slant;
      rect(c, rgb(scol), r - sw, tt - sw * 0.3, sw, HY - tt + 1);
    } else {
      const fg = linear(c, 0, t, 0, HY, 0, rgb(mix(fc, [255, 255, 255], 0.07)), 0.7, rgb(fc), 1, rgb(mix(fc, hor, 0.28)));
      rect(c, fg, l, t, r - l - sw, HY - t + 1);
      const sg = linear(c, 0, t, 0, HY, 0, rgb(scol), 1, rgb(mix(scol, hor, 0.28)));
      rect(c, sg, r - sw, t, sw, HY - t + 1);
      const stripes = ((r - l) / (7 * U)) | 0;
      for (let q = 0; q < stripes; q++) { rect(c, 'rgba(0,0,0,' + (0.035 + 0.05 * hash3(b.seed, q, 7)).toFixed(3) + ')', l + hash3(b.seed, ti * 31 + q, 5) * (r - l - sw), t, max(1, 0.8 * U), HY - t); }
      rect(c, rgb(mix(lit(b.col, S, kF * 1.22), hor, b.fog)), l, t, r - l, max(1, 1.1 * U));
    }
    drawWindows(c, G, S, l, r, tt, HY, (b.seed + ti * 977) | 0, fc, b.glass, b.fog, b.big);
  });
  if (b.roof) {
    const top = b.tiers[b.tiers.length - 1][2];
    if (b.roof.type === 'wt') {
      const s = b.roof.s * U, x = b.roof.x;
      c.fillStyle = rgb(mix(lit([66, 56, 48], S, kF), hor, b.fog));
      c.fillRect(x - 3 * s, top - 4 * s, 0.8 * s, 4 * s); c.fillRect(x + 2.2 * s, top - 4 * s, 0.8 * s, 4 * s); c.fillRect(x - 3.4 * s, top - 10 * s, 6.8 * s, 6.2 * s);
      poly(c, c.fillStyle, x - 3.8 * s, top - 10 * s, x, top - 13.5 * s, x + 3.8 * s, top - 10 * s);
    } else { rect(c, rgb(mix(lit([90, 90, 94], S, kF), hor, b.fog)), b.roof.x - 0.5 * U, top - b.roof.hgt, max(1, U), b.roof.hgt); }
  }
}
function drawWindows(c, G, S, l, r, t, b, seed, fc, glass, fog, big) {
  const { day, lights } = S;
  const U = G.U, sw = (r - l) * 0.16, L = l + 1.8 * U, R = r - sw - 1.2 * U;
  let ww = max(1, 1.9 * U), wh = max(1, 2.8 * U), gx = ww + (glass ? 1.1 : 2.2) * U, gy = wh + 2.4 * U;
  if (big) { gx = (R - L) / 3; ww = gx * 0.62; wh = ww; gy = gx; }
  const cols = floor((R - L) / gx), rows = floor((b - t - 4 * U) / gy);
  if (cols < 1 || rows < 1) return;
  const off = L + (R - L - cols * gx) / 2 + (gx - ww) / 2, y0 = t + 3 * U;
  if (day > 0.03) {
    alpha(c, min(1, day * 1.1 + 0.1) * (glass ? 0.75 : 0.9));
    c.fillStyle = rgb(mix(mix(fc, [0, 0, 0], 0.38), S.mid, glass ? 0.4 * day : 0.14 * day));
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) c.fillRect(off + i * gx, y0 + j * gy, ww, wh);
    alpha(c, 1);
  }
  if (lights > 0.01) {
    const thr = lights * 0.62, fa = 1 - fog * 0.55;
    for (let j = 0; j < rows; j++) {
      const fl = hash3(seed, 77, j);
      for (let i = 0; i < cols; i++) {
        const hv = 0.62 * hash3(seed, i, j) + 0.38 * fl;
        if (hv >= thr) continue;
        const k = hash3(seed + 9, i, j), a = min(1, (thr - hv) / 0.06) * (0.5 + 0.5 * k) * fa;
        c.fillStyle = WINDOW_LIGHT[(k * 4) | 0];
        alpha(c, a * 0.22); c.fillRect(off + i * gx - ww * 0.7, y0 + j * gy - wh * 0.35, ww * 2.4, wh * 1.7);
        alpha(c, a); c.fillRect(off + i * gx, y0 + j * gy, ww, wh);
      }
    }
    alpha(c, 1);
  }
}
function drawLandmark(c, G, S, sunX, b) {
  const { day, hor, lights } = S;
  const { U, HY } = G, cx = b.x + b.w / 2, { kS, kF } = shade(cx, S, sunX), fog = (col) => mix(col, hor, b.fog);
  if (b.kind === 'gen') return drawBuilding(c, G, S, sunX, b);
  if (b.kind === 'esb') {
    drawBuilding(c, G, S, sunX, b);
    c.fillStyle = rgb(fog(lit(b.col, S, kF * 1.05)));
    c.fillRect(cx - b.w * 0.035, HY - b.h - b.spire, b.w * 0.07, b.spire); c.fillRect(cx - b.w * 0.07, HY - b.h - b.spire * 0.25, b.w * 0.14, b.spire * 0.25);
    if (lights > 0.02) {
      alpha(c, lights * 0.85);
      const g = linear(c, 0, b.crownY, 0, HY - b.h - b.spire, 0, 'rgba(255,226,170,0.7)', 1, 'rgba(255,248,230,1)'); c.fillStyle = g;
      b.tiers.forEach(([l, r, t]) => { if (t < b.crownY) c.fillRect(l, t, r - l, min(b.crownY, HY) - t); });
      c.fillRect(cx - b.w * 0.035, HY - b.h - b.spire * 0.8, b.w * 0.07, b.spire * 0.8);
      const gg = radial(c, cx, HY - b.h, b.w * 1.6, 0, 'rgba(255,220,160,0.35)', 1, 'rgba(255,220,160,0)'); c.fillStyle = gg;
      c.fillRect(cx - b.w * 1.6, HY - b.h - b.w * 1.6, b.w * 3.2, b.w * 3.2);
      alpha(c, 1);
    }
    return;
  }
  if (b.kind === 'wtc') {
    const yb = HY - b.h * 0.1, yt = HY - b.h, tw = b.w * 0.44, base = [96, 112, 132];
    const ga = mix(fog(lit(base, S, kS * 0.95)), S.top, 0.3 * day), gb = mix(fog(lit(base, S, kF * 1.12)), S.mid, 0.38 * day);
    rect(c, rgb(fog(lit([70, 78, 90], S, kF))), b.x, yb, b.w, HY - yb + 1);
    poly(c, rgb(ga), b.x, yb, b.x + b.w, yb, cx + tw / 2, yt, cx - tw / 2, yt);
    poly(c, rgb(gb), b.x, yb, b.x + b.w, yb, cx, yt);
    if (lights > 0.02) {
      const thr = lights * 0.55, gy = 4.2 * U;
      for (let y = yb - 3 * U, j = 0; y > yt + 2 * U; y -= gy, j++) {
        const hv = hash3(b.seed, j, 3);
        if (hv >= thr) continue;
        const f = (yb - y) / (yb - yt), hw = ((b.w * (1 - f) + tw * f) / 2) * 0.88;
        alpha(c, min(1, (thr - hv) / 0.06) * 0.55); rect(c, WINDOW_LIGHT[(hash3(b.seed, j, 9) * 4) | 0], cx - hw, y, hw * 2, max(1, 1.3 * U));
      }
      alpha(c, 1);
    }
    c.fillStyle = rgb(fog(lit([150, 156, 164], S, kF)));
    c.fillRect(cx - tw / 2, yt - 2 * U, tw, 2 * U); c.fillRect(cx - U, yt - b.spire, max(1, 2 * U), b.spire); c.fillRect(cx - 2.2 * U, yt - b.spire * 0.35, 4.4 * U, 1.2 * U);
    return;
  }
  // Chrysler crown
  drawBuilding(c, G, S, sunX, b);
  const steel = [204, 208, 214];
  for (let k = 0; k < 5; k++) {
    const wk = b.w * 0.62 * (1 - k * 0.17), yb = HY - b.h * (0.78 + k * 0.042), hk = b.h * 0.05;
    c.fillStyle = rgb(fog(lit(steel, S, kF * (1.05 - k * 0.03))));
    c.beginPath(); c.moveTo(cx - wk / 2, yb + 1); c.lineTo(cx - wk / 2, yb - hk * 0.35); c.ellipse(cx, yb - hk * 0.35, wk / 2, hk * 0.75, 0, PI, 0); c.lineTo(cx + wk / 2, yb + 1); c.closePath(); c.fill();
    if (lights > 0.02) {
      alpha(c, lights * 0.9); c.fillStyle = 'rgb(255,244,220)';
      for (let m = -2; m <= 2; m++) { const tx = cx + m * wk * 0.17, ty = yb - hk * 0.35 - sqrt(max(0, 1 - pow(m * 0.34, 2))) * hk * 0.45; poly(c, c.fillStyle, tx - 1.1 * U, ty + 1.6 * U, tx, ty - 0.6 * U, tx + 1.1 * U, ty + 1.6 * U); }
      alpha(c, 1);
    }
  }
  c.fillStyle = rgb(fog(lit(steel, S, kF)));
  poly(c, c.fillStyle, cx - 1.6 * U, HY - b.h * 0.99, cx, HY - b.h - b.spire, cx + 1.6 * U, HY - b.h * 0.99);
}
function* drawGround(c, G, S, sunX) {
  const { day, warm, hor } = S;
  const { w, h, HY, U } = G;
  const g = linear(c, 0, HY, 0, h, 0, rgb(mix(lit([126, 146, 94], S), hor, 0.4)), 0.25, rgb(lit([88, 118, 62], S)), 1, rgb(lit([50, 78, 38], S, 0.85)));
  rect(c, g, 0, HY, w, h - HY);
  const hz = linear(c, 0, HY - h * 0.05, 0, HY + 1, 0, rgb(hor, 0), 1, rgb(hor, 0.42));
  rect(c, hz, 0, HY - h * 0.05, w, h * 0.05 + 1);
  const rr = rng(555);
  for (let i = 0; i < 30; i++) {
    const y = HY + (h - HY) * (0.08 + 0.9 * rr()), x = rr() * w, rx = (y - HY) * (0.9 + rr() * 1.6), ry = max(2, (y - HY) * (0.1 + rr() * 0.12)), dark = rr() < 0.5;
    const gg = radial(c, x, y, rx, 0, dark ? 'rgba(10,20,8,0.15)' : 'rgba(230,240,170,0.07)', 1, 'rgba(0,0,0,0)');
    c.save(); c.translate(x, y); c.scale(1, ry / rx); c.translate(-x, -y); rect(c, gg, x - rx, y - rx, rx * 2, rx * 2); c.restore();
  }
  c.lineCap = 'round';
  for (let i = 0; i < 2400; i++) {
    const t = pow(rr(), 0.7), y = HY + (h - HY) * t, x = rr() * w, len = (0.5 + t * 4.5) * U * (0.5 + rr()), v = rr();
    c.strokeStyle = rgb(lit(v < 0.33 ? [34, 56, 28] : v < 0.66 ? [88, 114, 54] : [122, 140, 72], S, 0.75 + rr() * 0.5), 0.12 + 0.3 * t);
    c.lineWidth = max(0.6, (0.4 + t * 1.1) * U);
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rr() - 0.5) * len * 0.7, y - len); c.stroke();
    if (!(i & 511)) yield;
  }
  for (const b of G.bushes) {
    const fo = 0.3 * (1 - (b.y - HY) / (h - HY)), dk = mix(lit([38, 60, 32], S, b.k), hor, fo), hi = mix(lit([84, 112, 56], S, b.k), hor, fo);
    c.fillStyle = 'rgba(0,0,0,0.18)'; c.beginPath(); c.ellipse(b.x, b.y, b.s * 1.3, b.s * 0.25, 0, 0, TAU); c.fill();
    c.fillStyle = rgb(dk); c.beginPath();
    c.ellipse(b.x - b.s * 0.5, b.y - b.s * 0.45, b.s * 0.7, b.s * 0.55, 0, 0, TAU); c.ellipse(b.x + b.s * 0.45, b.y - b.s * 0.4, b.s * 0.75, b.s * 0.5, 0, 0, TAU); c.ellipse(b.x, b.y - b.s * 0.8, b.s * 0.7, b.s * 0.6, 0, 0, TAU);
    c.fill();
    if (day > 0.05) { alpha(c, 0.55 * day + 0.3 * warm); c.fillStyle = rgb(hi); c.beginPath(); c.ellipse(b.x + (sunX > b.x ? 1 : -1) * b.s * 0.2, b.y - b.s * 0.95, b.s * 0.45, b.s * 0.32, 0, 0, TAU); c.fill(); alpha(c, 1); }
  }
}
function drawTrail(c, G, S) {
  const { HY, h, U } = G, P = G.trail, F = 0.38;
  const path = (s) => {
    c.beginPath();
    P.forEach((p, i) => { const x = p.x + (p.nx * p.w * s) / 2, y = p.y + ((p.ny * p.w * s) / 2) * F; if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; c.lineTo(p.x - (p.nx * p.w * s) / 2, p.y - ((p.ny * p.w * s) / 2) * F); }
    c.closePath();
  };
  const moon = [46, 52, 70], mn = S.night * 0.85, g = linear(c, 0, HY, 0, h, 0, rgb(mix(mix(lit([190, 170, 132], S), S.hor, 0.4), moon, mn * 0.6)), 0.4, rgb(mix(lit([176, 150, 112], S), moon, mn * 0.7)), 1, rgb(mix(lit([150, 124, 90], S, 0.9), moon, mn * 0.7)));
  path(1); c.fillStyle = g; c.fill(); c.strokeStyle = rgb(lit([70, 74, 44], S), 0.5); c.lineWidth = max(1, 1.6 * U); c.stroke();
  path(0.4); c.fillStyle = rgb(lit([214, 192, 152], S), 0.35); c.fill();
  const rr = rng(777);
  for (let i = 0; i < 520; i++) {
    const p = P[(rr() * (P.length - 1)) | 0], sp = (rr() - 0.5) * 0.85, x = p.x + p.nx * p.w * sp, y = p.y + p.ny * p.w * sp * F, ps = max(0.5, (0.3 + rr() * 0.9) * (p.w / (10 * U))) * U;
    rect(c, rgb(lit(rr() < 0.5 ? [118, 98, 72] : [206, 186, 150], S), 0.18 + rr() * 0.3), x, y, ps, ps * 0.7);
  }
}
function drawPark(c, G, S, sunX) {
  const { day, warm, hor, lights } = S;
  const U = G.U;
  for (const t of G.park) {
    const dk = mix(lit([40, 64, 38], S, t.k * 0.9), hor, 0.16), hi = mix(lit([90, 124, 62], S, t.k), hor, 0.16), { x, y, r } = t;
    discs(c, rgb(dk), x, y - r * 0.8, r, x - r * 0.65, y - r * 0.55, r * 0.72, x + r * 0.6, y - r * 0.6, r * 0.78, x + r * 0.1, y - r * 1.45, r * 0.66);
    if (day > 0.05 || warm > 0.1) { alpha(c, 0.5 * day + 0.35 * warm); c.fillStyle = rgb(hi); const dx = (sunX > x ? 1 : -1) * r * 0.35; c.beginPath(); c.arc(x + dx, y - r * 1.3, r * 0.5, 0, TAU); c.arc(x + dx * 1.4, y - r * 0.85, r * 0.42, 0, TAU); c.fill(); alpha(c, 1); }
  }
  if (lights > 0.02) for (const [x, y] of G.lamps) { const g = radial(c, x, y, 7 * U, 0, `rgba(255,214,150,${0.9 * lights})`, 1, 'rgba(255,214,150,0)'); rect(c, g, x - 7 * U, y - 7 * U, 14 * U, 14 * U); }
}
function drawPine(c, x, y, th, col, hi, dir, seed, detail) {
  const tw = th * 0.36, tiers = th > 120 ? 11 : th > 40 ? 8 : th > 16 ? 6 : 4, trunk = tw * 0.06, pts = [];
  for (let i = 1; i <= tiers; i++) { const f = i / tiers, yy = y - th + th * 0.88 * f, hw = tw * (0.2 + 0.8 * f) * 0.5 * (0.8 + 0.4 * hash3(seed, i, 1)); pts.push([hw, yy, hw * 0.42, yy + th * 0.012]); }
  c.fillStyle = col; c.beginPath(); c.moveTo(x, y - th);
  for (let i = 0; i < tiers; i++) { const p = pts[i]; c.lineTo(x + p[0], p[1]); if (i < tiers - 1) c.lineTo(x + p[2], p[3]); }
  c.lineTo(x + trunk, y - th * 0.12); c.lineTo(x + trunk, y); c.lineTo(x - trunk, y); c.lineTo(x - trunk, y - th * 0.12);
  for (let i = tiers - 1; i >= 0; i--) { const p = pts[i]; if (i < tiers - 1) c.lineTo(x - p[2], p[3]); c.lineTo(x - p[0] * (0.9 + 0.2 * hash3(seed, i, 2)), p[1]); }
  c.closePath(); c.fill();
  if (detail && hi) {
    c.fillStyle = hi; c.beginPath(); c.moveTo(x, y - th);
    for (let i = 0; i < tiers; i++) { const p = pts[i]; c.lineTo(x + dir * p[0], p[1]); if (i < tiers - 1) c.lineTo(x + dir * p[2] * 0.9, p[3]); }
    c.lineTo(x + dir * trunk, y - th * 0.12); c.lineTo(x, y - th * 0.15); c.closePath(); c.fill();
  }
}
function* drawForest(c, G, S, sunX, list, top, bot, f0, fogA, rowFog, detail) {
  const { day, warm, hor } = S;
  const { HY, h, U } = G, lightAmt = day * 0.55 + warm * 0.7;
  // hill body
  c.fillStyle = rgb(mix(lit([28, 44, 32], S), hor, fogA + 0.06)); c.beginPath();
  c.moveTo(G.X(f0), bot(f0));
  for (let f = f0; f <= 1.08; f += 0.004) c.lineTo(G.X(f), top(f) + 6 * U);
  for (let f = 1.08; f >= f0; f -= 0.004) c.lineTo(G.X(f), bot(f));
  c.closePath(); c.fill();
  let i = 0;
  for (const t of list) {
    const yf = clamp((t.y - HY + h * 0.1) / (h * 0.2)), fo = clamp(fogA + 0.12 * (1 - yf) * rowFog);
    const col = rgb(mix(lit(t.dec ? [48, 70, 36] : [34, 56, 40], S, t.k), hor, fo)), dir = sunX > t.x ? 1 : -1;
    const hi = lightAmt > 0.05 ? rgb(mix(lit(t.dec ? [96, 124, 60] : [64, 96, 58], S, t.k), hor, fo), 0.55 * lightAmt) : null;
    if (t.dec) {
      const r = t.h * 0.32;
      discs(c, col, t.x, t.y - r, r, t.x + r * 0.5, t.y - r * 1.4, r * 0.7, t.x - r * 0.5, t.y - r * 1.3, r * 0.7);
      if (hi && detail) { discs(c, hi, t.x + dir * r * 0.4, t.y - r * 1.5, r * 0.5); }
    } else drawPine(c, t.x, t.y, t.h, col, hi, dir, t.seed, detail);
    if (!(++i & 511)) yield;
  }
}
function drawNearTrees(c, G, S, sunX) {
  const lightAmt = S.day * 0.55 + S.warm * 0.7;
  for (const t of G.f3) {
    const col = rgb(lit([22, 38, 28], S, t.k)), hi = lightAmt > 0.05 ? rgb(lit([58, 90, 52], S, t.k), 0.5 * lightAmt) : null;
    c.fillStyle = 'rgba(0,0,0,0.22)'; c.beginPath(); c.ellipse(t.x, t.y, t.h * 0.2, t.h * 0.025, 0, 0, TAU); c.fill();
    drawPine(c, t.x, t.y, t.h, col, hi, sunX > t.x ? 1 : -1, t.seed, true);
  }
}
function drawTufts(c, G, S) {
  const cols = [lit([46, 74, 34], S, 0.8), lit([70, 100, 46], S), lit([104, 128, 64], S, 1.05)];
  c.lineWidth = max(0.7, 0.7 * G.U); c.lineCap = 'round';
  for (let b = 0; b < 3; b++) {
    c.strokeStyle = rgb(cols[b], 0.6); c.beginPath();
    for (const t of G.tufts) {
      if (t.b !== b) continue;
      for (let k = -1; k <= 1; k++) { const x = t.x + k * t.l * 0.18; c.moveTo(x, t.y); c.quadraticCurveTo(x + t.lean * 0.4 + k * t.l * 0.1, t.y - t.l * 0.6, x + t.lean + k * t.l * 0.3, t.y - t.l * (1 - abs(k) * 0.25)); }
    }
    c.stroke();
  }
}

/* ---------------- moving things ---------------- */
function makeFlock(G) {
  const R = random, left = R() < 0.5, n = 3 + ((R() * 9) | 0), s = (2.2 + R() * 2.8) * G.U, dir = left ? 1 : -1, birds = [];
  for (let i = 0; i < n; i++) { const row = ceil(i / 2), side = i % 2 ? 1 : -1; birds.push({ dx: -row * (6 + R() * 3) * s * dir, dy: row * (2.6 + R() * 2) * s * side + (R() - 0.5) * 3 * s, ph: R() * TAU, fl: 7 + R() * 4, k: 0.8 + R() * 0.4 }); }
  return { x: left ? -60 * G.U : G.w + 60 * G.U, y: G.h * (0.08 + R() * 0.32), v: (30 + R() * 34) * G.U * dir, vy: (R() - 0.5) * 4 * G.U, s, birds };
}
function drawRunner(c, G, r, S, dt) {
  const P = G.trail, N = P.length;
  if (r.wait > 0) { r.wait -= dt; if (r.wait <= 0) r.u = r.dir > 0 ? 0 : 1; return; }
  r.u += r.dir * r.v * dt; r.ph += dt * TAU * 1.5;
  if (r.u > 1 || r.u < 0) { r.wait = 3 + random() * 5; return; }
  const fi = r.u * (N - 1), i = floor(fi), t = fi - i, a = P[i], b = P[min(N - 1, i + 1)];
  const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, H = (a.w + (b.w - a.w) * t) * 1.05;
  const al = r.dir > 0 ? smooth(0, 0.03, r.u) * (1 - smooth(0.9, 0.99, r.u)) : smooth(0, 0.06, r.u) * (1 - smooth(0.97, 1, r.u));
  if (al < 0.02 || H < 2.5) return;
  const dx = sign(a.tx * r.dir) || 1, col = rgb(mix([30, 30, 34], [8, 10, 16], 1 - S.day));
  alpha(c, al); c.strokeStyle = col; c.fillStyle = col; c.lineCap = 'round'; c.lineWidth = max(1, H * 0.11);
  const ph = r.ph, hip = [x, y - H * 0.5], sh = [x + dx * H * 0.07, y - H * 0.82];
  c.beginPath();
  for (const s of [1, -1]) {
    const an = sin(ph) * 0.65 * s, kn = [hip[0] + dx * sin(an) * H * 0.25, hip[1] + cos(an) * H * 0.25], bend = max(0, -sin(ph) * s) * 0.9 + 0.15;
    c.moveTo(hip[0], hip[1]); c.lineTo(kn[0], kn[1]); c.lineTo(kn[0] + dx * sin(an - bend) * H * 0.25, kn[1] + cos(an - bend) * H * 0.25);
    const aa = -sin(ph) * 0.8 * s, el = [sh[0] + dx * sin(aa) * H * 0.17, sh[1] + cos(aa) * H * 0.17];
    c.moveTo(sh[0], sh[1]); c.lineTo(el[0], el[1]); c.lineTo(el[0] + dx * H * 0.12, el[1] - H * 0.05);
  }
  c.moveTo(hip[0], hip[1]); c.lineTo(sh[0], sh[1]); c.stroke();
  const hx = sh[0] + dx * H * 0.03, hy = sh[1] - H * 0.1;
  discs(c, col, hx, hy, H * 0.075);
  c.lineWidth = max(1, H * 0.04); c.beginPath(); c.moveTo(hx - dx * H * 0.06, hy - H * 0.05); c.lineTo(hx + dx * H * 0.12, hy - H * 0.035); c.stroke(); // cap brim
  const nl = clamp(S.lights * 1.2);
  if (nl > 0.05) { // headlamp
    blend(c, 'lighter');
    const gx = x + dx * H * 0.9, beam = radial(c, gx, y, H * 1.1, 0, `rgba(255,240,210,${0.35 * nl * al})`, 1, 'rgba(255,240,210,0)');
    c.fillStyle = beam; c.save(); c.translate(gx, y); c.scale(1, 0.35); c.translate(-gx, -y); c.fillRect(gx - H * 1.1, y - H * 1.1, H * 2.2, H * 2.2); c.restore();
    const lx = hx + dx * H * 0.05, ly = hy - H * 0.04, hl = radial(c, lx, ly, H * 0.3, 0, `rgba(255,255,255,${0.9 * nl * al})`, 1, 'rgba(255,255,255,0)');
    rect(c, hl, hx - H * 0.3, hy - H * 0.35, H * 0.7, H * 0.6);
    blend(c, 'source-over');
  }
  alpha(c, 1);
}

/* ---------------- the engine: all mutable state lives in this closure ---------------- */
const announced = new WeakSet(); // elements that have dispatched endure-scene:ready
function createScene(host) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;display:block';
  host.append(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  // Land keyframe j sits at loop position j / KEYFRAMES. The pacing already spends time where the
  // light changes, so equal steps of loop time give crossfades of similar change and a steady render rate.
  const keyLight = (j) => lightAt(mod1(dayAt(j / KEYFRAMES)));
  let G = null, slots = [], job = null, shown = 0, cssH = 0;
  let cycleU = cycleAt(parsePhase(host.getAttribute('start')) ?? PHASES.dawn), cycleSeconds = 15, lockPhase = null;
  let time = 0, driftT = 0, last = 0, raf = 0, paused = false, isReady = false, readyQueued = false;
  let flocks = [], plane = null, shoot = null, birdT = 2.2, birdVis = 1, tinted = '', tintAt = -1;
  const runners = [{ u: 0.02, dir: 1, v: 1 / 80, ph: 0, wait: 0 }, { u: 0.7, dir: -1, v: 1 / 95, ph: 1.3, wait: 0 }];

  const isStatic = () => reduced.matches || lockPhase != null;
  const phase = () => (lockPhase != null ? lockPhase : reduced.matches ? PHASES.dawn : mod1(dayAt(cycleU)));
  const lightIn = (seconds) => lightAt(mod1(dayAt(cycleU + seconds / cycleSeconds)));
  const slotOf = (node) => slots.find((s) => s.node === node && s.ready);

  function configure() {
    const p = parseFloat(host.getAttribute('cycle-seconds'));
    cycleSeconds = isFinite(p) ? max(5, p) : 15;
    const lock = parsePhase(new URLSearchParams(location.search).get('time')) ?? parsePhase(host.getAttribute('lock'));
    if (lock !== lockPhase) { lockPhase = lock; if (G) { resetLand(); draw(0); } }
  }
  /** Synchronously render what the current frame needs; used on start, resize and jumps. */
  function resetLand() {
    job = null;
    slots.forEach((s) => freeCanvas(s.cv));
    slots = [];
    const render = (node, S) => { const cv = makeCanvas(G.w, G.h), gen = renderLand(cpuContext(cv), G, S); while (!gen.next().done); slots.push({ node, cv, ready: true }); };
    if (isStatic()) { shown = -1; render(-1, lightAt(phase())); return; }
    shown = cycleU * KEYFRAMES;
    const b = floor(shown);
    render(b, keyLight(b));
    if (shown - b > 0.002) render(b + 1, keyLight(b + 1));
  }
  function resize() {
    const W = max(1, host.clientWidth || innerWidth), H = max(1, host.clientHeight || innerHeight);
    // Keep the tallest height seen at this width: mobile toolbars collapsing and expanding then
    // crop the bottom of the meadow instead of rebuilding (and re-laying out) the whole world.
    const keep = G && abs(G.cssW - W) < 1 && H <= cssH && H > cssH * 0.75;
    if (keep) return;
    const dpr = min(window.devicePixelRatio || 1, MAX_DPR), w = round(W * dpr), h = round(H * dpr);
    cssH = H;
    canvas.style.height = H + 'px';
    if (G && G.w === w && G.h === h) return;
    canvas.width = w; canvas.height = h;
    freeWorld(G);
    G = buildWorld(w, h);
    G.cssW = W;
    G.vignette = withStops(ctx.createRadialGradient(w / 2, h * 0.45, hypot(w, h) * 0.175, w / 2, h * 0.5, hypot(w, h) * 0.525), [0, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,0.42)']);
    tinted = '';
    resetLand();
    draw(0);
  }
  /** Advance the displayed keyframe position toward the schedule, never past unrendered keyframes. */
  function stepLand(dt) {
    if (isStatic()) return;
    const want = cycleU * KEYFRAMES, speed = KEYFRAMES / cycleSeconds;
    let limit = floor(shown);
    while (limit < floor(shown) + 2 && slotOf(limit + 1)) limit++;
    shown = max(shown, min(want, shown + max(3, speed * 2.5) * dt, limit));
    const b = floor(shown);
    if (job) return;
    for (let j = b + 1; j <= b + 2; j++) {
      if (slots.some((s) => s.node === j)) continue;
      let s = slots.find((x) => x.node < b);
      if (!s && slots.length < LAND_SLOTS) slots.push((s = { cv: makeCanvas(G.w, G.h) }));
      if (!s) return;
      s.node = j; s.ready = false;
      job = { s, gen: renderLand(cpuContext(s.cv), G, keyLight(j)) };
      return;
    }
  }
  function runJob(budgetMs) {
    const end = performance.now() + budgetMs;
    while (job && performance.now() < end) if (job.gen.next().done) { job.s.ready = true; job = null; }
  }

  function draw(dt) {
    const c = ctx, { w, h, HY, U } = G, S = lightAt(phase()), T = time, { day, warm, hor, night, lights, mist } = S;
    const sky = linear(c, 0, 0, 0, HY, 0, rgb(S.top), 0.55, rgb(S.mid), 1, rgb(hor));
    rect(c, sky, 0, 0, w, HY + 2);
    rect(c, rgb(hor), 0, HY, w, h - HY);
    if (night > 0.01) {
      for (const s of G.stars) { const a = night * s.b * s.fade * (0.6 + 0.4 * sin(T * s.f + s.p)); if (a < 0.02) continue; alpha(c, a); rect(c, s.c, s.x, s.y, s.s, s.s); }
      alpha(c, 1);
    }
    // shooting star (about one every other night at a 15 s cycle)
    if (!shoot && dt && night > 0.6 && random() < dt / 5) { const R = random; shoot = { x: R() * w, y: R() * HY * 0.4, vx: (R() < 0.5 ? -1 : 1) * (700 + R() * 500) * U, vy: (240 + R() * 200) * U, life: 0, max: 0.6 + R() * 0.5 }; }
    if (shoot) {
      const s = shoot; s.life += dt;
      const p = s.life / s.max;
      if (p >= 1) shoot = null;
      else {
        const x = s.x + s.vx * s.life, y = s.y + s.vy * s.life, gr = linear(c, x, y, x - s.vx * 0.09, y - s.vy * 0.09, 0, `rgba(255,255,255,${(1 - p) * night})`, 1, 'rgba(255,255,255,0)');
        c.strokeStyle = gr; c.lineWidth = max(1, 1.2 * U); c.beginPath(); c.moveTo(x, y); c.lineTo(x - s.vx * 0.09, y - s.vy * 0.09); c.stroke();
      }
    }
    // city glow
    if (lights > 0.02) { const cg = radial(c, G.X(0.2), HY, G.VW * 0.42, 0, `rgba(255,168,96,${0.2 * lights})`, 1, 'rgba(255,168,96,0)'); rect(c, cg, 0, 0, w, HY); }
    // sun
    const sx = sunXAt(G, S), sy = HY - sin(S.a) * h * 0.58, ga = clamp(0.5 * day + 0.8 * warm);
    if (ga > 0.01) {
      const sc = mix([255, 246, 222], [255, 158, 88], warm), sg = radial(c, sx, sy, h * 0.8, 0, rgb(sc, ga), 0.06, rgb(sc, ga * 0.55), 0.3, rgb(sc, ga * 0.16), 1, rgb(sc, 0));
      rect(c, sg, 0, 0, w, HY + 2);
      if (sy < HY + 16 * U) { discs(c, rgb(mix([255, 253, 244], [255, 196, 128], warm)), sx, sy, 13 * U); }
    }
    // moon
    const ma = S.a + PI, malt = sin(ma), mx = G.X(0.5 - 0.44 * cos(ma)), my = HY - malt * h * 0.5, mv = smooth(-0.03, 0.08, malt) * (1 - day * 0.75);
    if (mv > 0.01) {
      const mg = radial(c, mx, my, 70 * U, 0, `rgba(210,222,255,${0.28 * mv})`, 1, 'rgba(210,222,255,0)');
      rect(c, mg, mx - 70 * U, my - 70 * U, 140 * U, 140 * U);
      alpha(c, mv); discs(c, 'rgb(238,236,226)', mx, my, 10 * U);
      discs(c, 'rgba(150,150,160,0.28)', mx - 3 * U, my - 2.5 * U, 3.2 * U, mx + 3.5 * U, my + U, 2.4 * U, mx - U, my + 4 * U, 1.8 * U);
      alpha(c, 1);
    }
    // Clouds and mist drift a little faster on short cycles, to keep pace with the time-lapse. Their
    // sprites are re-tinted when their colour moves by a level (at most 20×/s; never while the light holds).
    const drift = clamp(sqrt(60 / cycleSeconds), 1, 2.5), tint = cloudColours(S).map((c) => rgb(c)).join();
    driftT += dt * drift;
    if (tint !== tinted && (!tinted || T - tintAt > 0.05)) { tintSky(G, S); tinted = tint; tintAt = T; }
    const ca = 0.55 + 0.45 * max(day, warm);
    for (const cl of G.clouds) { const sp = G.sprites[cl.sp], cw = sp.cw * cl.sx; cl.x += cl.v * drift * dt; if (cl.x > w + 20) cl.x = -cw; alpha(c, cl.a * ca); c.drawImage(sp.tint, cl.x, cl.y, cw, sp.ch * cl.sy); }
    alpha(c, 1);
    // plane: only at night, fading with the dark; one crossing segment per night
    if (!plane && dt && night > 0.35 && lightIn(2.5).night > 0.35 && random() < dt / 4) plane = { x: (0.05 + random() * 0.6) * w, y: h * (0.07 + random() * 0.15), v: (18 + random() * 10) * U, vis: 0 };
    if (plane) {
      const p = plane;
      p.x += p.v * dt; p.y -= p.v * dt * 0.03;
      p.vis += (clamp((night - 0.3) * 3) - p.vis) * min(1, dt * 2.5);
      if (p.x > w + 20 * U || (p.vis < 0.01 && night < 0.3)) plane = null;
      else {
        alpha(c, p.vis); rect(c, 'rgba(255,70,60,0.9)', p.x, p.y, 1.6 * U, 1.6 * U);
        if (T % 1.3 < 0.08) { discs(c, '#fff', p.x + 3 * U, p.y, 1.8 * U); }
        alpha(c, 1);
      }
    }
    // birds: a flock only sets out when at least 3 s of daylight remain; it fades with the light
    birdT -= dt;
    if (birdT < 0) {
      birdT = 4 + random() * 6;
      const later = lightIn(3);
      if ((day > 0.25 || warm > 0.4) && (later.day > 0.2 || later.warm > 0.35) && flocks.length < 3) flocks.push(makeFlock(G));
    }
    birdVis += (clamp(max(day * 1.6, warm * 1.2)) - birdVis) * min(1, dt * 1.5);
    c.lineCap = 'round';
    c.strokeStyle = rgb(mix([28, 30, 36], [16, 12, 16], warm), 0.85 * birdVis);
    flocks = flocks.filter((f) => f.x > -200 * U && f.x < w + 200 * U && !(birdVis < 0.02 && day < 0.1));
    for (const f of flocks) {
      f.x += f.v * dt; f.y += f.vy * dt;
      for (const b of f.birds) {
        const s = f.s * b.k, bx = f.x + b.dx + sin(T * 0.6 + b.ph) * 2 * s, by = f.y + b.dy + cos(T * 0.8 + b.ph) * 1.5 * s, fl = sin(T * 0.35 + b.ph) > 0.55 ? 0.15 : sin(T * b.fl + b.ph);
        c.lineWidth = max(1, s * 0.32); c.beginPath(); c.moveTo(bx - s * 1.7, by - fl * s * 0.9);
        c.quadraticCurveTo(bx - s * 0.6, by - s * 0.45 - fl * s * 0.3, bx, by); c.quadraticCurveTo(bx + s * 0.6, by - s * 0.45 - fl * s * 0.3, bx + s * 1.7, by - fl * s * 0.9); c.stroke();
      }
    }
    // land: crossfade the two keyframes around the current phase
    const b = floor(shown), f = shown - b, base = slotOf(b), over = f > 0.002 && slotOf(b + 1);
    if (base) c.drawImage(base.cv, 0, 0);
    if (over) { alpha(c, f); c.drawImage(over.cv, 0, 0); alpha(c, 1); }
    // mist
    if (mist > 0.02) {
      const mw = G.mistT.width * 2, mh = G.mistT.height, off = (driftT * 4 * U) % mw, off2 = (driftT * -2.5 * U) % mw;
      alpha(c, mist * 0.55);
      for (let k = -1; k < 2; k++) c.drawImage(G.mistT, off + k * mw, HY - mh * 0.75, mw, mh);
      alpha(c, mist * 0.5);
      for (let k = -1; k < 2; k++) c.drawImage(G.mistT, off2 + k * mw + mw * 0.3, HY - mh * 0.25, mw, mh * 0.8);
      alpha(c, 1);
    }
    for (const r of runners) drawRunner(c, G, r, S, dt);
    // fireflies
    const fa = clamp(night * 1.1 - 0.1);
    if (fa > 0.01) {
      blend(c, 'lighter');
      for (const fl of G.flies) { const a = fa * pow(0.5 + 0.5 * sin(T * 2.2 * fl.sp + fl.ph * 3), 3); if (a < 0.03) continue; const s = 9 * U * fl.s; alpha(c, a); c.drawImage(G.glow, fl.x + sin(T * fl.sp + fl.ph) * 10 * U - s / 2, fl.y + cos(T * fl.sp * 0.7 + fl.ph * 2) * 5 * U - s / 2, s, s); }
      alpha(c, 1); blend(c, 'source-over');
    }
    // aviation lights
    const avA = 0.3 + 0.7 * (1 - day);
    G.avi.forEach(([x, y], i) => { if ((T * 0.75 + i * 0.17) % 1 < 0.45) { const r = 5 * U, gg = radial(c, x, y, r, 0, `rgba(255,60,50,${avA})`, 1, 'rgba(255,60,50,0)'); rect(c, gg, x - r, y - r, r * 2, r * 2); } });
    rect(c, G.vignette, 0, 0, w, h);
    // film grain
    blend(c, 'overlay'); alpha(c, 0.3);
    const gox = (random() * 256) | 0, goy = (random() * 256) | 0;
    for (let yy = -goy; yy < h; yy += 256) for (let xx = -gox; xx < w; xx += 256) c.drawImage(G.grain, xx, yy);
    alpha(c, 1); blend(c, 'source-over');
    // The frame just drawn is on screen by the next animation frame. Announce it once per element.
    if (!readyQueued) {
      readyQueued = true;
      requestAnimationFrame(() => { isReady = true; if (!announced.has(host)) { announced.add(host); host.dispatchEvent(new CustomEvent('endure-scene:ready', { bubbles: true })); } });
    }
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 12) return; // ~60 fps on 120 Hz screens
    const dt = min((now - last) / 1000, 0.1);
    last = now;
    time += dt;
    if (lockPhase == null) cycleU += dt / cycleSeconds;
    const t0 = performance.now();
    stepLand(dt);
    draw(dt);
    // Render ahead in the time left; spend more when the display is waiting on the next keyframe.
    runJob(job && job.s.node <= floor(shown) + 1 ? 8 : max(2, 10 - (performance.now() - t0)));
  }
  const start = () => { if (!raf && !paused && !document.hidden && !reduced.matches) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  const onVisibility = () => (document.hidden ? stop() : start());
  const onMotion = () => { stop(); resetLand(); draw(0); start(); };
  const observer = new ResizeObserver(() => { clearTimeout(observer.t); observer.t = setTimeout(resize, 120); });

  configure();
  resize();
  observer.observe(host);
  document.addEventListener('visibilitychange', onVisibility);
  reduced.addEventListener('change', onMotion);
  start();

  return {
    configure,
    phase,
    get ready() { return isReady; },
    get paused() { return paused || reduced.matches; },
    setPaused(v) { paused = v; if (v) stop(); else start(); },
    destroy() {
      stop(); observer.disconnect(); clearTimeout(observer.t);
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', onMotion);
      slots.forEach((s) => freeCanvas(s.cv)); freeWorld(G); freeCanvas(canvas); canvas.remove();
    },
  };
}

class EndureScene extends HTMLElement {
  static observedAttributes = ['lock', 'cycle-seconds'];
  #scene = null;
  connectedCallback() {
    this.style.cssText = 'position:absolute;inset:0;display:block;overflow:hidden;pointer-events:none;background:#05070d';
    this.#scene = createScene(this);
    window.endureScene = this;
  }
  disconnectedCallback() { this.#scene?.destroy(); this.#scene = null; }
  attributeChangedCallback() { this.#scene?.configure(); }
  get ready() { return !!this.#scene?.ready; }
  get paused() { return this.#scene ? this.#scene.paused : true; }
  pause() { this.#toggle(true); }
  play() { this.#toggle(false); }
  #toggle(paused) {
    const scene = this.#scene, before = scene?.paused;
    if (!scene) return;
    scene.setPaused(paused);
    if (scene.paused !== before) this.dispatchEvent(new CustomEvent('endure-scene:statechange', { bubbles: true, detail: { paused: scene.paused } }));
  }
  getClock() {
    const phase = this.#scene?.phase() ?? PHASES.dawn, m = floor(phase * 1440) % 1440;
    return { h: floor(m / 60), m: m % 60, phase };
  }
  getAtmosphere() { return atmosphereAt(this.#scene?.phase() ?? PHASES.dawn); }
  /** The mist strip sits on the horizon (66.5 % down the canvas), 14 % of its height tall. */
  getMistBand() {
    const r = (this.querySelector('canvas') || this).getBoundingClientRect();
    return { top: r.top + r.height * 0.588, bottom: r.top + r.height * 0.721 };
  }
}

if (!customElements.get('endure-scene')) customElements.define('endure-scene', EndureScene);

export { EndureScene, PHASES };
