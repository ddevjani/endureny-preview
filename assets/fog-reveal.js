/**
 * <fog-reveal>: fog hangs over the scene, then slowly condenses into the hero quote.
 * ES module, no dependencies.
 *
 * Markup (server-rendered; every quote is in the DOM, inactive ones carry `hidden`):
 *   <fog-reveal delay="4500">
 *     <figure class="hero-quote" data-quote>…<blockquote><p>“…”</p></blockquote><figcaption>— …</figcaption></figure>
 *     <figure class="hero-quote" data-quote hidden>…</figure>
 *   </fog-reveal>
 *
 * delay       ms after navigation start (performance.now()) by which the first quote is fully legible.
 *             Default 4500. Every phase scales with the time left; a late connection gets at least 600 ms.
 *             Connecting at or after `delay` (or once the theme's CSS fallback has started showing the
 *             quote) skips the fog: the quote stays visible and data-state goes straight to "clear".
 * data-state  Set on connect: gathering → clear. During rotation: dissolving → dissolved → gathering → clear.
 *
 * Timeline of the first reveal, as shares of T (connect → delay; ~4.35 s with delay="4500"):
 *   0      A soft, low-contrast fog bank is already there over the quote's area, drifting gently,
 *          tinted with window.endureScene.getAtmosphere().mist; faint wisps rise into it from
 *          getMistBand() for depth.
 *   0–0.28 The fog lingers (~1.2 s).
 *   0.28–0.94  It slowly condenses onto the words, each particle on its own eased path (~2.9 s).
 *   0.66–1 The real HTML text resolves from blur to sharp (~1.5 s), fully legible at `delay`.
 *   1–1.08 The last of the fog thins out.
 *
 * Methods (the quote rotator: await fog.dissolve(); toggle `hidden`; await fog.reveal();)
 *   dissolve({ duration = 1200 }?) → Promise   The text melts back into fog; resolves when it is gone.
 *                                              The fog lingers, and fades only if no reveal follows.
 *   reveal({ duration = 2000 }?)   → Promise   That fog drifts over to the now-visible quote and
 *                                              condenses into it; resolves when it is fully legible.
 * Event (bubbling)  fog-reveal:statechange, detail { state }.
 *
 * No effect (data-state="clear" at once; both methods resolve immediately) under
 * prefers-reduced-motion, in the Shopify theme editor, or without canvas / Web Animations.
 *
 * How it works: the visible text's glyphs are sampled from the live layout (Range client rects per
 * character, drawn with the computed font into an offscreen canvas, alpha sampled on a jittered grid).
 * Each particle has a home in the fog bank (scattered around its glyph point) and a condensation
 * amount c: it is drawn at mix(home, glyph, c), large and faint at c = 0, small and brighter at c = 1.
 * Gathering eases c up, dissolving eases it down; particles keep their home and c between quotes,
 * so a dissolve flows into the next reveal. One in 14 is a big, faint puff that never fully condenses.
 * The HTML text animates only opacity and filter (Web Animations), so layout never moves. One fixed,
 * pointer-events:none, aria-hidden canvas exists only while fog is visible. Particles: ≤ 3000, ≤ 1200
 * on phones. If the quote was laid out in a fallback face, targets follow the webfont when it lands.
 */

const { random, sin, cos, min, max, sqrt } = Math;
const MIN_GATHER = 600;
const DEFAULT_MIST = [214, 208, 220];
const GLOW = [255, 250, 240];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const spread = (r) => (random() - 0.5) * r;
/** Roughly normal in −1…1, for a cloud that thins out at its edges. */
const bell = () => (random() + random() + random() - 1.5) / 1.5;
const TEXT_IN = { opacity: [0, 0.2, 0.65, 1], filter: ['blur(16px)', 'blur(10px)', 'blur(4px)', 'blur(0px)'] };
const TEXT_OUT = { opacity: [1, 0.55, 0], filter: ['blur(0px)', 'blur(5px)', 'blur(14px)'] };
/** Soft sprite profile: offset, opacity. */
const SPRITE = [[0, 0.85], [0.3, 0.5], [0.6, 0.17], [1, 0]];

