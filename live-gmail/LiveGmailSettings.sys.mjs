const { CONFIG } = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailUtil.sys.mjs' + new URL(import.meta.url).search
);

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const PREFS_URL = 'chrome://sine/content/live-gmail/preferences.json';

function html(doc, tag, className, parent, text) {
  const el = doc.createElementNS(HTML_NS, tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  parent?.append(el);
  return el;
}

function currentSource() {
  try {
    return Services.prefs.getStringPref(CONFIG.SOURCE_PREF, 'atom') === 'oauth' ? 'oauth' : 'atom';
  } catch (e) {
    return 'atom';
  }
}

async function sourceOptions() {
  try {
    const list = await (await fetch(PREFS_URL)).json();
    const dropdown = list.find((entry) => entry.type === 'dropdown' && entry.property === CONFIG.SOURCE_PREF);
    if (dropdown?.options?.length) return dropdown;
  } catch (e) {}
  return {
    label: 'Unread source',
    options: [
      { value: 'atom', label: 'Atom' },
      { value: 'oauth', label: 'OAuth' }
    ]
  };
}

function showLiveGmailSettings(chromeWindow) {
  const doc = chromeWindow.document;
  const open = doc.getElementById('live-gmail-settings');
  if (open && !open.hasAttribute('closing')) return;
  open?.remove();

  const overlay = html(doc, 'div');
  overlay.id = 'live-gmail-settings';
  overlay.setAttribute('popover', 'manual');
  const scrim = html(doc, 'div', 'lg-set-scrim', overlay);
  const card = html(doc, 'div', 'lg-set-card', scrim);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Live Gmail settings');

  const head = html(doc, 'div', 'lg-set-head', card);
  html(doc, 'div', 'lg-set-title', head, 'Live Gmail');
  const closeButton = html(doc, 'button', 'lg-set-close', head);
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '✕';

  const body = html(doc, 'div', 'lg-set-body', card);
  const row = html(doc, 'div', 'lg-set-row', body);
  const text = html(doc, 'div', 'lg-set-text', row);
  const label = html(doc, 'div', 'lg-set-label', text, 'Unread source');
  html(doc, 'div', 'lg-set-desc', text, 'Atom uses the Gmail tab. OAuth uses a connected account.');
  const select = html(doc, 'select', 'lg-set-select', row);
  select.setAttribute('aria-label', 'Unread source');

  const account = html(doc, 'div', 'lg-set-account', body);
  const connected = html(doc, 'div', 'lg-set-connected', account);
  html(doc, 'div', 'lg-set-kicker', connected, 'Connected');
  const email = html(doc, 'div', 'lg-set-email', connected, 'Google account');
  const disconnect = html(doc, 'button', 'lg-set-disconnect', connected, 'Disconnect');
  disconnect.type = 'button';

  const form = html(doc, 'form', 'lg-set-form', account);
  html(doc, 'p', 'lg-set-hint', form, 'Paste the client id and secret from your Google Desktop OAuth client.');
  html(doc, 'label', null, form, 'Client ID').htmlFor = 'live-gmail-client-id';
  const clientId = html(doc, 'input', 'lg-set-field', form);
  clientId.id = 'live-gmail-client-id';
  clientId.autocomplete = 'off';
  clientId.spellcheck = false;
  html(doc, 'label', null, form, 'Client secret').htmlFor = 'live-gmail-client-secret';
  const clientSecret = html(doc, 'input', 'lg-set-field', form);
  clientSecret.id = 'live-gmail-client-secret';
  clientSecret.type = 'password';
  clientSecret.autocomplete = 'off';
  clientSecret.spellcheck = false;
  const status = html(doc, 'p', 'lg-set-status', form);
  status.setAttribute('role', 'status');
  const connect = html(doc, 'button', 'lg-set-connect', form, 'Connect');
  connect.type = 'submit';

  const gmail = () => chromeWindow.liveGmail;
  const paint = () => {
    const source = currentSource();
    if (doc.activeElement !== select) select.value = source;
    const oauth = gmail()?.oauth;
    const isConnected = !!oauth?.isConnected();
    account.hidden = source !== 'oauth';
    connected.hidden = !isConnected;
    form.hidden = isConnected;
    if (!isConnected) return;
    email.textContent = oauth.status().email || 'Google account';
  };

  sourceOptions().then((dropdown) => {
    label.textContent = dropdown.label || 'Unread source';
    for (const option of dropdown.options) {
      const item = html(doc, 'option', null, select, option.label);
      item.value = String(option.value);
    }
    paint();
    if (!clientId.value) clientId.value = gmail()?.oauth?.clientId() || '';
    clientSecret.placeholder = gmail()?.oauth?.clientSecret() ? 'Saved' : '';
  });

  select.addEventListener('change', () => {
    const value = select.value === 'oauth' ? 'oauth' : 'atom';
    Services.prefs.setStringPref(CONFIG.SOURCE_PREF, value);
    status.textContent = '';
    paint();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const oauth = gmail()?.oauth;
    if (!oauth) {
      status.textContent = 'Live Gmail is not running in this window';
      return;
    }
    const id = clientId.value.trim();
    if (!id) {
      status.textContent = 'Enter the client ID';
      clientId.focus();
      return;
    }
    connect.disabled = true;
    status.textContent = 'Opening Google…';
    try {
      await oauth.authorize(id, clientSecret.value.trim());
      clientSecret.value = '';
      status.textContent = '';
      paint();
    } catch (error) {
      status.textContent = error?.message || 'Could not connect';
    } finally {
      connect.disabled = false;
    }
  });

  disconnect.addEventListener('click', async () => {
    const app = gmail();
    if (!app?.oauth) return;
    disconnect.disabled = true;
    await app.oauth.disconnect();
    app.currentEmails = [];
    app.cachedEmails = [];
    app.atomMemCache = {};
    app.panel.updateDisplay();
    status.textContent = '';
    clientSecret.placeholder = app.oauth.clientSecret() ? 'Saved' : '';
    disconnect.disabled = false;
    paint();
  });

  const onPref = { observe: paint };
  Services.prefs.addObserver(CONFIG.SOURCE_PREF, onPref);

  const close = () => {
    if (overlay.hasAttribute('closing')) return;
    overlay.setAttribute('closing', '');
    chromeWindow.removeEventListener('keydown', onKey, true);
    try { Services.prefs.removeObserver(CONFIG.SOURCE_PREF, onPref); } catch (e) {}
    chromeWindow.setTimeout(() => {
      try { overlay.hidePopover?.(); } catch (e) {}
      overlay.remove();
    }, 220);
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  closeButton.addEventListener('click', close);
  scrim.addEventListener('mousedown', (event) => {
    if (event.target === scrim) close();
  });
  chromeWindow.addEventListener('keydown', onKey, true);
  chromeWindow.addEventListener('unload', close, { once: true });

  doc.documentElement.appendChild(overlay);
  try { overlay.showPopover(); } catch (e) {}
  chromeWindow.requestAnimationFrame(() => overlay.setAttribute('shown', ''));
  select.focus();
}

function hookPreferences(win, chromeWindow) {
  if (!win || win.__liveGmailSettings) return;
  let href = '';
  try {
    href = String(win.location?.href || '');
  } catch (e) {
    return;
  }
  if (!/^about:(preferences|settings)/.test(href)) return;

  win.__liveGmailSettings = true;
  const onClick = (event) => {
    const button = event.target.closest?.('.sineItemConfigureButton');
    if (button?.closest('.sineItem')?.getAttribute('mod-id') !== 'live-gmail') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showLiveGmailSettings(chromeWindow);
  };
  win.addEventListener('click', onClick, true);
  win.addEventListener('pagehide', () => {
    win.removeEventListener('click', onClick, true);
    delete win.__liveGmailSettings;
  }, { once: true });
}

export function attachLiveGmailSettings(chromeWindow) {
  const progressListener = {
    onLocationChange(browser, webProgress) {
      if (!webProgress?.isTopLevel) return;
      try { hookPreferences(browser.contentWindow, chromeWindow); } catch (e) {}
    },
    onStateChange(browser, webProgress, _request, flags) {
      if (!webProgress?.isTopLevel || !(flags & Ci.nsIWebProgressListener.STATE_STOP)) return;
      try { hookPreferences(browser.contentWindow, chromeWindow); } catch (e) {}
    }
  };

  chromeWindow.gBrowser.addTabsProgressListener(progressListener);
  for (const browser of chromeWindow.gBrowser.browsers) {
    try { hookPreferences(browser.contentWindow, chromeWindow); } catch (e) {}
  }

  return () => {
    try { chromeWindow.gBrowser.removeTabsProgressListener(progressListener); } catch (e) {}
  };
}
