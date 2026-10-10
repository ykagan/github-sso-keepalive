const DEFAULTS = { enabled: true, pollMinutes: 1, onlyWhenGithubOpen: true, proactiveMinutes: 0, targets: [] };
const $ = (id) => document.getElementById(id);
let lastAuth = {};
let statusKey;

function addRow(t = { kind: 'orgs', slug: '', probePath: '' }) {
  const tr = document.createElement('tr');

  const kind = document.createElement('select');
  for (const k of ['orgs', 'enterprises']) kind.add(new Option(k, k, false, k === t.kind));

  const slug = Object.assign(document.createElement('input'), { type: 'text', value: t.slug, placeholder: 'my-org' });
  const probe = Object.assign(document.createElement('input'), {
    type: 'text',
    value: t.probePath || '',
    placeholder: '/my-org/some-private-repo',
  });
  const last = lastAuth[`${t.kind}/${t.slug}`];
  const remove = Object.assign(document.createElement('button'), { textContent: 'Remove' });
  remove.onclick = () => tr.remove();

  for (const el of [kind, slug, probe, document.createTextNode(last ? new Date(last).toLocaleString() : '-'), remove]) {
    const td = document.createElement('td');
    td.appendChild(el);
    tr.appendChild(td);
  }
  tr.read = () => ({ kind: kind.value, slug: slug.value.trim(), probePath: probe.value.trim() });
  $('targets').appendChild(tr);
}

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  ({ lastAuth = {} } = await chrome.storage.local.get('lastAuth'));
  $('enabled').checked = s.enabled;
  $('pollMinutes').value = s.pollMinutes;
  $('onlyWhenGithubOpen').checked = s.onlyWhenGithubOpen;
  $('proactiveMinutes').value = s.proactiveMinutes;
  $('targets').replaceChildren();
  s.targets.forEach((t) => addRow(t));
  await renderStatus();
}

async function renderStatus() {
  const { status, backoffUntil } = await chrome.storage.session.get(['status', 'backoffUntil']);
  const box = $('status-box');
  box.className = status?.state || '';
  let text = status ? `${status.detail || status.state} (${new Date(status.at).toLocaleTimeString()})` : 'no check yet';
  if (backoffUntil > Date.now()) text += `; retrying after ${new Date(backoffUntil).toLocaleTimeString()}`;
  $('status').textContent = text;
  statusKey = status?.key;
  $('open-sso').hidden = !(status?.state === 'error' && statusKey);
}

$('add').onclick = () => addRow();

$('save').onclick = async () => {
  const targets = [...$('targets').children]
    .map((tr) => tr.read())
    .filter((t) => /^[\w.-]+$/.test(t.slug))
    .map((t) => ({ ...t, probePath: t.probePath && !t.probePath.startsWith('/') ? '/' + t.probePath : t.probePath }));
  await chrome.storage.sync.set({
    enabled: $('enabled').checked,
    pollMinutes: Math.max(0.5, Number($('pollMinutes').value) || DEFAULTS.pollMinutes),
    onlyWhenGithubOpen: $('onlyWhenGithubOpen').checked,
    proactiveMinutes: Math.max(0, Number($('proactiveMinutes').value) || 0),
    targets,
  });
  $('saved').textContent = 'Saved';
  setTimeout(() => ($('saved').textContent = ''), 1500);
  await load();
};

$('check').onclick = async () => {
  $('status').textContent = 'checking…';
  await chrome.runtime.sendMessage({ type: 'poll-now' });
  await renderStatus();
};

$('open-sso').onclick = () => {
  if (statusKey) chrome.tabs.create({ url: `https://github.com/${statusKey}/sso` });
};

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'session') renderStatus();
});

load();