/** Animate figures' opacity/filter on the document timeline, from `start` (performance.now() ms). */
const animateText = (figs, keyframes, start, duration) => figs.map((fig) => {
  const a = fig.animate(keyframes, { duration, fill: 'both', easing: 'ease-in-out' });
  a.startTime = start;
  return a;
});

/**
 * Points (viewport CSS px) covering the glyphs of the figures' visible text, at a density tied to the
 * type size (so a short quote gets fewer points, not denser ones), at most `count`. Each character is drawn at its laid-out client rect with its computed font, so wrapping,
 * letter-spacing and text-transform match what the reader sees.
 */
function sampleGlyphs(figs, count) {
  const chars = [];
  for (const fig of figs) {
    const walk = document.createTreeWalker(fig, NodeFilter.SHOW_TEXT), range = document.createRange();
    while (walk.nextNode()) {
      const node = walk.currentNode, st = getComputedStyle(node.parentElement);
      const font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`, upper = st.textTransform === 'uppercase';
      for (let i = 0; i < node.length; i++) {
        const ch = node.data[i];
        if (!ch.trim()) continue;
        range.setStart(node, i); range.setEnd(node, i + 1);
        const r = range.getClientRects()[0];
        if (r && r.width > 0.5) chars.push([upper ? ch.toUpperCase() : ch, r.left, r.top, r.height, font]);
      }
    }
  }
  // Drawn at viewport coordinates, so sampled points are already where the reader sees the glyphs.
  const w = innerWidth, h = innerHeight, cv = document.createElement('canvas'), c = cv.getContext('2d', { willReadFrequently: true });
  cv.width = w; cv.height = h;
  for (const [ch, left, top, height, font] of chars) {
    c.font = font;
    const m = c.measureText(ch), asc = m.fontBoundingBoxAscent ?? height * 0.8, desc = m.fontBoundingBoxDescent ?? height * 0.2;
    c.fillText(ch, left, top + (height - asc - desc) / 2 + asc);
  }
  const alpha = c.getImageData(0, 0, w, h).data;
  cv.width = 0; // release the backing store now (Mobile Safari holds it until GC)
  let ink = 0;
  for (let i = 3; i < alpha.length; i += 4) if (alpha[i] > 127) ink++;
  const step = max(1, sqrt(ink / count), max(...chars.map((c) => c[3])) / 16), pts = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const sx = (x + random() * step) | 0, sy = (y + random() * step) | 0;
    if (sx < w && sy < h && alpha[(sy * w + sx) * 4 + 3] > 127) pts.push([sx, sy]);
  }
  const out = pts.sort(() => random() - 0.5).slice(0, count);
  out.step = step; // spacing between neighbouring targets, in CSS px
  return out;
}

/** Set data-state and announce it (fog-reveal:statechange, bubbling). */
function setState(host, state) {
  if (host.dataset.state === state) return;
  host.dataset.state = state;
  host.dispatchEvent(new CustomEvent('fog-reveal:statechange', { bubbles: true, detail: { state } }));
}

/** The fog for one <fog-reveal>; all mutable state lives in this closure. */
function createFog(host) {
  const cap = innerWidth < 760 ? 1200 : 3000; // particles: phones vs larger screens
  let canvas = null, ctx = null, sprite = null, raf = 0, flight = null, motes = [], text = [], dpr = 1, width = 0, drawn = 0;

  const atmosphere = () => window.endureScene?.getAtmosphere?.()?.mist || DEFAULT_MIST;
  const mistBand = () => window.endureScene?.getMistBand?.() || { top: innerHeight * 0.6, bottom: innerHeight * 0.74 };
  const figures = () => [...host.children].filter((el) => !el.hidden);
  const setText = (anims) => { text.forEach((a) => a.cancel()); text = anims; };

  function ensureCanvas() {
    if (canvas) return;
    dpr = min(window.devicePixelRatio || 1, 1.5);
    canvas = document.createElement('canvas');
    canvas.ariaHidden = 'true';
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5';
    canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr);
    width = innerWidth;
    document.body.append(canvas);
    ctx = canvas.getContext('2d');
    sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
  }
  function teardown() {
    cancelAnimationFrame(raf); raf = 0;
    if (canvas) { canvas.width = canvas.height = 0; canvas.remove(); }
    canvas = ctx = null; motes = [];
  }

  /**
   * Start a flight of duration T over glyph points `pts`. Gathering (into) eases every particle's
   * condensation up to 1 after `linger`; dissolving eases it down to 0. Existing particles carry on
   * from their current home, condensation and brightness; new ones start in the fog bank (or, on the
   * first reveal, a few as wisps down in the mist band), or on the glyph when dissolving.
   */
  function launch(into, T, pts, linger, first, resolve) {
    ensureCanvas();
    if (!pts.length) pts = motes.map((m) => [m.gx, m.gy]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), grain = pts.step || 4, glyph = grain * 16;
    // Fewer particles (a short quote, a phone) each carry more fog, so the bank has the same body.
    const body = min(1.8, max(1, sqrt(1600 / pts.length)));
    // Sizes follow the type: 1 at the desktop hero size (glyphs ~80 px tall), ~0.5 on a phone.
    const u = min(1.5, max(0.35, glyph / 80));
    const bw = max(...xs) - min(...xs) || 200, bh = max(...ys) - min(...ys) || 80, band = mistBand();
    motes = pts.map(([gx, gy], i) => {
      const old = motes[i], puff = !(i % 14), wisp = first && !puff && random() < 0.1;
      // Home in the fog bank: scattered around the glyph point, so the bank covers the quote's area
      // (and, for a short quote, still reads as a cloud: at least a few glyph-heights across).
      const hx = gx + bell() * max(bw * 0.24, glyph * 2.5), hy = gy + bell() * max(bh * 0.6, glyph * 1.1);
      const m = old || {
        ph: random() * 6.3, w: 0.5 + random() * 0.7, am: (6 + random() * 10) * u, // slow wobble
        af: (puff ? 0.05 + random() * 0.03 : 0.036 + random() * 0.032) * body, // fog opacity
        sf: (puff ? 50 + random() * 90 : 8 + random() * 10) * u, // fog radius
        hxNow: wisp ? gx + spread(innerWidth * 0.5) : hx, hyNow: wisp ? lerp(band.top, band.bottom, random()) : hy,
        c: into ? 0 : 1, a: 0,
      };
      // On the first reveal the fog is simply there: start at its resting opacity, not from nothing.
      if (!old && first) m.a = m.af * 0.7;
      return Object.assign(m, {
        gx, gy, hx, hy, px: m.hxNow, py: m.hyNow, hb: (wisp ? 0.55 : 0.3) * T, gone: false,
        s: (into ? linger + random() * 0.12 : 0.04 + random() * 0.24) * T, e: (into ? 0.78 + random() * 0.16 : 0.62 + random() * 0.3) * T,
        c0: m.c, a0: m.a, cap: into ? (puff ? 0.3 : 1) : 0,
        // On the glyph: soft vapour a little wider than the stroke spacing, so the words form as fog, not glitter.
        an: puff ? 0.04 : 0.12 + random() * 0.08, sn: puff ? m.sf * 0.8 : grain * (1.4 + random() * 0.6),
      });
    }).concat(
      // Particles the new text doesn't need stay fog and thin out over the first part of the flight.
      motes.slice(pts.length).map((m) => Object.assign(m, { gone: true, px: m.hxNow, py: m.hyNow, hx: m.hxNow, hy: m.hyNow, s: 0, e: T * 0.6, c0: m.c, a0: m.a, cap: 0 })),
    );
    if (flight) { clearTimeout(flight.timer); flight.resolve(); }
    const t0 = performance.now();
    // A dissolve's fog lingers for 1.5 s and then fades, unless a reveal takes it over first.
    flight = { into, first, T, t0, u, top: host.getBoundingClientRect().top, end: into ? T * 1.08 : T + 2700, resolve };
    flight.timer = setTimeout(() => settle(flight), T);
    draw(t0); // the fog is there in the very frame the element connects
    if (!raf && !document.hidden) raf = requestAnimationFrame(loop);
  }
  /** The text is fully legible (gather) or gone (dissolve): update state and resolve; fog may linger. */
  function settle(f) {
    if (!f || f.settled) return;
    f.settled = true;
    clearTimeout(f.timer);
    if (f.into) { setText([]); setState(host, 'clear'); } else setState(host, 'dissolved');
    f.resolve();
  }
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - drawn > 12) draw((drawn = now)); // ~60 fps, also on 120 Hz screens
  }
  function draw(now) {
    const f = flight, t = f && now - f.t0;
    if (!f || t >= f.end) { settle(f); flight = null; teardown(); return; }
    const { T, into } = f, k = t / T;
    // The quote can scroll while the fog gathers; keep the field anchored to it.
    const dy = host.getBoundingClientRect().top - f.top;
    ctx.setTransform(dpr, 0, 0, dpr, 0, dy * dpr);
    ctx.clearRect(0, -dy, innerWidth, innerHeight);
    // One soft sprite, re-tinted every frame: the scene's mist while it hangs, warm white as it condenses.
    const warmth = into ? smooth(0.3, 1, k) : 1 - smooth(0, 0.7, k);
    const col = atmosphere().map((v, i) => lerp(v, GLOW[i], warmth) | 0).join(','), sc = sprite.getContext('2d'), g = sc.createRadialGradient(32, 32, 0, 32, 32, 32);
    SPRITE.forEach(([o, a]) => g.addColorStop(o, `rgba(${col},${a})`));
    sc.clearRect(0, 0, 64, 64); sc.fillStyle = g; sc.fillRect(0, 0, 64, 64);
    ctx.globalCompositeOperation = 'lighter';
    // Overall presence: the first fog is there at once and settles in; it thins out as the words
    // clear (gather) or after it has lingered (dissolve).
    const env = into ? (f.first ? 0.7 + 0.3 * smooth(0, 0.12, k) : 1) * (1 - smooth(0.82, 1.08, k)) : smooth(0, 0.25, k) * (1 - smooth(T + 1500, T + 2700, t));
    const blendIn = smooth(0, 0.15, k), sway = sin(now * 0.0003) * 12 * f.u; // the whole bank drifts gently
    for (const m of motes) {
      const hb = smooth(0, m.hb, t);
      m.hxNow = lerp(m.px, m.hx, hb); m.hyNow = lerp(m.py, m.hy, hb);
      const wob = now * 0.0006 * m.w + m.ph, p = clamp01((t - m.s) / (m.e - m.s));
      m.c = lerp(m.c0, m.cap, p * p * p * (p * (p * 6 - 15) + 10)); // smootherstep: no snap at either end
      const x = lerp(m.hxNow + sin(wob) * m.am + sway, m.gx, m.c), y = lerp(m.hyNow + cos(wob * 0.7) * m.am * 0.5, m.gy, m.c);
      // Stays a large, faint wisp until late in its condensation, so the cloud thickens rather than
      // glitters; dimmed a little mid-way, where particles crowd together, so no hot spot flares up.
      const c3 = m.c * m.c * m.c;
      m.a = lerp(m.a0, lerp(m.af, m.an, c3) * (1 - m.c * (1 - m.c)) * env * (m.gone ? 1 - smooth(0, 0.6, k) : 1), blendIn);
      const s = lerp(m.sf, m.sn, m.c * m.c * sqrt(m.c));
      if (m.a < 0.004) continue;
      ctx.globalAlpha = m.a;
      ctx.drawImage(sprite, x - s, y - s, s * 2, s * 2);
    }
  }
  /** Jump to the end state now (resize, disconnect). */
  function finishNow() {
    const f = flight;
    flight = null;
    if (f) { text.forEach((a) => a.finish()); settle(f); }
    teardown();
  }
  /** Fog over the visible quote, condensing so it is fully legible `T` ms from now. */
  function gather(T, first, resolve) {
    const t0 = performance.now(), figs = figures();
    setState(host, 'gathering');
    // The real text resolves over the last third (≈1.5 s of a 4.5 s reveal).
    setText(animateText(figs, TEXT_IN, t0 + T * 0.66, T * 0.34));
    launch(true, T, sampleGlyphs(figs, cap), first ? 0.28 : 0.18, first, resolve);
    // Laid out in a fallback face? Re-aim at the real glyphs when the webfont lands (only while the
    // particles are still hanging in the fog, so the change can't be seen).
    if (document.fonts?.status === 'loading') {
      const f = flight;
      document.fonts.ready.then(() => {
        const pts = f === flight && performance.now() - t0 < T * 0.4 ? sampleGlyphs(figs, cap) : [];
        motes.forEach((m, i) => { if (pts.length) [m.gx, m.gy] = pts[i % pts.length]; });
      });
    }
  }
  function dissolve(T, resolve) {
    const figs = figures(), now = performance.now();
    setState(host, 'dissolving');
    // Hold every other quote invisible too, so whichever one the rotator un-hides waits for reveal().
    setText([...animateText(figs, TEXT_OUT, now, T * 0.75), ...animateText([...host.children].filter((el) => el.hidden), TEXT_OUT, now, 1)]);
    launch(false, T, sampleGlyphs(figs, cap), 0, false, resolve);
  }
  // Finish at once when the width changes (a real resize or rotation); mobile toolbars only nudge the height.
  const onResize = () => { if (flight && innerWidth !== width) finishNow(); };
  const onVisibility = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else if (flight && !raf) raf = requestAnimationFrame(loop); };
  const listening = new AbortController(), { signal } = listening;
  addEventListener('resize', onResize, { signal });
  document.addEventListener('visibilitychange', onVisibility, { signal });
  return { gather, dissolve, destroy() { finishNow(); setText([]); listening.abort(); } };
}

const isInstant = () => matchMedia('(prefers-reduced-motion: reduce)').matches || !!window.Shopify?.designMode || !window.CanvasRenderingContext2D || !Element.prototype.animate;

class FogReveal extends HTMLElement {
  #fog = null;
  connectedCallback() {
    const delay = +this.getAttribute('delay') || 4500, now = performance.now();
    // Connected after the theme's CSS fallback began fading the quote in (at `delay`)? Never hide it
    // again: just finish that fade from wherever it is, with no fog.
    const shown = [...this.children].filter((el) => !el.hidden).map((el) => [el, +getComputedStyle(el).opacity]);
    if (isInstant() || now >= delay || shown.some(([, o]) => o > 0.02)) {
      shown.forEach(([el, o]) => o > 0.02 && o < 0.98 && el.animate({ opacity: [o, 1] }, { duration: (1 - o) * 1200, easing: 'ease-out' }));
      return setState(this, 'clear');
    }
    this.#fog = createFog(this);
    this.#fog.gather(max(MIN_GATHER, delay - now), true, () => {});
  }
  disconnectedCallback() { this.#fog?.destroy(); this.#fog = null; }
  dissolve({ duration = 1200 } = {}) { return this.#run((fog, done) => fog.dissolve(duration, done), duration); }
  reveal({ duration = 2000 } = {}) { return this.#run((fog, done) => fog.gather(duration, false, done), duration); }
  #run(start, duration) {
    if (!this.#fog || isInstant() || !(duration >= 1)) return Promise.resolve();
    return new Promise((done) => start(this.#fog, done));
  }
}

if (!customElements.get('fog-reveal')) customElements.define('fog-reveal', FogReveal);

export { FogReveal };
