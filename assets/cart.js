// ENDÛRE cart: AJAX add to bag, the cart drawer, line quantity changes, size
// sync between forms for the same product, and Shopify's standard storefront
// events + actions, so apps and AI agents calling Shopify.actions drive this
// UI. Every form still works without JavaScript (native POSTs to /cart).
import { CartLinesUpdateEvent, StandardEvents, createViewEventElement } from '@shopify/events';

const DRAWER_SECTION = 'cart-drawer'; // static section: its id is its file name
const { routes, strings } = window.Theme;
const drawer = () => document.querySelector('[data-cart-drawer]');

// <product-view view-event-payload="…"> fires shopify:product:view once it scrolls into view.
if (!customElements.get('product-view')) {
  customElements.define('product-view', createViewEventElement(HTMLElement, { defaultTrigger: 'intersect' }));
}

function swapDrawer(sectionHtml) {
  const dialog = drawer();
  if (!sectionHtml || !dialog) return;
  const fresh = new DOMParser().parseFromString(sectionHtml, 'text/html').querySelector('[data-cart-drawer]');
  if (fresh) dialog.replaceChildren(...fresh.childNodes); // keep the <dialog> itself, and its open state
}

async function refreshDrawer() {
  const response = await fetch(`${routes.root}?sections=${DRAWER_SECTION}`);
  swapDrawer((await response.json())[DRAWER_SECTION]);
}

function openDrawer() {
  const dialog = drawer();
  if (dialog && !dialog.open) dialog.showModal();
}

function renderCount(count) {
  document.querySelectorAll('[data-cart-count]').forEach((badge) => {
    badge.firstChild.textContent = String(count);
    badge.hidden = count === 0;
  });
}

async function fetchCart() {
  return (await fetch(`${routes.cart_url}.js`, { headers: { Accept: 'application/json' } })).json();
}

/**
 * Wraps one cart mutation in a standard CartLinesUpdateEvent: dispatched
 * before the request, resolved with the cart summary once it settles.
 */
async function withLinesEvent(target, payload, request) {
  const deferred = CartLinesUpdateEvent.createPromise();
  target.dispatchEvent(new CartLinesUpdateEvent({ ...payload, promise: deferred.promise }));
  let didError = false;
  try {
    return await request();
  } catch (error) {
    didError = true;
    throw error;
  } finally {
    const cart = await fetchCart().catch(() => null);
    deferred.resolve({ cart: cart && CartLinesUpdateEvent.createCartFromAjaxResponse(cart), detail: { didError } });
  }
}

