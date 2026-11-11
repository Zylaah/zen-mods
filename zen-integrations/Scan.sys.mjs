const { CONFIG, debugLog } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);

export class ZenScan {
  constructor(app) {
    this.app = app;
    this.pollTimer = null;
  }

  startPoll() {
    this.stopPoll();
    this.pollTimer = this.app.window.setInterval(() => this.pollAnchors(), CONFIG.POLL_MS);
    this.pollAnchors();
  }

  stopPoll() {
    if (!this.pollTimer) return;
    try { this.app.window.clearInterval(this.pollTimer); } catch (e) {}
    this.pollTimer = null;
  }

  pollAnchors() {
    for (const tab of this.app.tabs.anchors()) {
      this.requestScan(tab, { force: true });
    }
  }

  applyEmails(allEmails, targetKey) {
    const app = this.app;
    const viewKey = app.activePanelContextKey;
    const restoreView = targetKey && viewKey && targetKey !== viewKey;
    if (targetKey && restoreView) app.cache.activate(targetKey);

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

    if (restoreView && viewKey) app.cache.activate(viewKey);

    app.scanInProgress = false;
    if (targetKey === viewKey) {
      app.panel.hideError();
      app.panel.updateDisplay();
    }
  }

  async requestScan(tab, { force = false } = {}) {
    if (!tab) return;
    const app = this.app;
    const provider = app.tabs.providerFor(tab);
    if (!provider) return;
    const hints = app.tabs.getUrlHints(tab);
    const contextKey = provider.contextKey(tab, hints);
    const token = provider.cacheToken(tab, hints);
    const cached = app.scanMemCache[contextKey];
    if (!force && cached && cached.token === token && Date.now() - cached.ts < CONFIG.CACHE_MS) {
      if (
        app.activePanelContextKey !== contextKey ||
        (app.currentEmails.length === 0 && app.cachedEmails.length === 0)
      ) {
        this.applyEmails(cached.emails, contextKey);
      }
      return;
    }

    if (app.scanInFlight.has(contextKey)) {
      if (force) app.scanForcePending.add(contextKey);
      return;
    }
    app.scanInFlight.add(contextKey);
    app.scanContextKey = contextKey;
    app.loadScansInFlight.add(contextKey);
    if (app.panel.shouldShowLoadProgress(contextKey)) {
      app.scanInProgress = true;
      app.panel.updateDisplay();
    }

    try {
      const emails = await provider.fetchUnread(app, tab, hints);
      if (!emails) {
        app.scanInProgress = false;
        app.loadScansInFlight.delete(contextKey);
        if (app.scanContextKey === contextKey) app.scanContextKey = null;
        if (contextKey === app.activePanelContextKey) app.panel.updateDisplay();
        return;
      }
      app.scanMemCache[contextKey] = { ts: Date.now(), token, emails };
      debugLog(provider.label, 'scan', emails.length, 'unread, context=', contextKey);
      this.applyEmails(emails, contextKey);
    } catch (e) {
      debugLog(provider.label, 'fetch failed', e && e.message ? e.message : e);
      app.scanInProgress = false;
      app.loadScansInFlight.delete(contextKey);
      if (app.scanContextKey === contextKey) app.scanContextKey = null;
      app.panel.updateDisplay();
      if (
        e?.signin &&
        app.activePanelContextKey === contextKey &&
        app.currentEmails.length === 0 &&
        app.cachedEmails.length === 0
      ) {
        app.panel.showError(provider.signInMessage, { signin: true });
      }
    } finally {
      app.scanInFlight.delete(contextKey);
      app.tabs.finishLoadScan(tab);
      if (app.scanForcePending.has(contextKey)) {
        app.scanForcePending.delete(contextKey);
        this.requestScan(tab, { force: true });
      }
    }
  }

  onReadStateChanged(tab) {
    const provider = this.app.tabs.providerFor(tab);
    if (!provider || provider.id !== 'gmail') return;
    const contextKey = provider.contextKey(tab, this.app.tabs.getUrlHints(tab));
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

  scanContext(contextKey = this.app.activePanelContextKey) {
    const anchor = this.app.tabs.findLoadedAnchor(contextKey) || this.app.tabs.findAnchor(contextKey);
    if (!anchor) return false;
    this.app.tabs.performLoadScan(anchor);
    return true;
  }
}
