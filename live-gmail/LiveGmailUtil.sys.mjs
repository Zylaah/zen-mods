export const CONFIG = {
  GMAIL_URL_PREF: 'live-gmail.url',
  DEBUG_PREF: 'live-gmail.debug',
  DEFAULT_GMAIL_URL: 'mail.google.com',
  MAX_EMAILS: 20,
  PANEL_ID: 'live-gmail-panel',
  SCANNER_TAB_ATTR: 'data-live-gmail-scanner',
  HOVER_DELAY_MS: 200,
  ATOM_CACHE_MS: 60000,
  ATOM_TIMEOUT_MS: 8000,
  ATOM_MAX_BYTES: 500000,
  OAUTH_CLIENT_ID_PREF: 'live-gmail.oauth.client-id',
  OAUTH_CLIENT_SECRET_PREF: 'live-gmail.oauth.client-secret',
  OAUTH_POLL_MS: 60000,
  OAUTH_FILE: 'live-gmail-oauth.json'
};

export const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';

export function isDebugEnabled() {
  try {
    return Services.prefs.getBoolPref(CONFIG.DEBUG_PREF, false);
  } catch (e) {
    return false;
  }
}

export function debugLog(...args) {
  if (isDebugEnabled()) {
    console.log('[Live Gmail]', ...args);
  }
}

export function getGmailUrlPattern() {
  try {
    return Services.prefs.getStringPref(CONFIG.GMAIL_URL_PREF, CONFIG.DEFAULT_GMAIL_URL);
  } catch (e) {}
  return CONFIG.DEFAULT_GMAIL_URL;
}

export function getTabUserContextId(tab) {
  if (!tab) return 0;
  if (typeof tab.userContextId === 'number' && !Number.isNaN(tab.userContextId)) {
    return tab.userContextId;
  }
  return parseInt(tab.getAttribute('usercontextid') || '0', 10) || 0;
}

export function getContextContainerId(contextKey) {
  const key = String(contextKey || '0');
  if (key.includes(':')) {
    return parseInt(key.split(':').pop() || '0', 10) || 0;
  }
  return parseInt(key, 10) || 0;
}

export function tabMatchesContainerContext(tab, contextKey) {
  if (!tab) return false;
  return getTabUserContextId(tab) === getContextContainerId(contextKey);
}

export function isEssentialOrPinnedTab(tab) {
  return !!(tab && (tab.hasAttribute('zen-essential') || tab.pinned));
}

export function isPinnedGmailTab(tab) {
  return !!(tab?.pinned && !tab.hasAttribute('zen-essential'));
}

export function getGmailInboxUrl() {
  return `https://${getGmailUrlPattern()}/mail/u/0/#inbox`;
}

export function getGmailComposeUrl() {
  return `https://${getGmailUrlPattern()}/mail/u/0/#inbox?compose=new`;
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + (h >>> 0).toString(36)).slice(-8);
}

export function gmailAccountSlotFromHints(hints) {
  for (const hint of hints || []) {
    const match = String(hint).match(/\/mail\/u\/(\d+)/);
    if (match) return match[1];
  }
  return '0';
}

export function normalizeGmailOpenUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.hostname.toLowerCase() !== 'mail.google.com') return '';
    if (/\/feed\/atom/i.test(parsed.pathname)) {
      const slot = parsed.pathname.match(/\/u\/(\d+)/)?.[1] || '0';
      return `https://mail.google.com/mail/u/${slot}/#inbox`;
    }
    return parsed.href;
  } catch (e) {
    return '';
  }
}

export function escapeHtml(doc, text) {
  const div = doc.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
