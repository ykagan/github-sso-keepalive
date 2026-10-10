// Background monitor: periodically probes an SSO-protected GitHub page. When the
// SAML session has expired, it opens the SSO page in a background tab, lets
// content.js press "Continue", waits for the IdP round-trip to land back on
// github.com, then closes the tab.

const SSO_PATH = /^\/(orgs|enterprises)\/([^/]+)\/sso\/?$/;
const DEFAULTS = {
  enabled: true,
  pollMinutes: 1,
  onlyWhenGithubOpen: true,
  proactiveMinutes: 0, // 0 = only refresh once expired
  targets: [], // [{ kind: 'orgs' | 'enterprises', slug, probePath }]
};
const REFRESH_TIMEOUT_MS = 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000;

const getSettings = () => chrome.storage.sync.get(DEFAULTS);
const targetKey = (t) => `${t.kind}/${t.slug}`;
const defaultProbe = (t) => (t.kind === 'enterprises' ? `/enterprises/${t.slug}` : `/orgs/${t.slug}/repositories`);
const ssoUrl = (t) =>
  `https://github.com/${t.kind}/${t.slug}/sso?return_to=${encodeURIComponent(t.probePath || defaultProbe(t))}`;

async function setStatus(state, detail = '', key) {
  await chrome.storage.session.set({ status: { state, detail, key, at: Date.now() } });
  const [text, color] = {
    ok: ['', '#2da44e'],
    idle: ['', '#6e7781'],
    off: ['off', '#6e7781'],
    refreshing: ['…', '#9a6700'],
    error: ['!', '#cf222e'],
  }[state];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title: `GitHub SSO Keepalive: ${detail || state}` });
}

async function probe(t) {
  const res = await fetch('https://github.com' + (t.probePath || defaultProbe(t)), {
    credentials: 'include',
    cache: 'no-store',
  });
  const path = new URL(res.url).pathname;
  if (SSO_PATH.test(path)) return 'expired';
  const html = await res.text();
  if (html.includes('/saml/initiate')) return 'expired';
  if (path === '/login' || /<meta[^>]+name="user-login"[^>]+content=""/.test(html)) return 'logged-out';
  return 'valid';
}

let polling = false;
async function poll({ force = false } = {}) {
  if (polling) return;
  polling = true;
  try {
    const s = await getSettings();
    if (!s.enabled) return await setStatus('off', 'disabled');
    if (!s.targets.length) {
      return await setStatus('idle', 'no org yet: it is learned the first time you hit an SSO page, or add one in options');
    }

    const { refresh, backoffUntil = 0 } = await chrome.storage.session.get(['refresh', 'backoffUntil']);
    if (refresh) return; // a refresh is already in flight
    if (!force && Date.now() < backoffUntil) return;
    if (!force && s.onlyWhenGithubOpen) {
      const tabs = await chrome.tabs.query({ url: 'https://github.com/*' });
      if (!tabs.length) return;
    }

    const { lastAuth = {} } = await chrome.storage.local.get('lastAuth');
    for (const t of s.targets) {
      const key = targetKey(t);
      if (!(key in lastAuth)) {
        lastAuth[key] = Date.now();
        await chrome.storage.local.set({ lastAuth });
      }
      const result = await probe(t);
      if (result === 'logged-out') return await setStatus('error', 'signed out of github.com', key);
      const due = s.proactiveMinutes > 0 && Date.now() - lastAuth[key] > s.proactiveMinutes * 60 * 1000;
      if (result === 'expired' || due) return await startRefresh(t, result === 'expired' ? 'expired' : 'proactive');
    }
    await setStatus('ok', `session valid (checked ${new Date().toLocaleTimeString()})`);
  } catch (e) {
    await setStatus('error', `check failed: ${e.message}`);
  } finally {
    polling = false;
  }
}

