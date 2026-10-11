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
      if (notice) notice.textContent = res.ok ? `${recipe} started as ${body.job}.` : `${recipe}: ${body.error ?? res.status}`;
    } catch (err) {
      if (notice) notice.textContent = `${recipe}: ${err.message}`;
      button.disabled = false;
    }
  });
}
