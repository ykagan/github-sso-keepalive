# GitHub SSO Keepalive

A Chrome (MV3) extension that keeps your GitHub org/enterprise SAML SSO session alive when the IdP issues
very short sessions. It never enters credentials. It only presses GitHub's SSO **Continue** button, which
bounces through your IdP (whose own session is still valid) and back.

## What it does

1. **In-tab auto-continue** (`content.js`): whenever a tab lands on `github.com/orgs/<org>/sso` or
   `github.com/enterprises/<slug>/sso`, it clicks **Continue**. GitHub's `return_to` sends you back to the
   page you were on. If the page keeps bouncing back (3 times in 3 minutes), it stops and shows a banner.
2. **Background monitor** (`background.js`): every minute it fetches an SSO-protected page with your cookies.
   If GitHub answers with the SSO interstitial, it opens the SSO page in an **inactive** background tab,
   lets step 1 press Continue, waits for the redirect back to github.com, and closes the tab. If that doesn't
   finish within 60s (for example the IdP actually wants a password), it closes the tab, shows a red `!` badge,
   and waits 10 minutes before trying again.
3. **Optional proactive mode**: set "re-authenticate proactively every N minutes" (such as 12 for a 15-minute
   timeout) to refresh before expiry, so your own tabs never hit the SSO page.

The org/enterprise is learned automatically the first time you hit its SSO page, and the page you were trying
to reach becomes the probe URL. You can also add or edit entries on the options page (click the toolbar icon).

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `github-sso-keepalive` folder.
3. Pin the icon if you want to see the status badge: blank means OK, `…` means refreshing, `!` means an error.
   Click it to open the options and status page.

## Notes

- Only `github.com` host permissions are requested. The extension never touches your IdP's pages.
- Proactive mode only helps if GitHub shows the Continue page while a session is still valid. If GitHub
  instead redirects straight back, the background tab just closes. Expiry detection plus in-tab
  auto-continue still covers you.
