const {
  accountForContainer,
  accountRecord,
  disconnectAccount,
  googleAccountId,
  listAccounts,
  loadAccounts,
  outlookAccountId,
  providerOf,
  removeAccount,
  resolveAccountId,
  setAccountLabel
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Accounts.sys.mjs' + new URL(import.meta.url).search
);
const {
  beginGoogleSignIn,
  dropGoogleToken,
  googleClientState,
  readGoogleClientSecret
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/calendar/CalendarAuth.sys.mjs' + new URL(import.meta.url).search
);
const {
  beginOutlookSignIn,
  dropOutlookToken,
  readOutlookClientId
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/OutlookAuth.sys.mjs' + new URL(import.meta.url).search
);
const { outlookClientState } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/OutlookGraph.sys.mjs' + new URL(import.meta.url).search
);
const {
  getContextContainerId,
  getTabUserContextId,
  isEssentialOrPinnedTab
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

const CREDENTIALS = {
  google: [
    ['live-calendar.google.clientId', 'Client id', 'text', '123-abc.apps.googleusercontent.com'],
    ['live-calendar.google.clientSecret', 'Client secret', 'password', 'GOCSPX-...']
  ],
  outlook: [
    ['zen-integrations.outlook.clientId', 'App id', 'text', 'Application (client) ID']
  ]
};

const PROVIDERS = [
  {
    id: 'google',
    title: 'Google',
    detail: 'Gmail and Calendar',
    credentials: 'google'
  },
  {
    id: 'outlook',
    title: 'Outlook',
    detail: 'Mail',
    credentials: 'outlook'
  }
];

let containerServiceCache;
let activeSettingsCleanup = null;

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

function allApps() {
  const list = [];
  for (const win of browserWindows()) {
    if (win.zenIntegrations) list.push({ win, app: win.zenIntegrations });
  }
  return list;
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

function containerService() {
  if (containerServiceCache !== undefined) return containerServiceCache;
  containerServiceCache = null;
  for (const uri of [
    'resource://gre/modules/ContextualIdentityService.sys.mjs',
    'resource:///modules/ContextualIdentityService.sys.mjs'
  ]) {
    try {
      const module = ChromeUtils.importESModule(uri);
      containerServiceCache = module.ContextualIdentityService || module.default || null;
      if (containerServiceCache) break;
    } catch (e) {}
  }
  if (!containerServiceCache) {
    try { containerServiceCache = globalThis.ContextualIdentityService || null; } catch (e) {}
  }
  return containerServiceCache;
}

function containerName(container) {
  const id = Number(container) || 0;
  try {
    const service = containerService();
    const identity = service?.getPublicIdentityFromId?.(id);
    if (identity?.name) return identity.name;
  } catch (e) {}
  return id ? `Container ${id}` : 'Default container';
}

function keyForTab(app, tab) {
  if (!app || !tab) return '';
  const provider = app.tabs.providerFor(tab);
  if (provider) return provider.contextKey(tab, app.tabs.getUrlHints(tab));
  if (app.calendar?.tabs.isCalendarAnchor(tab)) return 'gmail:' + (getTabUserContextId(tab) || 0);
  return '';
}

function appTabs(app) {
  try { return Array.from(app?.window?.gBrowser?.tabs || []); } catch (e) { return []; }
}

function findTabForAccount(accountId) {
  const wanted = resolveAccountId(accountId) || String(accountId || '');
  for (const { win, app } of allApps()) {
    for (const tab of appTabs(app)) {
      const key = keyForTab(app, tab);
      if (!key) continue;
      const resolved = resolveAccountId(key) || key;
      if (resolved === wanted) return { win, app, tab };
    }
  }
  return null;
}

function findTabInContainer(providerId, container) {
  const wanted = Number(container) || 0;
  for (const { win, app } of allApps()) {
    for (const tab of appTabs(app)) {
      const key = keyForTab(app, tab);
      if (!key || providerOf(key) !== providerId) continue;
      if (getContextContainerId(key) === wanted) return { win, app, tab };
    }
  }
  return null;
}

function addProviderTab(win, providerId, container) {
  const app = win.zenIntegrations;
  const provider = app?.providers.find((item) => item.id === (providerId === 'google' ? 'gmail' : providerId));
  if (!provider || !win.gBrowser?.addTab) return null;
  const args = {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    inBackground: false
  };
  if (container) args.userContextId = container;
  try {
    const tab = win.gBrowser.addTab(provider.homeUrl([]), args);
    win.gBrowser.selectedTab = tab;
    return tab;
  } catch (e) {
    console.warn('[Zen Integrations] Could not create account tab:', e);
    return null;
  }
}

function containerChoices() {
  const choices = new Map();
  choices.set(0, containerName(0));
  try {
    const service = containerService();
    const identities = service?.getPublicIdentities?.() || [];
    for (const identity of identities) {
      const id = Number(identity?.userContextId ?? identity?.id);
      if (!Number.isFinite(id)) continue;
      choices.set(id, identity?.name || containerName(id));
    }
  } catch (e) {}
  for (const { app } of allApps()) {
    for (const tab of appTabs(app)) {
      const id = getTabUserContextId(tab) || 0;
      if (!choices.has(id)) choices.set(id, containerName(id));
    }
  }
  return [...choices.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.id - right.id);
}

function detectedAccounts(providerId) {
  const found = new Map();
  for (const { win, app } of allApps()) {
    for (const tab of appTabs(app)) {
      if (!isEssentialOrPinnedTab(tab)) continue;
      const key = keyForTab(app, tab);
      if (!key || providerOf(key) !== providerId) continue;
      if (resolveAccountId(key)) continue;
      const container = getContextContainerId(key);
      if (!found.has(container)) found.set(container, { id: key, container, win });
    }
  }
  return [...found.values()].sort((left, right) => left.container - right.container);
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

async function connectGoogle(win, accountId) {
  const blocked = googleReady();
  if (blocked) return blocked;
  const container = getContextContainerId(accountId);
  const found = findTabForAccount(accountId) || findTabInContainer('google', container);
  let target = found;
  if (!target) {
    const tab = addProviderTab(win, 'google', container);
    if (!tab) return 'Could not open a Google tab in that container.';
    target = { win, app: win.zenIntegrations, tab };
  }
  const calendar = target.app.calendar;
  if (!calendar) return 'Live Calendar is unavailable.';
  await beginGoogleSignIn(calendar, target.tab, googleAccountId(accountId));
  refreshBrowsers(win);
  return accountRecord(accountId).message || '';
}

async function connectOutlook(win, accountId) {
  const blocked = outlookReady();
  if (blocked) return blocked;
  const container = getContextContainerId(accountId);
  const found = findTabForAccount(accountId) || findTabInContainer('outlook', container);
  let target = found;
  if (!target) {
    const tab = addProviderTab(win, 'outlook', container);
    if (!tab) return 'Could not open an Outlook tab in that container.';
    target = { win, app: win.zenIntegrations, tab };
  }
  const targetKey = keyForTab(target.app, target.tab) || accountId;
  const actualId = resolveAccountId(targetKey) || outlookAccountId(targetKey);
  await beginOutlookSignIn(target.app, target.tab, actualId);
  refreshBrowsers(win);
  return accountRecord(actualId).message || '';
}

async function addAccount(win, providerId, container) {
  if (providerId === 'google') return connectGoogle(win, googleAccountId(container));
  const existing = findTabInContainer('outlook', container);
  const accountId = existing
    ? keyForTab(existing.app, existing.tab)
    : outlookAccountId(container);
  return connectOutlook(win, accountId);
}

async function disconnect(win, accountId) {
  const provider = providerOf(accountId);
  if (provider === 'google') await dropGoogleToken(accountId);
  else if (provider === 'outlook') await dropOutlookToken(accountId);
  await disconnectAccount(accountId);
  refreshBrowsers(win);
}

async function forgetAccount(win, accountId) {
  await disconnect(win, accountId);
  await removeAccount(accountId);
  refreshBrowsers(win);
}

export async function showAccountSettings(win) {
  if (activeSettingsCleanup) {
    try { activeSettingsCleanup(); } catch (e) {}
    activeSettingsCleanup = null;
  }
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

  const moreIcon = (parent) => {
    const svg = win.document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const cx of [3.5, 8, 12.5]) {
      const dot = win.document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', '8');
      dot.setAttribute('r', '1.4');
      dot.setAttribute('fill', 'currentColor');
      svg.append(dot);
    }
    parent.append(svg);
    return svg;
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

  let sheetTrigger = null;

  const closeSheet = () => {
    sheet.hidden = true;
    sheet.replaceChildren();
    if (sheetTrigger?.isConnected) {
      sheetTrigger.setAttribute('aria-expanded', 'false');
      sheetTrigger.focus();
    }
    sheetTrigger = null;
  };

  // Sign-in opens a tab in the same window. Keep the dialog mounted but out of
  // the way so the user can reach the provider page.
  const setAuthMode = (active) => {
    overlay.classList.toggle('zi-accounts-auth', !!active);
  };

  const runAuth = async (providerId, button, work) => {
    const blocked = providerId === 'google' ? googleReady() : outlookReady();
    if (blocked) {
      closeSheet();
      paint(blocked);
      return;
    }
    button.disabled = true;
    closeSheet();
    setAuthMode(true);
    let message = '';
    try {
      message = await work();
    } catch (e) {
      message = e?.message || 'Sign-in failed';
    } finally {
      setAuthMode(false);
    }
    paint(message);
  };

  const openSheet = (title, detail, trigger, build) => {
    sheet.replaceChildren();
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', title);
    sheetTrigger = trigger;
    sheetTrigger.setAttribute('aria-expanded', 'true');
    const sheetCard = make('div', 'zi-accounts-sheet-card', sheet);
    const sheetHead = make('div', 'zi-accounts-head', sheetCard);
    const sheetCopy = make('div', 'zi-accounts-copy', sheetHead);
    make('div', 'zi-accounts-title', sheetCopy, title);
    if (detail) make('div', 'zi-accounts-detail', sheetCopy, detail);
    const sheetClose = make('button', 'zi-accounts-close', sheetHead, '\u00d7');
    sheetClose.type = 'button';
    sheetClose.setAttribute('aria-label', 'Close');
    sheetClose.addEventListener('click', closeSheet);
    const sheetBody = make('div', 'zi-accounts-body', sheetCard);
    build(sheetBody, sheetCard);
    sheet.hidden = false;
    sheetCard.querySelector('input, button.zi-accounts-action')?.focus();
  };

  const openCredentials = (id, title, trigger) => {
    openSheet(`${title} credentials`, 'Used by every account on this device', trigger, (sheetBody) => {
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
    });
  };

  const accountName = (record, provider) => {
    if (record.label) return record.label;
    if (record.email) return record.email;
    return `${provider.title} — ${containerName(getContextContainerId(record.id))}`;
  };

  const accountDetail = (record, provider) => {
    const state = record.expired ? 'Session expired' : record.enabled ? 'Connected' : 'Disconnected';
    return `${state} · ${containerName(getContextContainerId(record.id))}`;
  };

  const accountActions = (row, record, provider) => {
    const actions = make('div', 'zi-accounts-actions', row);
    const needsConnect =
      !record.enabled ||
      record.expired ||
      (provider.id === 'google' && !record.hasToken);
    if (needsConnect) {
      const button = make('button', 'zi-accounts-action', actions);
      button.type = 'button';
      button.textContent = record.expired ? 'Reconnect' : record.enabled ? 'Connect calendar' : 'Connect';
      button.addEventListener('click', () => {
        runAuth(provider.id, button, () => provider.id === 'google'
          ? connectGoogle(win, record.id)
          : connectOutlook(win, record.id));
      });
    }
    if (record.enabled) {
      const button = make('button', 'zi-accounts-action zi-accounts-secondary', actions);
      button.type = 'button';
      button.textContent = 'Disconnect';
      button.addEventListener('click', async () => {
        button.disabled = true;
        closeSheet();
        await disconnect(win, record.id);
        paint();
      });
    }
    const more = make('button', 'zi-accounts-more', actions);
    more.type = 'button';
    more.title = `${accountName(record, provider)} settings`;
    more.setAttribute('aria-label', `${accountName(record, provider)} settings`);
    more.setAttribute('aria-haspopup', 'dialog');
    more.setAttribute('aria-expanded', 'false');
    moreIcon(more);
    more.addEventListener('click', () => openAccount(record, provider, more));
  };

  const openAccount = (record, provider, trigger) => {
    openSheet(accountName(record, provider), `${provider.detail} · ${containerName(getContextContainerId(record.id))}`, trigger, (sheetBody) => {
      const field = make('label', 'zi-accounts-field', sheetBody);
      make('span', 'zi-accounts-detail', field, 'Name');
      const input = make('input', 'zi-accounts-input', field);
      input.type = 'text';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.value = record.label || '';
      input.placeholder = record.email || `${provider.title} — ${containerName(getContextContainerId(record.id))}`;
      input.addEventListener('change', async () => {
        await setAccountLabel(record.id, input.value.trim());
        paint();
      });

      if (record.email) make('div', 'zi-accounts-detail', sheetBody, record.email);
      make('div', 'zi-accounts-detail', sheetBody, accountDetail(record, provider));
      if (record.message) make('div', 'zi-accounts-detail', sheetBody, record.message);

      const remove = make('button', 'zi-accounts-action zi-accounts-danger', sheetBody, 'Remove account');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        const name = accountName(record, provider);
        if (typeof win.confirm === 'function' && !win.confirm(`Remove ${name} from Zen Integrations?`)) return;
        remove.disabled = true;
        closeSheet();
        await forgetAccount(win, record.id);
        paint();
      });
    });
  };

  const openAdd = (provider, trigger) => {
    openSheet(`Add ${provider.title} account`, 'Each Firefox container holds one account.', trigger, (sheetBody) => {
      for (const choice of containerChoices()) {
        const record = accountForContainer(provider.id, choice.id);
        const row = make('div', 'zi-accounts-row', sheetBody);
        const copy = make('div', 'zi-accounts-copy', row);
        make('div', 'zi-accounts-name', copy, choice.name);
        make(
          'div',
          'zi-accounts-detail',
          copy,
          record
            ? `${record.expired ? 'Session expired' : record.enabled ? 'Connected' : 'Disconnected'} · already added`
            : provider.detail
        );
        const actions = make('div', 'zi-accounts-actions', row);
        const button = make('button', 'zi-accounts-action', actions);
        button.type = 'button';
        button.textContent = record ? 'Reconnect' : 'Connect';
        button.addEventListener('click', () => {
          runAuth(provider.id, button, () => addAccount(win, provider.id, choice.id));
        });
      }
    });
  };

  const paint = (notice = '') => {
    accounts.replaceChildren();
    status.textContent = notice;
    for (const provider of PROVIDERS) {
      const records = listAccounts(provider.id).sort((left, right) => {
        const enabled = Number(!!right.enabled) - Number(!!left.enabled);
        if (enabled) return enabled;
        return accountName(left, provider).localeCompare(accountName(right, provider));
      });
      const connected = records.filter((record) => record.enabled).length;
      const detected = detectedAccounts(provider.id);
      const section = make('section', 'zi-accounts-section', accounts);
      const sectionHead = make('div', 'zi-accounts-section-head', section);
      const sectionCopy = make('div', 'zi-accounts-copy', sectionHead);
      make('div', 'zi-accounts-section-title', sectionCopy, `${provider.title} (${connected} connected)`);
      make('div', 'zi-accounts-detail', sectionCopy, provider.detail);
      const sectionActions = make('div', 'zi-accounts-actions', sectionHead);
      const add = make('button', 'zi-accounts-action zi-accounts-add', sectionActions, 'Add account');
      add.type = 'button';
      add.addEventListener('click', () => openAdd(provider, add));
      const more = make('button', 'zi-accounts-more', sectionActions);
      more.type = 'button';
      more.title = `${provider.title} credentials`;
      more.setAttribute('aria-label', `${provider.title} credentials`);
      more.setAttribute('aria-haspopup', 'dialog');
      more.setAttribute('aria-expanded', 'false');
      moreIcon(more);
      more.addEventListener('click', () => openCredentials(provider.credentials, provider.title, more));

      for (const record of records) {
        const row = make('div', 'zi-accounts-row', section);
        const copy = make('div', 'zi-accounts-copy', row);
        make('div', 'zi-accounts-name', copy, accountName(record, provider));
        make('div', 'zi-accounts-detail', copy, accountDetail(record, provider));
        if (record.email && record.email !== accountName(record, provider)) {
          make('div', 'zi-accounts-detail', copy, record.email);
        }
        if (record.message) make('div', 'zi-accounts-detail', copy, record.message);
        accountActions(row, record, provider);
      }

      for (const detected of detected) {
        const row = make('div', 'zi-accounts-row zi-accounts-detected', section);
        const copy = make('div', 'zi-accounts-copy', row);
        make('div', 'zi-accounts-name', copy, `Detected — ${containerName(detected.container)}`);
        make('div', 'zi-accounts-detail', copy, `${provider.detail} · Not connected`);
        const actions = make('div', 'zi-accounts-actions', row);
        const button = make('button', 'zi-accounts-action', actions);
        button.type = 'button';
        button.textContent = 'Connect';
        button.addEventListener('click', () => {
          runAuth(provider.id, button, () => provider.id === 'google'
            ? connectGoogle(win, googleAccountId(detected.container))
            : connectOutlook(win, detected.id));
        });
      }

      if (!records.length && !detected.length) {
        make('div', 'zi-accounts-empty', section, 'No accounts yet. Use Add account.');
      }
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
    // While a provider page is in front, the shell must not close the dialog.
    if (overlay.classList.contains('zi-accounts-auth')) return;
    if (event.target === overlay) overlay.hidePopover();
  });
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) closeSheet();
  });
  const cleanup = () => {
    win.removeEventListener('keydown', onKey, true);
    if (overlay.isConnected) overlay.remove();
    if (activeSettingsCleanup === cleanup) activeSettingsCleanup = null;
  };
  overlay.addEventListener('toggle', (event) => {
    if (event.newState !== 'closed') return;
    cleanup();
  });
  win.addEventListener('keydown', onKey, true);
  activeSettingsCleanup = cleanup;
  paint();
  win.document.documentElement.appendChild(overlay);
  overlay.showPopover();
}
