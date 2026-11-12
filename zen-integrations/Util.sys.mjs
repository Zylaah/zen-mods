export const PROVIDER_IDS = ['gmail', 'outlook'];

export const CONFIG = {
  GMAIL_URL_PREF: 'zen-integrations.gmail.url',
  LEGACY_GMAIL_URL_PREF: 'live-gmail.url',
  DEBUG_PREF: 'zen-integrations.debug',
  LEGACY_DEBUG_PREF: 'live-gmail.debug',
  OUTLOOK_CLIENT_PREF: 'zen-integrations.outlook.clientId',
  OUTLOOK_TOKEN_FILE: 'zen-integrations-outlook-tokens.json',
  DEFAULT_GMAIL_URL: 'mail.google.com',
  MAX_EMAILS: 20,
  PANEL_ID: 'zi-panel',
  SCANNER_TAB_ATTR: 'data-zi-scanner',
  LEGACY_SCANNER_TAB_ATTR: 'data-live-gmail-scanner',
  HOVER_DELAY_MS: 200,
  CACHE_MS: 60000,
  REQUEST_TIMEOUT_MS: 8000,
  MAX_BYTES: 500000,
  POLL_MS: 60000,
  CACHE_FILE: 'zen-integrations-cache.json',
  LEGACY_CACHE_FILE: 'live-gmail-cache.json'
};

export const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';

const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
const Cr = Components.results;

function prefHas(name) {
  try {
    return Services.prefs.prefHasUserValue(name);
  } catch (e) {
    return false;
  }
}

export function isDebugEnabled() {
  try {
    if (prefHas(CONFIG.DEBUG_PREF)) return Services.prefs.getBoolPref(CONFIG.DEBUG_PREF);
    if (prefHas(CONFIG.LEGACY_DEBUG_PREF)) return Services.prefs.getBoolPref(CONFIG.LEGACY_DEBUG_PREF);
    return Services.prefs.getBoolPref(CONFIG.DEBUG_PREF, false);
  } catch (e) {
    return false;
  }
}

export function debugLog(...args) {
  if (isDebugEnabled()) console.log('[Zen Integrations]', ...args);
}