class BuyForm extends HTMLElement {
  connectedCallback() {
    this.form = this.querySelector('form[data-buy-form]');
    this.form?.addEventListener('change', this.#onChange);
    this.form?.addEventListener('submit', this.#onSubmit);
  }

  disconnectedCallback() {
    this.form?.removeEventListener('change', this.#onChange);
    this.form?.removeEventListener('submit', this.#onSubmit);
  }

  /** Shows the given size radio's price on the add button. */
  showPrice(radio) {
    const price = this.querySelector('[data-price]');
    if (price && radio?.dataset.price) price.textContent = radio.dataset.price;
  }

  /** Selects a variant without user input (used to keep card and table in sync). */
  selectVariant(variantId) {
    const radio = this.querySelector(`input[name="id"][value="${variantId}"]`);
    if (!radio || radio.checked || radio.disabled) return;
    radio.checked = true;
    this.showPrice(radio);
  }

  #onChange = (event) => {
    if (event.target.name !== 'id') return;
    this.showPrice(event.target);
    document.querySelectorAll(`buy-form[data-product-id="${this.dataset.productId}"]`).forEach((other) => {
      if (other !== this) other.selectVariant(event.target.value);
    });
  };

  #onSubmit = async (event) => {
    // Shopify's accelerated checkout buttons handle their own submission.
    if (event.submitter && event.submitter.name !== 'add') return;
    event.preventDefault();

    const button = this.form.querySelector('[name="add"]');
    const status = this.querySelector('[data-status]');
    const body = new FormData(this.form);
    body.append('sections', DRAWER_SECTION);
    body.append('sections_url', window.location.pathname);

    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.textContent = '';
    let added = false;
    try {
      await withLinesEvent(
        this,
        { action: 'add', context: 'product', lines: [{ merchandiseId: String(body.get('id')), quantity: Number(body.get('quantity') ?? 1) }] },
        async () => {
          const response = await fetch(`${routes.cart_add_url}.js`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body,
          });
          const data = await response.json();
          if (!response.ok || data.status) throw new Error(data.description || data.message || strings.error);
          swapDrawer(data.sections?.[DRAWER_SECTION]);
        },
      );
      status.textContent = strings.added;
      added = true;
    } catch (error) {
      status.textContent = error.message || strings.error;
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
    // Open only after the button is enabled again, so closing the drawer returns focus to it.
    if (added) {
      button.focus({ preventScroll: true });
      openDrawer();
    }
  };
}
if (!customElements.get('buy-form')) customElements.define('buy-form', BuyForm);

// Quantity steppers, typed quantities and remove links, in the drawer or on the cart page.
async function changeLine(item, quantity) {
  if (item.getAttribute('aria-busy') === 'true') return; // one change per line at a time: no double "+", no stale drawer swaps
  const key = item.dataset.lineKey;
  const onCartPage = Boolean(item.closest('[data-main-cart]'));
  item.setAttribute('aria-busy', 'true');
  try {
    await withLinesEvent(
      item,
      { action: quantity === 0 ? 'remove' : 'update', context: onCartPage ? 'cart' : 'dialog', lines: [{ id: key, quantity }] },
      async () => {
        const response = await fetch(`${routes.cart_change_url}.js`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ id: key, quantity, sections: [DRAWER_SECTION], sections_url: window.location.pathname }),
        });
        const data = await response.json();
        if (!response.ok || data.status) throw new Error(data.description || data.message || strings.error);
        if (onCartPage) return window.location.reload();
        // Re-rendering replaces the line's controls; put focus back on the same
        // control of the same line, or on Close if the line is gone.
        const control = document.activeElement?.matches?.('[data-qty-step]') ? `[data-qty-step="${document.activeElement.dataset.qtyStep}"]` : '[data-qty-input]';
        swapDrawer(data.sections?.[DRAWER_SECTION]);
        const target = drawer()?.querySelector(`[data-line-key="${CSS.escape(key)}"] ${control}`) ?? drawer()?.querySelector('[data-close]');
        target?.focus();
      },
    );
  } catch {
    item.removeAttribute('aria-busy');
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  if (target.closest('[data-cart-drawer] [data-close]')) drawer()?.close();
  if (target.closest('[data-cart-open]') && drawer()) {
    event.preventDefault();
    openDrawer();
  }

  const item = target.closest('[data-line-key]');
  if (!item) return;
  const input = item.querySelector('[data-qty-input]');
  const step = target.closest('[data-qty-step]');
  if (step && input) {
    changeLine(item, Math.max(0, Number(input.value) + Number(step.dataset.qtyStep)));
  } else if (target.closest('[data-qty-remove]')) {
    event.preventDefault();
    changeLine(item, 0);
  }
});

document.addEventListener('change', (event) => {
  const input = event.target instanceof HTMLInputElement && event.target.matches('[data-qty-input]') ? event.target : null;
  const item = input?.closest('[data-line-key]');
  if (item) changeLine(item, Math.max(0, Number(input.value) || 0));
});

// Keep the header count and drawer current for cart changes made by anything
// else (apps, AI agents via Shopify.actions), and by our own forms.
document.addEventListener(StandardEvents.cartLinesUpdate, (event) => {
  event.promise
    ?.then(({ cart }) => {
      if (cart) renderCount(cart.totalQuantity);
      const ours = event.target instanceof Element && event.target.closest('buy-form, [data-line-key]');
      if (!ours) return refreshDrawer();
    })
    .catch(() => {}); // a failed update leaves the UI as it was; the form shows its own error
});

// Standard actions: apps and agents calling Shopify.actions get OUR drawer.
// Only the first configure() per action takes effect, so do it as early as the
// actions object exists: now, at DOMContentLoaded, or at load as a last resort.
let actionsRegistered = false;
function registerActions() {
  const actions = window.Shopify?.actions;
  if (!actions || actionsRegistered) return;
  actionsRegistered = true;
  actions.updateCart?.configure?.({ eventTarget: () => document.querySelector('cart-drawer') ?? document });
  actions.openCart?.configure?.({
    async handler() {
      if (!drawer()) {
        window.location.href = routes.cart_url;
        return;
      }
      await refreshDrawer();
      openDrawer();
    },
  });
}
registerActions();
document.addEventListener('DOMContentLoaded', registerActions, { once: true });
window.addEventListener('load', () => {
  registerActions();
  if (!actionsRegistered) console.warn('[ENDÛRE] Shopify.actions is unavailable; agents and apps will use the default cart UI.');
}, { once: true });
