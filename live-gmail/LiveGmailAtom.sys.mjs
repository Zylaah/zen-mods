const {
  CONFIG,
  debugLog,
  fnv1a,
  getGmailUrlPattern,
  getTabUserContextId,
  gmailAccountSlotFromHints,
  gmailThreadIdFromUrl,
  legacyIdFromAtomId,
  normalizeGmailOpenUrl
} = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailUtil.sys.mjs' + new URL(import.meta.url).search
);

const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
const Cr = Components.results;

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

function cookieSentToGmail(cookie, userContextId, requestPath) {
  const host = String(cookie.host || cookie.rawHost || '').replace(/^\./, '');
  if (host !== 'mail.google.com' && host !== 'google.com') return false;
  const contextId = Number(cookie.originAttributes?.userContextId || 0);
  if (contextId !== userContextId) return false;
  if (!cookie.isSession && cookie.expiry && cookie.expiry * 1000 < Date.now()) return false;
  const path = cookie.path || '/';
  return path === '/' || requestPath.startsWith(path);
}

function gmailCookieHeader(userContextId, feedUrl) {
  const uri = Services.io.newURI('https://mail.google.com/');
  try {
    const service = Cc['@mozilla.org/cookieService;1'].getService(Ci.nsICookieService);
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId });
    const fromPrincipal = service.getCookieStringForPrincipal(principal);
    if (fromPrincipal) return fromPrincipal;
  } catch (e) {}

  let requestPath = '/';
  try { requestPath = new URL(feedUrl).pathname || '/'; } catch (e) {}
  const jar = new Map();
  const add = (cookie) => {
    if (!cookieSentToGmail(cookie, userContextId, requestPath)) return;
    const partitioned = !!cookie.originAttributes?.partitionKey;
    const current = jar.get(cookie.name);
    if (!current || (current.partitioned && !partitioned)) {
      jar.set(cookie.name, { value: cookie.value, partitioned });
    }
  };

  for (const host of ['mail.google.com', 'google.com']) {
    for (const cookie of cookieList(host, { userContextId })) add(cookie);
  }
  if (!jar.size) {
    for (const cookie of allCookies()) add(cookie);
  }
  return [...jar.entries()].map(([name, cookie]) => name + '=' + cookie.value).join('; ');
}

export class LiveGmailAtom {
  constructor(app) {
    this.app = app;
    this.pollTimer = null;
  }

  startPoll() {
    this.stopPoll();
    if (this.app.oauth?.usesOAuth()) return;
    this.pollTimer = this.app.window.setInterval(() => this.pollAnchors(), CONFIG.ATOM_POLL_MS);
    this.pollAnchors();
  }

  stopPoll() {
    if (!this.pollTimer) return;
    try { this.app.window.clearInterval(this.pollTimer); } catch (e) {}
    this.pollTimer = null;
  }

  pollAnchors() {
    for (const tab of this.app.tabs.gmailAnchors()) {
      this.requestScan(tab, { force: true });
    }
  }

  getFeedUrl(tab) {
    const slot = gmailAccountSlotFromHints(this.app.tabs.getUrlHints(tab));
    return `https://${getGmailUrlPattern()}/mail/u/${slot}/feed/atom`;
  }

  parse(xml, feedUrl) {
    const feed = new this.app.window.DOMParser().parseFromString(xml, 'application/xml');
    if (feed.documentElement?.localName !== 'feed' || feed.querySelector('parsererror')) {
      throw new Error('Not an Atom feed');
    }

    const value = (node, name) =>
      (node.getElementsByTagNameNS('*', name)[0]?.textContent || '').trim();

    const items = Array.from(feed.getElementsByTagNameNS('*', 'entry')).map((entry, sourceRank) => {
      const atomId = value(entry, 'id');
      const subject = value(entry, 'title') || '(No subject)';
      const sender = value(entry, 'name') || value(entry, 'email') || 'Unknown';
      const snippet = value(entry, 'summary').slice(0, 200);
      const link = Array.from(entry.getElementsByTagNameNS('*', 'link')).find(
        (node) => !node.getAttribute('rel') || node.getAttribute('rel') === 'alternate'
      );
      let url = '';
      try {
        url = new URL(link?.getAttribute('href') || '', feedUrl).href;
      } catch (e) {}
      url = normalizeGmailOpenUrl(url);
      const gmailThreadId = gmailThreadIdFromUrl(url);
      const legacyThreadId = legacyIdFromAtomId(atomId);
      const date =
        value(entry, 'issued') ||
        value(entry, 'published') ||
        value(entry, 'modified') ||
        value(entry, 'updated');
      const ts = Date.parse(date);
      const id = 'gmail:atom:' + fnv1a(atomId || url + '|' + subject);
      return {
        id,
        threadId: id,
        gmailThreadId,
        legacyThreadId,
        from: sender,
        subject,
        snippet,
        date: Number.isFinite(ts) ? new Date(ts).toISOString() : date,
        ts: Number.isFinite(ts) ? ts : 0,
        isUnread: true,
        url,
        rowIndex: sourceRank
      };
    });

    items.sort((a, b) => (b.ts || 0) - (a.ts || 0) || a.rowIndex - b.rowIndex);
    return items.slice(0, CONFIG.MAX_EMAILS);
  }
  applyEmails(allEmails, targetKey) {
    const app = this.app;
    const viewKey = app.activePanelContextKey;
    const restoreView = targetKey && viewKey && targetKey !== viewKey;
    if (targetKey && restoreView) {
      app.cache.activate(targetKey);
    }

    const clickedIds = app.clickedEmailIds;
    const nextEmails = allEmails.filter((email) => !clickedIds.has(email.id));
    app.currentEmails = nextEmails;
    app.cachedEmails = nextEmails.slice();

    const ctx = app.cache.getOrCreateContext(targetKey);
    ctx.hasScanned = true;
    ctx.lastScanTs = Date.now();
    app.cache.persistActive(targetKey);
    app.cache.save();

    const currentIds = new Set(allEmails.map((email) => email.id));
    for (const clickedId of clickedIds) {
      if (!currentIds.has(clickedId)) clickedIds.delete(clickedId);
    }

    app.scanContextKey = null;
    app.loadScansInFlight.delete(targetKey);

    if (restoreView && viewKey) {
      app.cache.activate(viewKey);
    }

    app.scanInProgress = false;
    if (targetKey === viewKey) {
      app.panel.hideError();
      app.panel.updateDisplay();
    }
  }

