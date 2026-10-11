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
