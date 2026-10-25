// ENDÛRE theme behaviour. Progressive enhancement only: every word and every
// form is in the server-rendered HTML; this adds motion and conveniences.
import '@theme/cart';
import '@theme/lightbox';

const strings = window.Theme?.strings ?? {};
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const designMode = Boolean(window.Shopify?.designMode);

/* ---------- one "pause motion" control (WCAG 2.2.2) ----------
   The scene toggle pauses the living background AND the quote rotation. */
const motion = {
  paused: reduceMotion.matches,
  listeners: new Set(),
  set(paused) {
    this.paused = paused;
    this.listeners.forEach((listener) => listener(paused));
  },
};

function initSceneToggle() {
  const button = document.querySelector('[data-scene-toggle]');
  if (!button) return;
  const render = (paused) => {
    const scene = document.querySelector('endure-scene');
    // One stable label ("Pause motion") + aria-pressed; swapping the label too would announce "Play motion, pressed".
    button.setAttribute('aria-pressed', String(paused));
    if (paused) scene?.pause?.();
    else scene?.play?.();
  };
  motion.listeners.add(render);
  button.addEventListener('click', () => motion.set(!motion.paused));
  customElements.whenDefined('endure-scene').then(() => render(motion.paused));
}

/* ---------- scene clock ----------
   A full day runs in seconds (theme setting scene_cycle_seconds), so the
   clock ticks fast; refresh ~10×/s. */
function initSceneClock() {
  const clock = document.querySelector('[data-scene-clock]');
  const time = clock?.querySelector('[data-scene-clock-time]');
  if (!clock || !time) return;
  const tick = () => {
    const now = window.endureScene?.getClock?.();
    if (!now) return;
    const hour12 = ((now.h + 11) % 12) + 1;
    const text = `${String(hour12).padStart(2, '0')}:${String(now.m).padStart(2, '0')} ${now.h < 12 ? 'AM' : 'PM'} · ${strings.clockSuffix ?? ''}`;
    if (time.textContent !== text) time.textContent = text;
  };
  tick();
  setInterval(() => {
    if (!document.hidden) tick();
  }, 100);

  // Fade the clock out while the footer is on screen so they never overlap.
  const footer = document.querySelector('[data-site-footer]');
  if (footer) {
    new IntersectionObserver(([entry]) => clock.classList.toggle('is-hidden', entry.isIntersecting)).observe(footer);
  }
}

/* ---------- hero quote rotator ----------
   <fog-reveal> owns the look of each change (dissolve → reveal); this decides
   when: each quote stays fully formed for `data-interval` seconds, counted
   from the end of its reveal, then melts into the next. Auto-rotation waits
   for the first reveal, and pauses on hover, focus, the pause-motion control,
   and under reduced motion. */
function initQuoteRotator(root) {
  const quotes = Array.from(root.querySelectorAll('[data-quote]'));
  if (quotes.length < 2 || root.dataset.rotatorReady) return;
  root.dataset.rotatorReady = 'true';

  const interval = Number(root.dataset.interval || 9) * 1000;
  const controls = document.querySelectorAll(`[data-quote-step][aria-controls="${root.id}"]`);
  let index = Math.max(0, quotes.findIndex((quote) => !quote.hidden));
  let timer = 0;
  let busy = false;
  let held = false; // hover or focus inside
  let editing = false; // a quote is selected in the theme editor

  const animated = () => typeof root.dissolve === 'function' && !reduceMotion.matches && !designMode;

  async function show(next, announce) {
    if (busy) return;
    busy = true;
    root.setAttribute('aria-live', announce ? 'polite' : 'off');
    const target = (next + quotes.length) % quotes.length;
    try {
      if (animated()) await root.dissolve();
      quotes[index].hidden = true;
      quotes[target].hidden = false;
      index = target;
      if (animated()) await root.reveal();
    } finally {
      busy = false;
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (motion.paused || held || editing || reduceMotion.matches) return;
    timer = setTimeout(async () => {
      await show(index + 1, false);
      schedule();
    }, interval);
  }

  controls.forEach((button) => {
    button.addEventListener('click', async () => {
      clearTimeout(timer);
      await show(index + Number(button.dataset.quoteStep), true);
      if (!held) schedule();
    });
  });
  const hold = (value) => () => {
    held = value;
    if (held) clearTimeout(timer);
    else schedule();
  };
  const region = root.closest('.hero__inner') ?? root; // the quote and its arrows
  region.addEventListener('pointerenter', hold(true));
  region.addEventListener('pointerleave', hold(false));
  region.addEventListener('focusin', hold(true));
  region.addEventListener('focusout', (event) => {
    if (!region.contains(event.relatedTarget)) hold(false)();
  });
  motion.listeners.add(() => schedule());

  // Theme editor: show whichever quote block the merchant selects.
  document.addEventListener('shopify:block:select', (event) => {
    const selected = quotes.indexOf(event.target);
    if (selected < 0) return;
    editing = true;
    clearTimeout(timer);
    quotes[index].hidden = true;
    quotes[selected].hidden = false;
    index = selected;
  });
  document.addEventListener('shopify:block:deselect', () => {
    editing = false;
    schedule();
  });

  // Start once the first quote has gathered out of the fog (or straight away
  // if <fog-reveal> isn't running).
  const start = () => schedule();
  if (root.dataset.state === 'clear' || designMode) return start();
  const onState = (event) => {
    if (event.detail?.state !== 'clear') return;
    root.removeEventListener('fog-reveal:statechange', onState);
    start();
  };
  root.addEventListener('fog-reveal:statechange', onState);
  setTimeout(() => {
    if (!timer && root.dataset.state !== 'gathering') start();
  }, 4000);
}

function init(root = document) {
  root.querySelectorAll('[data-quote-rotator]').forEach(initQuoteRotator);
}

initSceneToggle();
initSceneClock();
init();
document.addEventListener('shopify:section:load', (event) => init(event.target));