  fetchViaCookies(tab, feedUrl) {
    const userContextId = getTabUserContextId(tab);
    const uri = Services.io.newURI(feedUrl);
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId });
    const cookieString = gmailCookieHeader(userContextId, feedUrl);
    debugLog(
      'Atom via cookies',
      feedUrl,
      'container',
      userContextId,
      'cookies',
      cookieString ? cookieString.length : 0
    );

    const channel = NetUtil.newChannel({
      uri,
      loadingPrincipal: principal,
      triggeringPrincipal: principal,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_DOCUMENT,
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_INHERITS_SEC_CONTEXT
    }).QueryInterface(Ci.nsIHttpChannel);
    channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING;
    try {
      channel.setRequestHeader('Accept', 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8', false);
    } catch (e) {}

    let channelId = 0;
    try { channelId = channel.QueryInterface(Ci.nsIIdentChannel).channelId; } catch (e) {}
    const observer = {
      observe(subject) {
        if (!cookieString) return;
        try {
          const http = subject.QueryInterface(Ci.nsIHttpChannel);
          const ident = subject.QueryInterface(Ci.nsIIdentChannel);
          if (channelId && ident.channelId !== channelId) return;
          http.setRequestHeader('Cookie', cookieString, false);
        } catch (e) {}
      }
    };
    Services.obs.addObserver(observer, 'http-on-modify-request');
    const stopObserving = () => {
      try { Services.obs.removeObserver(observer, 'http-on-modify-request'); } catch (e) {}
    };

    return new Promise((resolve, reject) => {
      const timer = this.app.window.setTimeout(() => {
        try { channel.cancel(Cr.NS_ERROR_NET_TIMEOUT); } catch (e) {}
      }, CONFIG.ATOM_TIMEOUT_MS);
      NetUtil.asyncFetch(channel, (input, requestStatus, request) => {
        this.app.window.clearTimeout(timer);
        stopObserving();
        if (!Components.isSuccessCode(requestStatus)) {
          reject(new Error('Network error'));
          return;
        }
        let text = '';
        try {
          const available = input.available();
          if (available > 0) {
            text = NetUtil.readInputStreamToString(input, Math.min(available, CONFIG.ATOM_MAX_BYTES), {
              charset: 'UTF-8'
            });
          }
        } catch (e) {}
        let status = 0;
        let finalUrl = feedUrl;
        try {
          const http = request.QueryInterface(Ci.nsIHttpChannel);
          status = http.responseStatus;
          finalUrl = http.URI?.spec || feedUrl;
        } catch (e) {}
        debugLog('Atom cookies response', status, finalUrl);
        resolve({ status, finalUrl, text, feedUrl });
      });
    });
  }

  onFeedDocument() {}

  async requestScan(tab, options = {}) {
    if (!tab) return;
    if (this.app.oauth?.usesOAuth()) {
      if (!this.app.oauth.isConnected()) return;
      return this.#requestOAuthScan(tab, options);
    }
    return this.#requestAtomScan(tab, options);
  }

  async #requestOAuthScan(tab, { force = false } = {}) {
    const app = this.app;
    const contextKey = app.getPanelContextKey(tab);
    const feedUrl = 'oauth';
    const cached = app.atomMemCache[contextKey];
    if (!force && cached && cached.feedUrl === feedUrl && Date.now() - cached.ts < CONFIG.ATOM_CACHE_MS) {
      if (
        app.activePanelContextKey !== contextKey ||
        (app.currentEmails.length === 0 && app.cachedEmails.length === 0)
      ) {
        this.applyEmails(cached.emails, contextKey);
      }
      return;
    }

    if (app.atomInFlight.has(contextKey)) return;
    app.atomInFlight.add(contextKey);
    app.scanContextKey = contextKey;
    app.loadScansInFlight.add(contextKey);
    if (app.panel.shouldShowLoadProgress(contextKey)) {
      app.scanInProgress = true;
      app.panel.updateDisplay();
    }

    try {
      debugLog('Unread via OAuth');
      const emails = await app.oauth.fetchUnread();
      app.atomMemCache[contextKey] = { ts: Date.now(), feedUrl, emails };
      debugLog('OAuth scan', emails.length, 'unread, context=', contextKey);
      this.applyEmails(emails, contextKey);
    } catch (e) {
      debugLog('OAuth fetch failed', e && e.message ? e.message : e);
      app.scanInProgress = false;
      app.loadScansInFlight.delete(contextKey);
      if (app.scanContextKey === contextKey) app.scanContextKey = null;
      if (
        e?.reauth &&
        app.activePanelContextKey === contextKey &&
        app.currentEmails.length === 0 &&
        app.cachedEmails.length === 0
      ) {
        app.panel.showError('Gmail connection expired');
      }
      app.panel.updateDisplay();
    } finally {
      app.atomInFlight.delete(contextKey);
      app.tabs.finishLoadScan(tab);
    }
  }

  async #requestAtomScan(tab, { force = false } = {}) {
    if (!tab) return;
    const app = this.app;
    const contextKey = app.getPanelContextKey(tab);
    const feedUrl = this.getFeedUrl(tab);
    const cached = app.atomMemCache[contextKey];
    if (
      !force &&
      cached &&
      cached.feedUrl === feedUrl &&
      Date.now() - cached.ts < CONFIG.ATOM_CACHE_MS
    ) {
      if (
        app.activePanelContextKey !== contextKey ||
        (app.currentEmails.length === 0 && app.cachedEmails.length === 0)
      ) {
        this.applyEmails(cached.emails, contextKey);
      }
      return;
    }

    if (app.atomInFlight.has(contextKey)) return;
    app.atomInFlight.add(contextKey);
    app.scanContextKey = contextKey;
    app.loadScansInFlight.add(contextKey);

    if (app.panel.shouldShowLoadProgress(contextKey)) {
      app.scanInProgress = true;
      app.panel.updateDisplay();
    }

    try {
      const fetched = await this.fetchViaCookies(tab, feedUrl);
      const { status, finalUrl, text } = fetched;
      const usedFeedUrl = fetched.feedUrl || feedUrl;
      if (status === 401 || status === 403) {
        const err = new Error('Sign-in required');
        err.signin = true;
        throw err;
      }
      const feedDocument = /<feed[\s>]/.test(text || '');
      const head = (text || '').slice(0, 2000);
      if (
        !feedDocument &&
        (/accounts\.google\.com|ServiceLogin/i.test(finalUrl || '') ||
          /accounts\.google\.com|ServiceLogin/i.test(head))
      ) {
        const err = new Error('Sign-in required');
        err.signin = true;
        throw err;
      }
      if (status < 200 || status >= 300) {
        throw new Error('HTTP ' + status);
      }
      if (
        finalUrl &&
        finalUrl !== usedFeedUrl &&
        !finalUrl.startsWith('https://mail.google.com/mail/')
      ) {
        throw new Error('Feed URL changed');
      }
      if ((text || '').length > 500000) throw new Error('Feed too large');

      const emails = this.parse(text, usedFeedUrl);
      app.atomMemCache[contextKey] = { ts: Date.now(), feedUrl: usedFeedUrl, emails };
      debugLog('Atom scan', emails.length, 'unread, context=', contextKey);
      this.applyEmails(emails, contextKey);
    } catch (e) {
      debugLog('Atom fetch failed', e && e.message ? e.message : e);
      app.scanInProgress = false;
      app.loadScansInFlight.delete(contextKey);
      if (app.scanContextKey === contextKey) app.scanContextKey = null;
      if (
        e?.signin &&
        app.activePanelContextKey === contextKey &&
        app.currentEmails.length === 0 &&
        app.cachedEmails.length === 0
      ) {
        app.panel.showError('Sign in to Gmail to see unread mail');
      }
      app.panel.updateDisplay();
    } finally {
      app.atomInFlight.delete(contextKey);
      app.tabs.finishLoadScan(tab);
    }
  }

  onReadStateChanged(tab) {
    if (!tab || !this.app.tabs.isGmailAnchor(tab)) return;
    const contextKey = this.app.getPanelContextKey(tab);
    const win = this.app.window;
    if (this.app.readStateTimers.has(contextKey)) {
      win.clearTimeout(this.app.readStateTimers.get(contextKey));
    }
    this.app.readStateTimers.set(
      contextKey,
      win.setTimeout(() => {
        this.app.readStateTimers.delete(contextKey);
        this.requestScan(tab, { force: true });
      }, 400)
    );
  }

  scanContext(contextKey = this.app.activePanelContextKey || this.app.getPanelContextKey()) {
    const anchor =
      this.app.tabs.findLoadedAnchor(contextKey) || this.app.tabs.findAnchor(contextKey);
    if (!anchor) return false;
    this.app.tabs.performLoadScan(anchor);
    return true;
  }
}
