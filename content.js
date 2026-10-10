// Runs on every github.com page. When the page is the SAML SSO interstitial
// (/orgs/<org>/sso or /enterprises/<slug>/sso), it presses "Continue", which
// bounces through the IdP (whose session is still valid) and back to return_to.
(() => {
  const SSO_PATH = /^\/(orgs|enterprises)\/([^/]+)\/sso\/?$/;
  const GUARD_KEY = 'ghSsoKeepalive.clicks';
  const MAX_CLICKS = 3; // per tab, within GUARD_WINDOW_MS
  const GUARD_WINDOW_MS = 3 * 60 * 1000;
  const CLICK_DELAY_MS = 300;

  let handledHref = null;

  function findContinueButton() {
    for (const form of document.querySelectorAll('form[action*="/saml/initiate"]')) {
      const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (btn && !btn.disabled) return btn;
    }
    // Fallback in case GitHub changes the form markup: a visible button labelled "Continue".
    return [...document.querySelectorAll('button, input[type="submit"]')].find(
      (b) => /^\s*continue\s*$/i.test(b.textContent || b.value || '') && !b.disabled && b.offsetParent !== null
    );
  }

  function recentClicks() {
    try {
      const now = Date.now();
      return JSON.parse(sessionStorage.getItem(GUARD_KEY) || '[]').filter((t) => now - t < GUARD_WINDOW_MS);
    } catch {
      return [];
    }
  }

  function recordClick() {
    try {
      sessionStorage.setItem(GUARD_KEY, JSON.stringify([...recentClicks(), Date.now()]));
    } catch {}
  }

  function showBanner(text) {
    if (document.getElementById('gh-sso-keepalive-banner')) return;
    const el = document.createElement('div');
    el.id = 'gh-sso-keepalive-banner';
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
      padding: '8px 16px', background: '#fff8c5', color: '#1f2328',
      borderBottom: '1px solid #d4a72c', font: '14px system-ui, sans-serif', textAlign: 'center',
    });
    document.body.appendChild(el);
  }

  async function isEnabled() {
    try {
      const { enabled = true } = await chrome.storage.sync.get('enabled');
      return enabled;
    } catch {
      return true; // extension context gone (e.g. extension reloaded); fall back to default
    }
  }

  function notify(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {}
  }

  async function check() {
    const m = location.pathname.match(SSO_PATH);
    if (!m || handledHref === location.href) return;
    const btn = findContinueButton();
    if (!btn) return; // not rendered yet; the next tick retries
    handledHref = location.href;

    const [, kind, slug] = m;
    const returnTo = new URLSearchParams(location.search).get('return_to');

    if (!(await isEnabled())) {
      notify({ type: 'sso-page', kind, slug, returnTo, clicked: false });
      return;
    }
    if (recentClicks().length >= MAX_CLICKS) {
      notify({ type: 'sso-page', kind, slug, returnTo, clicked: false });
      showBanner('GitHub SSO Keepalive: auto-continue paused (SSO keeps bouncing back here). Press Continue manually.');
      return;
    }

    recordClick();
    notify({ type: 'sso-page', kind, slug, returnTo, clicked: true });
    setTimeout(() => btn.click(), CLICK_DELAY_MS);
  }

  check();
  // GitHub uses Turbo/PJAX soft navigation, so the script may not be re-injected.
  for (const evt of ['turbo:load', 'turbo:render', 'pjax:end', 'popstate']) {
    window.addEventListener(evt, check);
    document.addEventListener(evt, check);
  }
  setInterval(check, 2000);
})();
