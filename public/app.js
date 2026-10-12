// "Run now" buttons on the dashboard and the recipe page. The server checks
// that the request is same-origin; this only has to make it and say how it went.
const notice = document.getElementById('notice');

for (const button of document.querySelectorAll('button.run')) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    const recipe = button.dataset.recipe;
    try {
      const res = await fetch(`/api/recipes/${encodeURIComponent(recipe)}/run`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (notice) notice.textContent = res.ok ? `Started ${recipe}. Reload in a minute to see how it went.` : `${recipe} did not start: ${body.error ?? res.status}`;
    } catch (err) {
      if (notice) notice.textContent = `${recipe} did not start: ${err.message}`;
      button.disabled = false;
    }
  });
}

// Approve and Reject on held calls. The gateway runs an approved call before
// it answers, so the outcome shown is what actually happened.
for (const button of document.querySelectorAll('button.approve, button.reject')) {
  button.addEventListener('click', async () => {
    const card = button.closest('li');
    const outcome = card.querySelector('.outcome');
    const verb = button.classList.contains('approve') ? 'approve' : 'reject';
    for (const b of card.querySelectorAll('.decide button')) b.disabled = true;
    outcome.textContent = verb === 'approve' ? 'Running…' : 'Rejecting…';
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(button.dataset.gateway)}/${encodeURIComponent(button.dataset.id)}/${verb}`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) outcome.textContent = 'Someone already decided this one. Reload to see how.';
      else if (res.status === 502) outcome.textContent = 'No answer yet. It may still be running: look on the Approvals page in a minute before trying again.';
      else if (!res.ok) outcome.textContent = `That did not work: ${body.error ?? res.status}`;
      else if (body.status === 'rejected') outcome.textContent = 'Rejected. Nothing ran.';
      else outcome.textContent = `${body.status === 'done' ? 'Done' : 'Failed'}: ${String(body.result ?? '').slice(0, 400)}`;
      card.classList.add('decided');
    } catch {
      // The connection dropped; the call may have run anyway. Not offering the
      // buttons again keeps it from running twice.
      outcome.textContent = 'No answer. It may have run: look on the Approvals page before trying again.';
    }
  });
}

// Search and favourites on the overview. The search only hides rows; the
// stars are kept on the server, so every device shows the same ones.
const find = document.getElementById('find');
const onlyFav = document.getElementById('only-fav');
const none = document.getElementById('none');
const rows = [...document.querySelectorAll('li.chore')];

/** Shows the rows that match the search and, if asked, are favourites. */
function filter() {
  const words = (find?.value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const favsOnly = onlyFav?.getAttribute('aria-pressed') === 'true';
  let shown = 0;
  for (const row of rows) {
    const text = row.dataset.search ?? '';
    const show = words.every(w => text.includes(w)) && (!favsOnly || row.dataset.fav === '1');
    row.hidden = !show;
    if (show) shown += 1;
  }
  if (none) none.hidden = shown > 0 || !rows.length;
}

/** The favourites filter is remembered on this device, the search is not. */
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* a private window: fine */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

if (find) {
  find.addEventListener('input', filter);
  find.addEventListener('keydown', event => {
    if (event.key === 'Escape') { find.value = ''; filter(); }
  });
  // "/" goes to the search box, as on most sites, unless one is typing already.
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      find.focus();
    }
  });
}
if (onlyFav) {
  if (recall('aemtli.onlyFav') === 'true') onlyFav.setAttribute('aria-pressed', 'true');
  onlyFav.addEventListener('click', () => {
    const on = onlyFav.getAttribute('aria-pressed') !== 'true';
    onlyFav.setAttribute('aria-pressed', String(on));
    remember('aemtli.onlyFav', String(on));
    filter();
  });
}
filter();

for (const star of document.querySelectorAll('button.fav')) {
  star.addEventListener('click', async () => {
    const on = star.getAttribute('aria-pressed') !== 'true';
    star.disabled = true;
    try {
      const res = await fetch(`/api/favorites/${encodeURIComponent(star.dataset.recipe)}/${on ? 'on' : 'off'}`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.status);
      star.setAttribute('aria-pressed', String(on));
      star.textContent = on ? '★' : '☆';
      star.title = on ? 'A favourite' : 'Make it a favourite';
      const row = star.closest('li.chore');
      if (on) row.dataset.fav = '1';
      else delete row.dataset.fav;
      filter();
    } catch (err) {
      if (notice) notice.textContent = `The star did not stick: ${err.message}`;
    } finally {
      star.disabled = false;
    }
  });
}