export function getGmailUrlPattern() {
  try {
    if (prefHas(CONFIG.GMAIL_URL_PREF)) {
      return Services.prefs.getStringPref(CONFIG.GMAIL_URL_PREF, CONFIG.DEFAULT_GMAIL_URL);
    }
    if (prefHas(CONFIG.LEGACY_GMAIL_URL_PREF)) {
      return Services.prefs.getStringPref(CONFIG.LEGACY_GMAIL_URL_PREF, CONFIG.DEFAULT_GMAIL_URL);
    }
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

export function getTabOriginAttributes(tab) {
  const browser = tab?.linkedBrowser;
  const sources = [];
  try {
    if (browser?.contentPrincipal?.originAttributes) sources.push(browser.contentPrincipal.originAttributes);
  } catch (e) {}
  try {
    const attrs = browser?.browsingContext?.currentWindowGlobal?.documentPrincipal?.originAttributes;
    if (attrs) sources.push(attrs);
  } catch (e) {}
  try {
    const attrs = browser?.browsingContext?.originAttributes;
    if (attrs) sources.push(attrs);
  } catch (e) {}
  const picked = sources.find((attrs) => attrs?.partitionKey) || sources[0] || {};
  const copy = { userContextId: getTabUserContextId(tab) };
  for (const key of ['privateBrowsingId', 'firstPartyDomain', 'partitionKey']) {
    if (picked[key] == null || picked[key] === '') continue;
    copy[key] = picked[key];
  }
  return copy;
}

export function getContextContainerId(contextKey) {
  const key = String(contextKey || '0');
  const parts = key.split(':');
  return parseInt(parts[parts.length - 1] || '0', 10) || 0;
}

export function scopedCacheKey(key) {
  const text = String(key);
  if (PROVIDER_IDS.some((id) => text === id || text.startsWith(id + ':'))) return text;
  return 'gmail:' + getContextContainerId(text);
}

export function isEssentialOrPinnedTab(tab) {
  return !!(tab && (tab.hasAttribute('zen-essential') || tab.pinned));
}

export function isPinnedStripTab(tab) {
  return !!(tab?.pinned && !tab.hasAttribute('zen-essential'));
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

export function escapeHtml(doc, text) {
  const div = doc.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function profilePath(name) {
  const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
  return PathUtils.join(profileDir, name);
}

function asArray(result) {
  if (!result) return [];
  try {
    if (typeof result.length === 'number' || typeof result[Symbol.iterator] === 'function') {
      return Array.from(result);
    }
  } catch (e) {}
  return [];
}

function cookieList(host, originAttributes) {
  try {
    return asArray(Services.cookies.getCookiesFromHost(host, originAttributes));
  } catch (e) {}
  try {
    return asArray(Services.cookies.getCookiesFromHost(host, originAttributes, false));
  } catch (e) {}
  return [];
}

function allCookies() {
  try {
    const cookies = Services.cookies.cookies;
    if (cookies && typeof cookies.length === 'number') return Array.from(cookies);
  } catch (e) {}
  const list = [];
  try {
    const enumerator = Services.cookies.enumerator;
    while (enumerator?.hasMoreElements()) {
      list.push(enumerator.getNext().QueryInterface(Ci.nsICookie));
    }
  } catch (e) {}
  return list;
}

function hostAllowed(cookieHost, allowedHosts) {
  const host = String(cookieHost || '').replace(/^\./, '').toLowerCase();
  if (!host) return false;
  return allowedHosts.some((allowed) => {
    const name = String(allowed || '').toLowerCase();
    return host === name || host.endsWith('.' + name) || name.endsWith('.' + host);
  });
}

function cookieSent(cookie, userContextId, requestPath, allowedHosts) {
  if (!hostAllowed(cookie.host || cookie.rawHost, allowedHosts)) return false;
  const contextId = Number(cookie.originAttributes?.userContextId || 0);
  if (contextId !== userContextId) return false;
  if (!cookie.isSession && cookie.expiry && cookie.expiry * 1000 < Date.now()) return false;
  const path = cookie.path || '/';
  return path === '/' || requestPath.startsWith(path);
}

export function hostCookies(userContextId, allowedHosts) {
  const seen = new Set();
  const list = [];
  const add = (cookie) => {
    if (!cookie || !hostAllowed(cookie.host || cookie.rawHost, allowedHosts)) return;
    const contextId = Number(cookie.originAttributes?.userContextId || 0);
    if (contextId !== userContextId) return;
    if (!cookie.isSession && cookie.expiry && cookie.expiry * 1000 < Date.now()) return;
    const key = cookie.name + '\n' + (cookie.path || '/') + '\n' + (cookie.originAttributes?.partitionKey || '');
    if (seen.has(key)) return;
    seen.add(key);
    list.push(cookie);
  };
  for (const host of allowedHosts) {
    for (const cookie of cookieList(host, { userContextId })) add(cookie);
  }
  for (const cookie of allCookies()) add(cookie);
  return list;
}

export function cookieJar(userContextId, pageUrl, allowedHosts, partitionKey = '') {
  let requestPath = '/';
  try { requestPath = new URL(pageUrl).pathname || '/'; } catch (e) {}
  const jar = new Map();
  const add = (cookie) => {
    if (!cookieSent(cookie, userContextId, requestPath, allowedHosts)) return;
    const partition = String(cookie.originAttributes?.partitionKey || '');
    if (partitionKey && partition && partition !== partitionKey) return;
    const next = { value: cookie.value, partition };
    const current = jar.get(cookie.name);
    if (!current) {
      jar.set(cookie.name, next);
      return;
    }
    if (partitionKey && partition === partitionKey && current.partition !== partitionKey) {
      jar.set(cookie.name, next);
    } else if (!partitionKey && current.partition && !partition) {
      jar.set(cookie.name, next);
    }
  };
  for (const host of allowedHosts) {
    for (const cookie of cookieList(host, { userContextId })) add(cookie);
  }
  if (!jar.size) {
    for (const cookie of allCookies()) add(cookie);
  }
  return jar;
}

export function cookieHeaderFromJar(jar) {
  return [...jar.entries()].map(([name, cookie]) => name + '=' + cookie.value).join('; ');
}

function cookieHeaderForPrincipal(uri, attrs) {
  try {
    const service = Cc['@mozilla.org/cookieService;1'].getService(Ci.nsICookieService);
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, attrs);
    return service.getCookieStringForPrincipal(principal) || '';
  } catch (e) {
    return '';
  }
}

function hasSessionCookie(header) {
  return /(?:^|;\s*)(?:SID|SAPISID|__Secure-1PSID|__Secure-3PSID)=/.test(header || '');
}

function cookieHeaderFor(uri, originAttributes, userContextId) {
  const base = { userContextId: originAttributes?.userContextId ?? userContextId ?? 0 };
  if (originAttributes?.privateBrowsingId) base.privateBrowsingId = originAttributes.privateBrowsingId;
  if (originAttributes?.firstPartyDomain) base.firstPartyDomain = originAttributes.firstPartyDomain;
  const plain = cookieHeaderForPrincipal(uri, base);
  if (!originAttributes?.partitionKey) return plain;
  let partitioned = '';
  try {
    partitioned = cookieHeaderForPrincipal(uri, { ...base, partitionKey: originAttributes.partitionKey });
  } catch (e) {}
  if (hasSessionCookie(partitioned) && !hasSessionCookie(plain)) return partitioned;
  if (hasSessionCookie(plain) && !hasSessionCookie(partitioned)) return plain;
  return (partitioned || '').length > (plain || '').length ? partitioned : plain;
}

function principalFor(uri, originAttributes, userContextId) {
  const attrs = originAttributes || { userContextId: userContextId || 0 };
  try {
    return Services.scriptSecurityManager.createContentPrincipal(uri, attrs);
  } catch (e) {
    return Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId: attrs.userContextId || 0 });
  }
}

export function httpRequest(win, { url, userContextId, method = 'GET', headers = {}, body = '', cookieHosts, cookieHeader, timeoutMs, maxBytes, contentType, anonymous = false, originAttributes = null, readOnlyCookies = false }) {
  const uri = Services.io.newURI(url);
  const principal = principalFor(uri, originAttributes, userContextId);
  const partitionKey = originAttributes?.partitionKey || '';
  // Anonymous calls (Microsoft token and Graph) have no cookie host list.
  // cookieJar iterates that list, so skip it instead of throwing.
  const jar = anonymous ? new Map() : cookieJar(userContextId, url, cookieHosts, partitionKey);
  const fromPrincipal = anonymous || cookieHeader != null ? '' : cookieHeaderFor(uri, originAttributes, userContextId);
  const fromJar = anonymous ? '' : cookieHeaderFromJar(jar);
  const cookieString = anonymous
    ? ''
    : (cookieHeader != null
      ? cookieHeader
      : (hasSessionCookie(fromPrincipal) ? fromPrincipal : (hasSessionCookie(fromJar) ? fromJar : (fromPrincipal || fromJar))));
  const channel = NetUtil.newChannel({
    uri,
    loadingPrincipal: principal,
    triggeringPrincipal: principal,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST,
    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_INHERITS_SEC_CONTEXT
  }).QueryInterface(Ci.nsIHttpChannel);

  if (body) {
    const stream = Cc['@mozilla.org/io/string-input-stream;1'].createInstance(Ci.nsIStringInputStream);
    // setData was removed. setUTF8Data is the replacement on current Firefox.
    if (typeof stream.setUTF8Data === 'function') stream.setUTF8Data(body);
    else stream.setByteStringData(body);
    channel.QueryInterface(Ci.nsIUploadChannel);
    channel.setUploadStream(stream, contentType || 'application/json; charset=utf-8', -1);
  }
  // setUploadStream forces PUT. Set the real method after it.
  channel.requestMethod = method;
  channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING;
  // A Gmail preview must not store Set-Cookie. That write was landing in the
  // other container and signing it out. LOAD_ANONYMOUS drops storage; the
  // observer still attaches the container's existing Cookie header.
  // Microsoft token and Graph calls stay anonymous so they never touch Outlook.
  if (anonymous || readOnlyCookies) channel.loadFlags |= Ci.nsIRequest.LOAD_ANONYMOUS;
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || value === '') continue;
    try { channel.setRequestHeader(name, String(value), false); } catch (e) {}
  }

  let channelId = 0;
  try { channelId = channel.QueryInterface(Ci.nsIIdentChannel).channelId; } catch (e) {}
  const observer = {
    observe(subject) {
      // A missing channel id used to match every request and replace its
      // Cookie header. That signed Outlook out. Never touch another channel.
      if (!channelId) return;
      try {
        const http = subject.QueryInterface(Ci.nsIHttpChannel);
        const ident = subject.QueryInterface(Ci.nsIIdentChannel);
        if (ident.channelId !== channelId) return;
        if (readOnlyCookies && cookieString && cookieHosts) {
          let host = '';
          try { host = http.URI?.host || ''; } catch (e) { host = ''; }
          if (host && hostAllowed(host, cookieHosts)) {
            http.setRequestHeader('Cookie', cookieString, false);
          }
        }
        if (anonymous || readOnlyCookies) {
          if (headers.Authorization) http.setRequestHeader('Authorization', headers.Authorization, false);
          // Necko adds Origin after our headers. A native public client token
          // POST that still carries Origin is rejected as AADSTS90023.
          const spec = http.URI?.spec || '';
          if (spec.includes('/oauth2/') && spec.includes('/token')) {
            http.setRequestHeader('Origin', '', false);
            http.setRequestHeader('Referer', '', false);
          }
          return;
        }
        if (!cookieString || !cookieHosts) return;
        let host = '';
        try { host = http.URI?.host || ''; } catch (e) { return; }
        if (!hostAllowed(host, cookieHosts)) return;
        http.setRequestHeader('Cookie', cookieString, false);
      } catch (e) {}
    }
  };
  Services.obs.addObserver(observer, 'http-on-modify-request');
  try { Services.obs.addObserver(observer, 'http-on-before-connect'); } catch (e) {}
  const stopObserving = () => {
    try { Services.obs.removeObserver(observer, 'http-on-modify-request'); } catch (e) {}
    try { Services.obs.removeObserver(observer, 'http-on-before-connect'); } catch (e) {}
  };

  return new Promise((resolve, reject) => {
    const timer = win.setTimeout(() => {
      try { channel.cancel(Cr.NS_ERROR_NET_TIMEOUT); } catch (e) {}
    }, timeoutMs || CONFIG.REQUEST_TIMEOUT_MS);
    NetUtil.asyncFetch(channel, (input, requestStatus, request) => {
      win.clearTimeout(timer);
      stopObserving();
      if (!Components.isSuccessCode(requestStatus)) {
        reject(new Error('Network error'));
        return;
      }
      let text = '';
      try {
        const available = input.available();
        if (available > 0) {
          text = NetUtil.readInputStreamToString(input, Math.min(available, maxBytes || CONFIG.MAX_BYTES), {
            charset: 'UTF-8'
          });
        }
      } catch (e) {}
      let status = 0;
      let finalUrl = url;
      const responseHeaders = {};
      try {
        const http = request.QueryInterface(Ci.nsIHttpChannel);
        status = http.responseStatus;
        finalUrl = http.URI?.spec || url;
        http.visitResponseHeaders({
          visitHeader(name, value) {
            const key = String(name || '').toLowerCase();
            if (key !== 'x-owa-canary' && key !== 'set-cookie') return;
            responseHeaders[key] = responseHeaders[key] ? responseHeaders[key] + '\n' + value : value;
          }
        });
      } catch (e) {}
      resolve({ status, finalUrl, text, jar, cookieString, responseHeaders });
    });
  });
}
