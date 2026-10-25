// ENDÛRE lightbox: <media-lightbox> wraps a native <dialog> gallery of every
// shot of a product (snippets/media-lightbox). showModal() makes the page
// inert, traps focus, closes on Escape and returns focus to the opener; CSS
// scroll-snap gives touch swipe. This adds open-at-index, prev/next, arrow
// keys, a counter that follows swipes, video pause on close, and focus back on
// the opener (Safari doesn't focus a clicked button, so the dialog can't).
class MediaLightbox extends HTMLElement {
  connectedCallback() {
    this.dialog = this.querySelector('dialog');
    this.track = this.querySelector('[data-track]');
    this.slides = Array.from(this.track?.children ?? []);
    this.counter = this.querySelector('[data-current]');
    this.index = 0;
    if (!this.dialog || this.slides.length === 0) return;

    this.querySelector('[data-close]')?.addEventListener('click', () => this.dialog.close());
    this.querySelector('[data-prev]')?.addEventListener('click', () => this.go(this.index - 1));
    this.querySelector('[data-next]')?.addEventListener('click', () => this.go(this.index + 1));

    this.dialog.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); this.go(this.index + 1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); this.go(this.index - 1); }
    });
    // Clicking the empty area around a shot closes, like most lightboxes.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog || event.target.classList.contains('lightbox__slide')) this.dialog.close();
    });
    this.dialog.addEventListener('close', () => {
      this.querySelectorAll('video').forEach((video) => video.pause());
      this.opener?.focus({ preventScroll: true });
    });

    // Keep the counter right when the visitor swipes instead of using buttons.
    // While a button/key scroll is in flight, slides it passes on the way don't
    // count: only reaching the target (or the scroll ending) settles the index.
    this.pending = null;
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const index = this.slides.indexOf(entry.target);
        if (!entry.isIntersecting || (this.pending !== null && index !== this.pending)) continue;
        this.pending = null;
        this.setIndex(index);
      }
    }, { root: this.track, threshold: 0.6 });
    this.slides.forEach((slide) => this.observer.observe(slide));
    this.track.addEventListener('scrollend', () => { this.pending = null; });
  }

  disconnectedCallback() {
    this.observer?.disconnect();
  }

  open(index = 0, opener = null) {
    this.opener = opener;
    this.dialog.showModal();
    this.go(index, 'instant');
  }

  go(index, behavior) {
    const count = this.slides.length;
    const next = (index + count) % count;
    const wraps = Math.abs(next - this.index) > 1; // last ↔ first: jump, don't fly past every shot
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.pending = next;
    this.slides[next].scrollIntoView({ behavior: behavior ?? (reduce || wraps ? 'instant' : 'smooth'), block: 'nearest', inline: 'start' });
    this.setIndex(next);
  }

  setIndex(index) {
    this.index = index;
    if (this.counter) this.counter.textContent = String(index + 1);
  }
}

if (!customElements.get('media-lightbox')) customElements.define('media-lightbox', MediaLightbox);

// Any element with data-lightbox-open="<dialog id>" opens that gallery at data-index.
document.addEventListener('click', (event) => {
  const trigger = event.target instanceof Element ? event.target.closest('[data-lightbox-open]') : null;
  if (!trigger) return;
  const host = document.getElementById(trigger.dataset.lightboxOpen)?.closest('media-lightbox');
  if (!host?.open) return;
  event.preventDefault();
  host.open(Number(trigger.dataset.index ?? 0), trigger);
});