async function startRefresh(t, reason) {
  const key = targetKey(t);
  const tab = await chrome.tabs.create({ url: ssoUrl(t), active: false });
  await chrome.storage.session.set({ refresh: { tabId: tab.id, key, started: Date.now() } });
  await chrome.alarms.create('refresh-timeout', { when: Date.now() + REFRESH_TIMEOUT_MS });
  await setStatus('refreshing', `re-authenticating ${key} (${reason})`, key);
}

async function finishRefresh(ok, detail) {
  const { refresh } = await chrome.storage.session.get('refresh');
  if (!refresh) return;
  await chrome.storage.session.remove('refresh');
  await chrome.alarms.clear('refresh-timeout');
  chrome.tabs.remove(refresh.tabId).catch(() => {});

  if (ok) {
    const { lastAuth = {} } = await chrome.storage.local.get('lastAuth');
    lastAuth[refresh.key] = Date.now();
    await chrome.storage.local.set({ lastAuth });
    await chrome.storage.session.remove('backoffUntil');
    await setStatus('ok', `re-authenticated ${refresh.key} at ${new Date().toLocaleTimeString()}`, refresh.key);
  } else {
    await chrome.storage.session.set({ backoffUntil: Date.now() + BACKOFF_MS });
    await setStatus('error', detail, refresh.key);
  }
}

async function learnTarget({ kind, slug, returnTo, clicked }) {
  if (!/^(orgs|enterprises)$/.test(kind) || !/^[\w.-]+$/.test(slug)) return;
  const key = targetKey({ kind, slug });

  if (clicked) {
    const { lastAuth = {} } = await chrome.storage.local.get('lastAuth');
    lastAuth[key] = Date.now();
    await chrome.storage.local.set({ lastAuth });
  }

  // return_to is a page GitHub just gated behind SSO, which makes it a reliable probe.
  let probePath;
  if (returnTo) {
    try {
      const u = new URL(returnTo, 'https://github.com');
      if (u.origin === 'https://github.com' && !SSO_PATH.test(u.pathname)) probePath = u.pathname + u.search;
    } catch {}
  }

  const { targets } = await getSettings();
  const existing = targets.find((t) => targetKey(t) === key);
  if (existing) {
    if (existing.probePath || !probePath) return;
    existing.probePath = probePath;
  } else {
    targets.push({ kind, slug, probePath: probePath || defaultProbe({ kind, slug }) });
  }
  await chrome.storage.sync.set({ targets });
}

async function ensureAlarm() {
  const { pollMinutes } = await getSettings();
  const period = Math.max(0.5, Number(pollMinutes) || DEFAULTS.pollMinutes);
  const alarm = await chrome.alarms.get('poll');
  if (!alarm || alarm.periodInMinutes !== period) await chrome.alarms.create('poll', { periodInMinutes: period });
}

// --- listeners (registered at top level so they survive service worker restarts) ---

chrome.runtime.onInstalled.addListener(() => ensureAlarm().then(() => poll()));
chrome.runtime.onStartup.addListener(() => ensureAlarm().then(() => poll()));
ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll') poll();
  if (alarm.name === 'refresh-timeout') {
    finishRefresh(false, 'SSO did not complete within 60s: your IdP may need an interactive sign-in');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return;
  const { refresh } = await chrome.storage.session.get('refresh');
  if (!refresh || refresh.tabId !== tabId) return;
  const u = new URL(tab.url);
  // Still on the SSO page or mid SAML handshake: keep waiting.
  if (u.origin !== 'https://github.com' || SSO_PATH.test(u.pathname) || u.pathname.includes('/saml/')) return;
  await finishRefresh(true);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { refresh } = await chrome.storage.session.get('refresh');
  if (refresh?.tabId !== tabId) return;
  // The user closed the refresh tab themselves.
  await chrome.storage.session.remove('refresh');
  await chrome.alarms.clear('refresh-timeout');
  await setStatus('idle', 'refresh tab was closed', refresh.key);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sso-page') {
    learnTarget(msg);
  } else if (msg?.type === 'poll-now') {
    poll({ force: true }).then(() => sendResponse(true));
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.pollMinutes) ensureAlarm();
  if (changes.enabled || changes.targets) poll();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
