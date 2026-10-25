// ENDÛRE scroll story: <story-crawl> (sections/story-crawl).
//
// Motion: every beat and polaroid gets --p, how far its middle is from the
// middle of the screen in half-screens (-1 above, 0 centre, 1 below), and
// --d = |p|. theme.css turns those into the opening-crawl look: words come up
// from below, are flat and sharp at the centre, then tilt back, recede and
// fade. It only listens to scroll while the section is on screen, and stays
// still under reduced motion and in the theme editor.
//
// Polaroids: tapping one shows a copy, enlarged, in a native <dialog>
// (showModal: page inert, focus trapped, Escape closes). Any tap closes it,
// except on a credit link. Focus goes back to the polaroid (Safari doesn't
// focus a clicked button, so the dialog alone wouldn't put it back).
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const designMode = Boolean(window.Shopify?.designMode);
const LIMIT = 1.5; // past this the item is off screen and fully faded anyway

class StoryCrawl extends HTMLElement {
  connectedCallback() {
    this.items = Array.from(this.querySelectorAll('[data-crawl-item]'));
    this.dialog = this.querySelector('[data-polaroid-dialog]');
    this.stage = this.querySelector('[data-polaroid-stage]');
    this.frame = 0;
    this.update = this.update.bind(this);
    this.requestUpdate = () => {
      if (!this.frame) this.frame = requestAnimationFrame(this.update);
    };
    this.refresh = () => this.setLive(this.visible);

    this.initZoom();
    this.observer = new IntersectionObserver(([entry]) => this.setLive(entry.isIntersecting));
    this.observer.observe(this);
    reduceMotion.addEventListener('change', this.refresh);
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    reduceMotion.removeEventListener('change', this.refresh);
    this.setLive(false);
  }

  setLive(visible) {
    this.visible = visible;
    const live = Boolean(visible) && !reduceMotion.matches && !designMode;
    if (live === this.live) return;
    this.live = live;
    this.classList.toggle('is-live', live);
    const method = live ? 'addEventListener' : 'removeEventListener';
    window[method]('scroll', this.requestUpdate, { passive: true });
    window[method]('resize', this.requestUpdate, { passive: true });
    if (live) this.update();
  }

  update() {
    this.frame = 0;
    const half = window.innerHeight / 2;
    // Read every position, then write, so the page is laid out once per frame.
    // A polaroid slot with no height (wide screens) floats beside the beat
    // after it, so it moves with that beat.
    const offsets = this.items.map((item) => {
      const anchor = item.offsetHeight === 0 && item.nextElementSibling ? item.nextElementSibling : item;
      const rect = anchor.getBoundingClientRect();
      return Math.max(-LIMIT, Math.min(LIMIT, (rect.top + rect.height / 2 - half) / half));
    });
    offsets.forEach((p, index) => {
      const { style } = this.items[index];
      style.setProperty('--p', p.toFixed(3));
      style.setProperty('--d', Math.abs(p).toFixed(3));
    });
  }

  initZoom() {
    if (!this.dialog || !this.stage) return;
    this.querySelectorAll('[data-polaroid-zoom]').forEach((button) => {
      button.hidden = false;
    });
    this.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-polaroid-zoom]') : null;
      if (button && !this.dialog.contains(button)) this.zoom(button);
    });
    this.dialog.addEventListener('click', (event) => {
      if (!(event.target instanceof Element && event.target.closest('a'))) this.dialog.close();
    });
    this.dialog.addEventListener('close', () => {
      this.stage.replaceChildren();
      this.opener?.focus({ preventScroll: true });
    });
  }

  zoom(button) {
    const polaroid = button.closest('.polaroid');
    if (!polaroid) return;
    this.opener = button;
    const copy = polaroid.cloneNode(true);
    copy.querySelector('[data-polaroid-zoom]')?.remove();
    copy.querySelectorAll('img').forEach((img) => {
      img.loading = 'eager';
      img.sizes = '(min-width: 700px) 540px, 92vw'; // pick a sharper file from the same srcset
    });
    copy.querySelectorAll('a').forEach((link) => {
      link.target = '_blank';
      link.rel = 'noopener';
    });
    this.stage.replaceChildren(copy);
    this.dialog.showModal();
  }
}

if (!customElements.get('story-crawl')) customElements.define('story-crawl', StoryCrawl);
