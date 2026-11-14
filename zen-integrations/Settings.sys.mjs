const { accountRecord, disconnectAccount, loadAccounts } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Accounts.sys.mjs' + new URL(import.meta.url).search
);
const {
  beginGoogleSignIn,
  clearGoogleTokens,
  googleClientState,
  googleSignInMessage,
  readGoogleClientSecret
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/calendar/CalendarAuth.sys.mjs' + new URL(import.meta.url).search
);
const { beginOutlookSignIn, clearOutlookTokens, readOutlookClientId } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/OutlookAuth.sys.mjs' + new URL(import.meta.url).search
);
const { outlookClientState } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/OutlookGraph.sys.mjs' + new URL(import.meta.url).search
);
const { getTabUserContextId } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);

const HTML_NS = 'http://www.w3.org/1999/xhtml';

const CREDENTIALS = [
  ['live-calendar.google.clientId', 'Google client id', 'text', '123-abc.apps.googleusercontent.com'],
  ['live-calendar.google.clientSecret', 'Google client secret', 'password', 'GOCSPX-...'],
  ['zen-integrations.outlook.clientId', 'Microsoft app id', 'text', 'Application (client) ID']
];

function readPref(name) {
  try { return Services.prefs.getStringPref(name, ''); } catch (e) { return ''; }
}

function browserWindows() {
  const wins = [];
  try {
    const enumerator = Services.wm.getEnumerator('navigator:browser');
    while (enumerator.hasMoreElements()) wins.push(enumerator.getNext());
  } catch (e) {}
  return wins;
}

function refreshBrowsers(win) {
  const wins = browserWindows();
  if (!wins.length) wins.push(win);
  for (const browserWin of wins) {
    const app = browserWin.zenIntegrations;
    if (!app) continue;
    try { app.panel.hide(); } catch (e) {}
    try { app.calendar?.panel.hide(); } catch (e) {}
    try { app.tabs.refreshAnchors(); } catch (e) {}
    try { app.calendar?.tabs.refreshAnchors(); } catch (e) {}
  }
}

function pinnedTab(win, id) {
  const app = win.zenIntegrations;
  const tabs = win.gBrowser?.tabs || [];
  if (id === 'google') {
    return [...tabs].find((tab) => app?.calendar?.tabs.isCalendarAnchor(tab))
      || [...tabs].find((tab) => app?.tabs.providerFor(tab)?.id === 'gmail')
      || null;
  }
  return [...tabs].find((tab) => app?.tabs.providerFor(tab)?.id === 'outlook') || null;
}

function googleReady() {
  if (googleClientState() !== 'ok') return googleSignInMessage();
  if (!readGoogleClientSecret()) return 'Add your Google client secret in live-calendar.google.clientSecret';
  return '';
}

function outlookReady() {
  const state = outlookClientState(readOutlookClientId());
  if (state === 'ok') return '';
  if (state === 'missing') return 'Add your Microsoft app id in zen-integrations.outlook.clientId';
  if (state === 'foreign') return 'Use your own Microsoft app id. This one belongs to Arc.';
  return 'zen-integrations.outlook.clientId is not a Microsoft app id';
}

async function connectGoogle(win) {
  const blocked = googleReady();
  if (blocked) return blocked;
  const app = win.zenIntegrations;
  const tab = pinnedTab(win, 'google');
  const key = String(getTabUserContextId(tab) || 0);
  await beginGoogleSignIn(app.calendar, tab, key);
  refreshBrowsers(win);
  return accountRecord('google').message || '';
}

async function connectOutlook(win) {
  const blocked = outlookReady();
  if (blocked) return blocked;
  const app = win.zenIntegrations;
  const tab = pinnedTab(win, 'outlook');
  const hints = tab ? app.tabs.getUrlHints(tab) : [];
  const key = tab ? app.tabs.providerFor(tab).contextKey(tab, hints) : 'outlook:live:0';
  await beginOutlookSignIn(app, tab, key);
  refreshBrowsers(win);
  return accountRecord('outlook').message || '';
}

async function disconnect(win, id) {
  if (id === 'google') await clearGoogleTokens();
  else await clearOutlookTokens();
  await disconnectAccount(id);
  refreshBrowsers(win);
}

export async function showAccountSettings(win) {
  await loadAccounts();
  const open = win.document.getElementById('zi-accounts');
  if (open) open.remove();

  const make = (tag, className, parent, text) => {
    const node = win.document.createElementNS(HTML_NS, tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    parent?.append(node);
    return node;
  };

  const overlay = make('div');
  overlay.id = 'zi-accounts';
  overlay.setAttribute('popover', 'manual');
  const card = make('div', 'zi-accounts-card', overlay);
  const head = make('div', 'zi-accounts-head', card);
  make('div', 'zi-accounts-title', head, 'Accounts');
  const close = make('button', 'zi-accounts-close', head, '\u00d7');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  const body = make('div', 'zi-accounts-body', card);
  const status = make('p', 'zi-accounts-status', body, '');
  for (const [name, label, type, placeholder] of CREDENTIALS) {
    const field = make('label', 'zi-accounts-field', body);
    make('span', 'zi-accounts-name', field, label);
    const input = make('input', 'zi-accounts-input', field);
    input.type = type;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = readPref(name);
    input.addEventListener('change', () => {
      Services.prefs.setStringPref(name, input.value.trim());
    });
  }
  const accounts = make('div', 'zi-accounts-list', body);

  const paint = () => {
    accounts.replaceChildren();
    status.textContent = '';
    for (const item of [
      ['google', 'Google', 'Gmail and Calendar'],
      ['outlook', 'Outlook', 'Mail']
    ]) {
      const [id, title, detail] = item;
      const record = accountRecord(id);
      const row = make('div', 'zi-accounts-row', accounts);
      const copy = make('div', 'zi-accounts-copy', row);
      make('div', 'zi-accounts-name', copy, record.email || title);
      let line = detail;
      if (record.enabled && record.expired) line = 'Session expired';
      else if (record.enabled) line = 'Connected';
      make('div', 'zi-accounts-detail', copy, line);
      if (record.message) make('div', 'zi-accounts-detail', copy, record.message);
      const button = make('button', 'zi-accounts-action', row);
      button.type = 'button';
      if (!record.enabled || record.expired) {
        button.textContent = record.expired ? 'Reconnect' : 'Connect';
        button.addEventListener('click', async () => {
          button.disabled = true;
          status.textContent = id === 'google' ? await connectGoogle(win) : await connectOutlook(win);
          paint();
        });
      } else {
        button.textContent = 'Disconnect';
        button.addEventListener('click', async () => {
          button.disabled = true;
          await disconnect(win, id);
          paint();
        });
      }
    }
  };

  close.addEventListener('click', () => overlay.hidePopover());
  overlay.addEventListener('toggle', (event) => {
    if (event.newState === 'closed') overlay.remove();
  });
  paint();
  win.document.documentElement.appendChild(overlay);
  overlay.showPopover();
}
