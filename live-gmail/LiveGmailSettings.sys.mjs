const { CONFIG } = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailUtil.sys.mjs' + new URL(import.meta.url).search
);

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const BUTTON_ID = 'live-gmail-oauth';
const MODAL_ID = 'live-gmail-account-modal';
const STYLE_ID = 'live-gmail-account-style';

const ACCOUNT_STYLE = `
#${MODAL_ID} {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 16px;
  background: rgba(0, 0, 0, 0.45);
}
#${MODAL_ID}[hidden] {
  display: none;
}
#${MODAL_ID} .live-gmail-account-card {
  width: 320px;
  max-width: 100%;
  box-sizing: border-box;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.14));
  background: light-dark(#fff, #1c1c1f);
  color: light-dark(#0c0c0d, #f9f9fa);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
#${MODAL_ID} h2 {
  margin: 0 0 6px;
  font-size: 16px;
}
#${MODAL_ID} p {
  margin: 0 0 10px;
  color: light-dark(#5b5b66, #cfcfd8);
  font-size: 12px;
}
#${MODAL_ID} label {
  display: block;
  margin: 8px 0 4px;
  font-size: 11px;
  font-weight: 600;
}
#${MODAL_ID} input {
  box-sizing: border-box;
  width: 100%;
  padding: 7px 8px;
  border-radius: 8px;
  border: 1px solid light-dark(rgba(0, 0, 0, 0.16), rgba(255, 255, 255, 0.16));
  background: light-dark(#fff, #2a2a2e);
  color: inherit;
  font: inherit;
}
#${MODAL_ID} .live-gmail-account-status {
  min-height: 1.2em;
  margin: 8px 0 0;
}
#${MODAL_ID} .live-gmail-account-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
#${MODAL_ID} .live-gmail-account-spacer {
  flex: 1;
}
#${MODAL_ID} button {
  appearance: none;
  border: 0;
  border-radius: 8px;
  padding: 6px 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
#${MODAL_ID} .live-gmail-account-connect {
  background: light-dark(#1a73e8, #8ab4f8);
  color: light-dark(#fff, #1c1c1f);
  font-weight: 600;
}
#${MODAL_ID} button:disabled {
  opacity: 0.5;
  cursor: default;
}
`;

function htmlElement(doc, name, attrs) {
  const node = doc.createElementNS(HTML_NS, name);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  }
  return node;
}

function sourceIsOAuth() {
  try {
    return Services.prefs.getStringPref(CONFIG.SOURCE_PREF, 'atom') === 'oauth';
  } catch (e) {
    return false;
  }
}

function showAccountButton(button) {
  button.style.display = sourceIsOAuth() ? 'flex' : 'none';
}

function ensureAccountStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = htmlElement(doc, 'style', { id: STYLE_ID });
  style.textContent = ACCOUNT_STYLE;
  (doc.head || doc.documentElement).appendChild(style);
}

function gmailFrom(contentWindow, chromeWindow) {
  const chrome = contentWindow.browsingContext?.topChromeWindow || chromeWindow;
  return chrome?.liveGmail || chromeWindow.liveGmail || null;
}

function ensureAccountButton(win) {
  const doc = win.document;
  const content = doc.querySelector('.sineItem[mod-id="live-gmail"] .sineItemPreferenceDialogContent');
  if (!content?.querySelector('#live-gmail-source')) return;
  if (content.querySelector('#' + BUTTON_ID)) return;

  const button = htmlElement(doc, 'button', { id: BUTTON_ID, type: 'button', class: 'settingsBtn' });
  button.dataset.injected = '1';
  button.textContent = 'Google account';
  button.style.margin = '8px 0 0 0';
  showAccountButton(button);
  content.appendChild(button);

  if (win.__liveGmailSourceWatch) return;
  win.__liveGmailSourceWatch = true;
  const observer = {
    observe() {
      const current = doc.getElementById(BUTTON_ID);
      if (current?.dataset.injected) showAccountButton(current);
    }
  };
  Services.prefs.addObserver(CONFIG.SOURCE_PREF, observer);
  win.addEventListener('pagehide', () => {
    try { Services.prefs.removeObserver(CONFIG.SOURCE_PREF, observer); } catch (e) {}
  }, { once: true });
}

