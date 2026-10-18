// Keeps a page up to date while it is looked at: every half minute, and at
// once when the app comes back to the front, it asks the server for the page
// again and loads it anew if what the server shows has changed. The browser
// keeps the scroll position across the reload.
//
// It waits while the reader is busy with the page: typing, a search or a
// note with text in it, something opened (a log, a held call's arguments),
// text selected, a request still running, or anything touched in the last
// minute, so that an outcome just shown is not wiped before it is read.

const EVERY_MS = 30_000;
const QUIET_MS = 60_000;

/** The page's <main> as the browser serialises it, for comparing. */
const content = html => new DOMParser().parseFromString(html, 'text/html').querySelector('main')?.innerHTML ?? '';

/**
 * Starts refreshing. `original` is the page's <main> as the server sent it,
 * read before any script changed it.
 */
export function autoRefresh(original) {
  const main = document.querySelector('main');
  if (!main) return;
  let touched = 0;
  for (const event of ['pointerdown', 'keydown', 'input']) document.addEventListener(event, () => { touched = Date.now(); }, true);

  const busy = () => {
    const active = document.activeElement;
    return Date.now() - touched < QUIET_MS
      || Boolean(active?.matches('input, textarea, select, [contenteditable]'))
      || [...main.querySelectorAll('input:not([type=hidden]), textarea')].some(field => field.value.trim())
      || Boolean(main.querySelector('details[open]'))
      || Boolean(String(window.getSelection?.() ?? '').trim())
      // An outcome that ends in "…" is a request still on its way.
      || [...main.querySelectorAll('.outcome, #notice, #ask-outcome')].some(p => p.textContent.trim().endsWith('…'));
  };

  let running = false;
  async function look() {
    if (running || document.visibilityState !== 'visible' || busy()) return;
    running = true;
    try {
      const res = await fetch(location.href, { cache: 'no-store', headers: { accept: 'text/html' } });
      // A redirect is Access asking to log in again: a reload shows that page.
      if (!res.ok || res.redirected) return;
      if (content(await res.text()) !== original && !busy()) location.reload();
    } catch {
      // Offline for the moment: the next look tries again.
    } finally {
      running = false;
    }
  }

  setInterval(look, EVERY_MS);
  document.addEventListener('visibilitychange', look);
}
