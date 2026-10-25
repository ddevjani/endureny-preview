// Static design preview only (added by scripts/preview/export.mjs, never part
// of the theme). There's no shop behind these pages, so buying and signing up
// can't work: those forms say so instead of failing, and a badge marks every
// page as a preview.
const NOTICE = {
  '/cart': 'Design preview: the shop isn’t open yet, so nothing is added.',
  '/contact': 'Design preview: signups open at launch, so nothing was sent.',
};

function noticeFor(form) {
  const action = form.getAttribute('action') ?? '';
  return Object.entries(NOTICE).find(([prefix]) => action.startsWith(prefix))?.[1];
}

function showNotice(form, text) {
  let status = form.querySelector('[data-status]') ?? form.querySelector('[data-preview-notice]');
  if (!status) {
    status = document.createElement('p');
    status.className = 'preview-notice';
    status.setAttribute('role', 'status');
    status.dataset.previewNotice = '';
    form.append(status);
  }
  status.textContent = text;
}

// Capture phase on the document runs before the theme's own submit handlers.
document.addEventListener(
  'submit',
  (event) => {
    const text = event.target instanceof HTMLFormElement ? noticeFor(event.target) : null;
    if (!text) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showNotice(event.target, text);
  },
  true,
);

const badge = document.createElement('p');
badge.className = 'preview-badge';
badge.textContent = 'Design preview · not a live shop';
document.body.append(badge);
