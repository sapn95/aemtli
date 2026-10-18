// Notifications on this device, on the Connections page. The browser makes
// a subscription with the server's VAPID key and the server keeps it; a
// push then reaches the service worker (sw.js), which shows it. On an
// iPhone that works only in the app added to the home screen.

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

const bytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const sameKey = (buffer, key) => {
  const a = new Uint8Array(buffer ?? []);
  const b = bytes(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
};

/** Sets up the section that turns notifications on and off. */
export async function setUpPush(section) {
  const state = section.querySelector('.push-state');
  const [on, test, off] = ['#push-on', '#push-test', '#push-off'].map(s => section.querySelector(s));
  const say = (text, tone = 'quiet') => {
    state.textContent = text;
    state.className = `push-state ${tone}`;
  };
  const show = subscribed => {
    on.hidden = subscribed;
    test.hidden = !subscribed;
    off.hidden = !subscribed;
  };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    say('This browser cannot get notifications here. On an iPhone, add ämtli to the home screen and open it from there.');
    return;
  }
  let info;
  let registration;
  let subscription;
  try {
    info = await api('/api/push');
    registration = await navigator.serviceWorker.ready;
    subscription = await registration.pushManager.getSubscription();
    // Made with a key the server no longer has, it can never be used.
    if (subscription && !sameKey(subscription.options.applicationServerKey, info.publicKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    // The server may have lost it (a new volume); telling it again is harmless.
    if (subscription) await api('/api/push/subscribe', subscription.toJSON());
  } catch (err) {
    say(`Could not ask: ${err.message}.`, 'bad');
    return;
  }
  const settle = () => {
    if (Notification.permission === 'denied') {
      say('Notifications are blocked for this site. Allow them in the browser\'s site settings, then reload.', 'bad');
      show(false);
      on.hidden = true;
      return;
    }
    say(subscription ? 'On for this device.' : 'Off for this device.', subscription ? 'good' : 'quiet');
    show(Boolean(subscription));
  };
  settle();

  on.addEventListener('click', async () => {
    on.disabled = true;
    try {
      if (await Notification.requestPermission() !== 'granted') return settle();
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(info.publicKey) });
      await api('/api/push/subscribe', subscription.toJSON());
      settle();
    } catch (err) {
      say(`Could not turn them on: ${err.message}.`, 'bad');
    } finally {
      on.disabled = false;
    }
  });
  off.addEventListener('click', async () => {
    off.disabled = true;
    try {
      await api('/api/push/unsubscribe', { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
      subscription = null;
      settle();
    } catch (err) {
      say(`Could not turn them off: ${err.message}.`, 'bad');
    } finally {
      off.disabled = false;
    }
  });
  test.addEventListener('click', async () => {
    test.disabled = true;
    try {
      const { delivered } = await api('/api/push/test', {});
      say(delivered ? `Sent to ${delivered} device${delivered === 1 ? '' : 's'}. It should show in a moment.` : 'No device took it. Turn it off and on again.', delivered ? 'good' : 'bad');
    } catch (err) {
      say(`Could not send: ${err.message}.`, 'bad');
    } finally {
      test.disabled = false;
    }
  });
}