function accountModal(doc) {
  let modal = doc.getElementById(MODAL_ID);
  if (modal) return modal;

  ensureAccountStyle(doc);
  const dialog = doc.querySelector('.sineItem[mod-id="live-gmail"] dialog.sineItemPreferenceDialog');
  if (!dialog) return null;

  modal = htmlElement(doc, 'div', { id: MODAL_ID, hidden: '' });
  const card = htmlElement(doc, 'div', { class: 'live-gmail-account-card' });
  const title = htmlElement(doc, 'h2');
  title.textContent = 'Connect Gmail';
  const help = htmlElement(doc, 'p');
  help.textContent = 'Paste the client id and secret from your Google Desktop OAuth client.';
  const idLabel = htmlElement(doc, 'label', { for: 'live-gmail-client-id' });
  idLabel.textContent = 'Client ID';
  const clientId = htmlElement(doc, 'input', {
    id: 'live-gmail-client-id',
    autocomplete: 'off',
    spellcheck: 'false'
  });
  const secretLabel = htmlElement(doc, 'label', { for: 'live-gmail-client-secret' });
  secretLabel.textContent = 'Client secret';
  const clientSecret = htmlElement(doc, 'input', {
    id: 'live-gmail-client-secret',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false'
  });
  const status = htmlElement(doc, 'p', { class: 'live-gmail-account-status', role: 'status' });
  const actions = htmlElement(doc, 'div', { class: 'live-gmail-account-actions' });
  const disconnect = htmlElement(doc, 'button', { type: 'button', id: 'live-gmail-disconnect' });
  disconnect.textContent = 'Disconnect';
  const spacer = htmlElement(doc, 'span', { class: 'live-gmail-account-spacer' });
  const cancel = htmlElement(doc, 'button', { type: 'button', id: 'live-gmail-account-cancel' });
  cancel.textContent = 'Cancel';
  const connect = htmlElement(doc, 'button', {
    type: 'button',
    id: 'live-gmail-connect',
    class: 'live-gmail-account-connect'
  });
  connect.textContent = 'Connect';

  actions.append(disconnect, spacer, cancel, connect);
  card.append(title, help, idLabel, clientId, secretLabel, clientSecret, status, actions);
  modal.appendChild(card);
  dialog.appendChild(modal);

  const close = () => {
    modal.hidden = true;
  };

  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  cancel.addEventListener('click', close);
  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || modal.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }, true);

  connect.addEventListener('click', async () => {
    const app = modal.liveGmail;
    const oauth = app?.oauth;
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
    disconnect.disabled = true;
    status.textContent = 'Opening Google…';
    try {
      await oauth.authorize(id, clientSecret.value.trim());
      if (!modal.hidden) close();
    } catch (error) {
      status.textContent = error?.message || 'Could not connect';
      connect.disabled = false;
      disconnect.disabled = !oauth.isConnected();
    }
  });

  disconnect.addEventListener('click', async () => {
    const app = modal.liveGmail;
    const oauth = app?.oauth;
    if (!oauth) return;
    disconnect.disabled = true;
    await oauth.disconnect();
    app.currentEmails = [];
    app.cachedEmails = [];
    app.atomMemCache = {};
    app.panel.updateDisplay();
    status.textContent = 'Disconnected';
    connect.disabled = false;
  });

  return modal;
}

function openAccountModal(contentWindow, chromeWindow) {
  const doc = contentWindow.document;
  const modal = accountModal(doc);
  if (!modal) return;
  const app = gmailFrom(contentWindow, chromeWindow);
  modal.liveGmail = app;
  const oauth = app?.oauth;
  const clientId = doc.getElementById('live-gmail-client-id');
  const clientSecret = doc.getElementById('live-gmail-client-secret');
  const status = modal.querySelector('.live-gmail-account-status');
  const connect = doc.getElementById('live-gmail-connect');
  const disconnect = doc.getElementById('live-gmail-disconnect');
  clientId.value = oauth?.clientId() || '';
  clientSecret.value = '';
  clientSecret.placeholder = oauth?.clientSecret() ? 'Saved' : '';
  const account = oauth?.status();
  status.textContent = account?.connected
    ? 'Connected' + (account.email ? ' as ' + account.email : '')
    : '';
  connect.disabled = false;
  disconnect.disabled = !account?.connected;
  modal.hidden = false;
  clientId.focus();
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
    const account = event.target.closest?.('#' + BUTTON_ID);
    if (account) {
      event.preventDefault();
      event.stopPropagation();
      openAccountModal(win, chromeWindow);
      return;
    }
    const configure = event.target.closest?.('.sineItemConfigureButton');
    if (configure?.closest('.sineItem')?.getAttribute('mod-id') === 'live-gmail') {
      win.setTimeout(() => ensureAccountButton(win), 0);
    }
  };
  win.addEventListener('click', onClick, true);

  const list = win.document.querySelector('#sineModsList');
  let observer = null;
  if (list) {
    observer = new win.MutationObserver(() => ensureAccountButton(win));
    observer.observe(list, { childList: true, subtree: true });
  }
  win.setTimeout(() => ensureAccountButton(win), 0);

  win.addEventListener('pagehide', () => {
    win.removeEventListener('click', onClick, true);
    observer?.disconnect();
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
