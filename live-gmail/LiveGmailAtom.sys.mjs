const {
  CONFIG,
  debugLog,
  fnv1a,
  getGmailUrlPattern,
  gmailAccountSlotFromHints,
  normalizeGmailOpenUrl
} = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailUtil.sys.mjs' + new URL(import.meta.url).search
);

export class LiveGmailAtom {
  constructor(app) {
    this.app = app;
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

  async fetchViaTab(tab) {
    const browser = tab?.linkedBrowser;
    const windowGlobal = browser?.browsingContext?.currentWindowGlobal;
    if (!windowGlobal) {
      debugLog('Tab Atom unavailable: no current window global');
      return null;
    }
    let actor;
    try {
      actor = windowGlobal.getActor('LiveGmail');
    } catch (e) {
      debugLog('Tab Atom unavailable: actor lookup failed', e?.message || e);
      return null;
    }
    if (!actor?.sendQuery) {
      debugLog('Tab Atom unavailable: actor has no query channel');
      return null;
    }
    return actor.sendQuery('LiveGmail:FetchAtom', {});
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
      debugLog('Atom via tab');
      const fetched = await this.fetchViaTab(tab);
      if (!fetched) {
        debugLog('Atom via tab unavailable: Gmail page is not loaded');
        app.scanInProgress = false;
        app.loadScansInFlight.delete(contextKey);
        if (app.scanContextKey === contextKey) app.scanContextKey = null;
        app.panel.updateDisplay();
        return;
      }
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
