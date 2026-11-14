const { accountRecord, disconnectAccount, loadAccounts } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Accounts.sys.mjs' + new URL(import.meta.url).search
);
const {
  beginGoogleSignIn,
  clearGoogleTokens,
  googleClientState,
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

const CREDENTIALS = {
  google: [
    ['live-calendar.google.clientId', 'Client id', 'text', '123-abc.apps.googleusercontent.com'],
    ['live-calendar.google.clientSecret', 'Client secret', 'password', 'GOCSPX-...']
  ],
  outlook: [
    ['zen-integrations.outlook.clientId', 'App id', 'text', 'Application (client) ID']
  ]
};

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
  const state = googleClientState();
  if (state === 'foreign') return 'Use your own Google app id. This one belongs to Arc.';
  if (state === 'invalid') return 'That Google client id is not valid.';
  if (state !== 'ok') return 'Add the Google client id from the … menu.';
  if (!readGoogleClientSecret()) return 'Add the Google client secret from the … menu.';
  return '';
}

function outlookReady() {
  const state = outlookClientState(readOutlookClientId());
  if (state === 'ok') return '';
  if (state === 'foreign') return 'Use your own Microsoft app id. This one belongs to Arc.';
  if (state === 'invalid') return 'That Microsoft app id is not valid.';
  return 'Add the Microsoft app id from the … menu.';
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
  const accounts = make('div', 'zi-accounts-list', body);
  const status = make('p', 'zi-accounts-status', body, '');
  const sheet = make('div', 'zi-accounts-sheet', overlay);
  sheet.hidden = true;

  const closeSheet = () => {
    sheet.hidden = true;
    sheet.replaceChildren();
  };

  const openSheet = (id, title) => {
    sheet.replaceChildren();
    const sheetCard = make('div', 'zi-accounts-sheet-card', sheet);
    const sheetHead = make('div', 'zi-accounts-head', sheetCard);
    const sheetCopy = make('div', 'zi-accounts-copy', sheetHead);
    make('div', 'zi-accounts-title', sheetCopy, title);
    make('div', 'zi-accounts-detail', sheetCopy, 'Saved on this device');
    const sheetClose = make('button', 'zi-accounts-close', sheetHead, '\u00d7');
    sheetClose.type = 'button';
    sheetClose.setAttribute('aria-label', 'Close');
    sheetClose.addEventListener('click', closeSheet);
    const sheetBody = make('div', 'zi-accounts-body', sheetCard);
    for (const [name, label, type, placeholder] of CREDENTIALS[id]) {
      const field = make('label', 'zi-accounts-field', sheetBody);
      make('span', 'zi-accounts-detail', field, label);
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
    sheet.hidden = false;
    sheetCard.querySelector('input')?.focus();
  };

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
      const actions = make('div', 'zi-accounts-actions', row);
      const button = make('button', 'zi-accounts-action', actions);
      button.type = 'button';
      if (!record.enabled || record.expired) {
        button.textContent = record.expired ? 'Reconnect' : 'Connect';
        button.addEventListener('click', async () => {
          button.disabled = true;
          closeSheet();
          status.textContent = id === 'google' ? await connectGoogle(win) : await connectOutlook(win);
          paint();
        });
      } else {
        button.textContent = 'Disconnect';
        button.addEventListener('click', async () => {
          button.disabled = true;
          closeSheet();
          await disconnect(win, id);
          paint();
        });
      }
      const more = make('button', 'zi-accounts-more', actions);
      more.type = 'button';
      more.setAttribute('aria-label', `${title} credentials`);
      more.addEventListener('click', () => openSheet(id, title));
    }
  };

  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (!sheet.hidden) closeSheet();
    else overlay.hidePopover();
  };

  close.addEventListener('click', () => overlay.hidePopover());
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.hidePopover();
  });
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) closeSheet();
  });
  overlay.addEventListener('toggle', (event) => {
    if (event.newState !== 'closed') return;
    win.removeEventListener('keydown', onKey, true);
    overlay.remove();
  });
  win.addEventListener('keydown', onKey, true);
  paint();
  win.document.documentElement.appendChild(overlay);
  overlay.showPopover();
}
