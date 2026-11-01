const {
  CONFIG,
  debugLog,
  getContextContainerId,
  getTabUserContextId,
  emailMatchesThread,
  getGmailComposeUrl,
  getGmailInboxUrl,
  getGmailUrlPattern,
  gmailAccountSlotFromHints,
  gmailAccountSlotFromUrl,
  gmailSpaUrl,
  gmailThreadIdFromUrl,
  isEssentialOrPinnedTab,
  isGmailThreadToken,
  normalizeGmailOpenUrl,
  subjectsMatch,
  tabMatchesContainerContext
} = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailUtil.sys.mjs' + new URL(import.meta.url).search
);

export class LiveGmailTabs {
  constructor(app) {
    this.app = app;
  }

  get window() {
    return this.app.window;
  }

  get gBrowser() {
    return this.window.gBrowser;
  }

  getUrlHints(tab) {
    const hints = [];
    if (!tab) return hints;
    for (const attr of ['data-url', 'zen-origin-url', 'data-original-url']) {
      const value = tab.getAttribute(attr);
      if (value) hints.push(value);
    }
    const pendingVal = tab.getAttribute('pending');
    if (pendingVal && pendingVal !== 'true') hints.push(pendingVal);
    try {
      if (typeof this.window.SessionStore !== 'undefined') {
        const lazyUrl = this.window.SessionStore.getLazyTabValue(tab, 'url');
        if (lazyUrl) hints.push(lazyUrl);
        const lazyTitle = this.window.SessionStore.getLazyTabValue(tab, 'title');
        if (lazyTitle) hints.push(lazyTitle);
      }
    } catch (e) {}
    try {
      const spec = tab.linkedBrowser?.currentURI?.spec;
      if (spec) hints.push(spec);
    } catch (e) {}
    const image = tab.getAttribute('image') || '';
    if (image) hints.push(image);
    const label = tab.getAttribute('label') || tab.label || '';
    if (label) hints.push(label);
    return hints;
  }

  matchesGmailPattern(tab) {
    const pattern = getGmailUrlPattern();
    const hints = this.getUrlHints(tab);
    if (hints.some((hint) => hint.includes(pattern))) return true;
    const image = (tab.getAttribute('image') || '').toLowerCase();
    if (image.includes('mail.google') || image.includes('google.com/mail') || image.includes('gmail')) {
      return true;
    }
    const label = (tab.getAttribute('label') || tab.label || '').toLowerCase();
    return label === 'gmail' || label.includes('mail.google');
  }

  isGmailAnchor(tab, contextKey = this.app.getPanelContextKey(tab)) {
    if (!isEssentialOrPinnedTab(tab)) return false;
    if (!tabMatchesContainerContext(tab, contextKey)) return false;
    return this.matchesGmailPattern(tab);
  }

  getBrowserDocumentSpec(browser) {
    if (!browser?.browsingContext) return '';
    try {
      return browser.documentURI?.spec || '';
    } catch (e) {
      return '';
    }
  }

  isLoadedGmailBrowser(browser) {
    if (!browser) return false;
    try {
      if (!browser.browsingContext) return false;
      if (browser.browsingContext.discarded) return false;
      return this.getBrowserDocumentSpec(browser).includes(getGmailUrlPattern());
    } catch (e) {
      return false;
    }
  }

  isDiscardedOrUnloaded(tab) {
    if (!tab?.linkedBrowser) return true;
    try {
      if (tab.hasAttribute('discarded')) return true;
      if (tab.linkedBrowser.browsingContext?.discarded) return true;
      return !this.isLoadedGmailBrowser(tab.linkedBrowser);
    } catch (e) {
      return true;
    }
  }

  isPendingOrDiscarded(tab) {
    if (!tab) return true;
    if (tab.hasAttribute('pending')) return true;
    if (tab.hasAttribute('discarded')) return true;
    if (!tab.linkedPanel) return true;
    return false;
  }

  isNavigationComplete(browser) {
    if (!this.isLoadedGmailBrowser(browser)) return false;
    try {
      if (browser.webProgress?.isLoadingDocument) return false;
    } catch (e) {}
    return true;
  }

  findLoadedAnchor(contextKey = this.app.activePanelContextKey || this.app.getPanelContextKey()) {
    if (!this.gBrowser?.tabs) return null;
    for (const tab of this.gBrowser.tabs) {
      if (!this.isGmailAnchor(tab, contextKey)) continue;
      if (this.isPendingOrDiscarded(tab)) continue;
      if (this.isNavigationComplete(tab.linkedBrowser)) return tab;
    }
    return null;
  }

  gmailAnchors() {
    const byContext = new Map();
    for (const tab of this.gBrowser?.tabs || []) {
      if (!isEssentialOrPinnedTab(tab) || !this.matchesGmailPattern(tab)) continue;
      const key = String(getTabUserContextId(tab) || 0);
      const current = byContext.get(key);
      if (!current || (this.isPendingOrDiscarded(current) && !this.isPendingOrDiscarded(tab))) {
        byContext.set(key, tab);
      }
    }
    return [...byContext.values()];
  }

  findAnchor(contextKey = this.app.activePanelContextKey || this.app.getPanelContextKey()) {
    const loaded = this.findLoadedAnchor(contextKey);
    if (loaded) return loaded;
    if (!this.gBrowser?.tabs) return null;
    for (const tab of this.gBrowser.tabs) {
      if (this.isGmailAnchor(tab, contextKey)) return tab;
    }
    return null;
  }

  resolveTarget(contextKey = this.app.activePanelContextKey || this.app.getPanelContextKey()) {
    if (this.app.hoveredTab && this.isGmailAnchor(this.app.hoveredTab, contextKey)) {
      return this.app.hoveredTab;
    }
    const existing = this.findAnchor(contextKey);
    if (existing) return existing;
    if (!this.gBrowser) return null;
    const gmailUrl = `https://${getGmailUrlPattern()}/`;
    const containerId = getContextContainerId(contextKey);
    try {
      const addTabArgs = {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
      };
      if (containerId) addTabArgs.userContextId = containerId;
      return this.gBrowser.addTab(gmailUrl, addTabArgs);
    } catch (err) {
      console.warn('[Live Gmail] Could not create Gmail tab:', err);
      return null;
    }
  }

  tabForBrowser(browser) {
    if (!browser || !this.gBrowser) return null;
    try {
      if (typeof this.gBrowser.getTabForBrowser === 'function') {
        return this.gBrowser.getTabForBrowser(browser);
      }
    } catch (e) {}
    for (const tab of this.gBrowser.tabs || []) {
      if (tab.linkedBrowser === browser) return tab;
    }
    return null;
  }

  finishLoadScan(tab) {
    if (tab) this.app.activeLoadScanTabs.delete(tab);
  }

  scheduleLoadScan(tab) {
    if (!tab || tab.closing) return;
    if (this.app.activeLoadScanTabs.has(tab) || this.app.loadScanTimers.has(tab)) return;
    const timer = this.window.setTimeout(() => {
      this.app.loadScanTimers.delete(tab);
      this.performLoadScan(tab);
    }, 400);
    this.app.loadScanTimers.set(tab, timer);
  }

  performLoadScan(tab) {
    if (!tab || tab.closing || !this.isGmailAnchor(tab)) return;
    const browser = tab.linkedBrowser;
    if (browser && !this.isPendingOrDiscarded(tab) && !this.app.activeLoadScanTabs.has(tab)) {
      this.app.activeLoadScanTabs.add(tab);
      tab.setAttribute('data-live-gmail-was-loaded', 'true');
    }
    this.app.atom.requestScan(tab, { force: false });
  }

  checkLoadState(tab) {
    if (!this.isGmailAnchor(tab)) return;
    const wasLoaded = tab.getAttribute('data-live-gmail-was-loaded') === 'true';
    const isLoaded =
      !this.isPendingOrDiscarded(tab) &&
      tab.linkedBrowser &&
      this.isLoadedGmailBrowser(tab.linkedBrowser);
    if (isLoaded && !wasLoaded) {
      this.scheduleLoadScan(tab);
    } else if (!isLoaded && wasLoaded) {
      this.finishLoadScan(tab);
      tab.removeAttribute('data-live-gmail-was-loaded');
      const contextKey = this.app.getPanelContextKey(tab);
      this.app.loadScansInFlight.delete(contextKey);
      if (this.app.activePanelContextKey === contextKey) {
        this.app.scanInProgress = false;
      }
    }
  }

  attachLoadListeners(tab) {
    if (tab.hasAttribute('data-live-gmail-load-mon')) return;
    tab.setAttribute('data-live-gmail-load-mon', 'true');
    tab.addEventListener('SSTabRestored', () => {
      debugLog('Gmail tab SSTabRestored');
      this.scheduleLoadScan(tab);
    });
  }

  scanLoadedAnchors() {
    if (!this.gBrowser?.tabs) return;
    for (const tab of this.gBrowser.tabs) {
      if (!this.isGmailAnchor(tab, this.app.getPanelContextKey(tab))) continue;
      this.attachLoadListeners(tab);
      this.wakeGmailActor(tab);
      this.checkLoadState(tab);
    }
  }

  cleanupScannerTabs() {
    if (!this.gBrowser?.tabs) return;
    for (const tab of Array.from(this.gBrowser.tabs)) {
      if (tab.hasAttribute(CONFIG.SCANNER_TAB_ATTR)) {
        try {
          this.gBrowser.removeTab(tab, { animate: false });
        } catch (e) {}
      }
    }
  }

  wakeGmailActor(tab) {
    if (!this.isLoadedGmailBrowser(tab?.linkedBrowser)) return;
    try {
      tab.linkedBrowser.browsingContext?.currentWindowGlobal?.getActor('LiveGmail');
    } catch (e) {}
  }

  gmailActor(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor('LiveGmail') || null;
    } catch (e) {
      return null;
    }
  }

  threadPayload(email) {
    const ids = [];
    for (const value of [
      email?.gmailThreadId,
      email?.legacyThreadId,
      email?.threadId,
      gmailThreadIdFromUrl(email?.url || '')
    ]) {
      if (isGmailThreadToken(value) && !ids.includes(value)) ids.push(value);
    }
    return {
      ids,
      subject: email?.subject || '',
      from: email?.from || ''
    };
  }

  inboxUrlFor(email, tab) {
    const slot = gmailAccountSlotFromUrl(email?.url || '') || gmailAccountSlotFromHints(this.getUrlHints(tab)) || '0';
    return `https://${getGmailUrlPattern()}/mail/u/${slot}/#inbox`;
  }

  loadGmailUrl(browser, url) {
    if (!browser?.fixupAndLoadURIString || !url) return;
    browser.fixupAndLoadURIString(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
    });
  }

  waitForInbox(tab, email) {
    const win = this.app.window;
    const started = Date.now();
    let showedInbox = false;
    let loadedInbox = false;
    return new Promise((resolve) => {
      const tick = () => {
        if (Date.now() - started > 8000) {
          resolve(false);
          return;
        }
        const browser = tab?.linkedBrowser;
        const loaded = this.isLoadedGmailBrowser(browser) && this.isNavigationComplete(browser);
        if (!loaded) {
          if (!loadedInbox && Date.now() - started > 1200 && browser && !this.isLoadedGmailBrowser(browser)) {
            loadedInbox = true;
            this.loadGmailUrl(browser, this.inboxUrlFor(email, tab));
          }
          win.setTimeout(tick, 150);
          return;
        }
        const actor = this.gmailActor(browser);
        if (!actor?.sendQuery) {
          win.setTimeout(tick, 150);
          return;
        }
        actor.sendQuery('LiveGmail:InboxReady').then((status) => {
          if (status?.rows > 0) {
            resolve(true);
            return;
          }
          if (!showedInbox) {
            showedInbox = true;
            actor.sendQuery('LiveGmail:ShowInbox').catch(() => {}).then(() => {
              win.setTimeout(tick, 250);
            });
            return;
          }
          win.setTimeout(tick, 200);
        }).catch(() => {
          win.setTimeout(tick, 200);
        });
      };
      tick();
    });
  }

  openThreadWhenReady(tab, email, gmailUrl) {
    this.waitForInbox(tab, email).then((ready) => {
      if (!ready) {
        debugLog('Inbox was not ready, opening permalink');
        this.loadGmailUrl(tab?.linkedBrowser, gmailSpaUrl(gmailUrl) || gmailUrl);
        return;
      }
      const actor = this.gmailActor(tab.linkedBrowser);
      if (!actor?.sendQuery) {
        this.loadGmailUrl(tab.linkedBrowser, gmailSpaUrl(gmailUrl) || gmailUrl);
        return;
      }
      actor.sendQuery('LiveGmail:OpenThread', this.threadPayload(email)).then((result) => {
        if (result?.ok) {
          debugLog('Opened thread from inbox row');
          return;
        }
        debugLog('No inbox row matched, opening permalink');
        this.loadGmailUrl(tab.linkedBrowser, gmailSpaUrl(gmailUrl) || gmailUrl);
      }).catch((err) => {
        console.warn('[Live Gmail] Could not open thread:', err);
        this.loadGmailUrl(tab.linkedBrowser, gmailSpaUrl(gmailUrl) || gmailUrl);
      });
    });
  }

  noteOpenThread(tab, data) {
    if (!tab) return;
    const ids = [];
    const fromUrl = gmailThreadIdFromUrl(data?.href || '');
    if (fromUrl) ids.push(fromUrl);
    for (const list of [data?.threadIds, data?.readIds]) {
      if (!Array.isArray(list)) continue;
      for (const id of list) {
        if (isGmailThreadToken(id)) ids.push(id);
      }
    }
    const subject = String(data?.subject || '').trim();
    if (ids.length === 0 && !subject) return;

    const app = this.app;
    const key = app.getPanelContextKey(tab);
    const ctx = app.cache.getOrCreateContext(key);
    const active = String(key) === String(app.activePanelContextKey);
    const lists = [ctx.currentEmails, ctx.cachedEmails];
    if (active && app.currentEmails !== ctx.currentEmails) lists.push(app.currentEmails);
    if (active && app.cachedEmails !== ctx.cachedEmails) lists.push(app.cachedEmails);
    const remember = (id) => {
      ctx.clickedEmailIds.add(id);
      if (active) app.clickedEmailIds.add(id);
    };
    const matches = (email) => ids.some((id) => emailMatchesThread(email, id));
    let removed = false;
    const drop = (list, predicate) => {
      if (!Array.isArray(list)) return;
      for (let i = list.length - 1; i >= 0; i--) {
        if (!predicate(list[i])) continue;
        remember(list[i].id);
        list.splice(i, 1);
        removed = true;
      }
    };
    for (const list of lists) drop(list, matches);
    if (!removed && subject) {
      const seen = new Set();
      const hits = [];
      for (const list of lists) {
        for (const email of list || []) {
          if (!email || seen.has(email.id) || !subjectsMatch(email.subject, subject)) continue;
          seen.add(email.id);
          hits.push(email.id);
        }
      }
      if (hits.length === 1) {
        const only = hits[0];
        for (const list of lists) drop(list, (email) => email?.id === only);
      }
    }
    if (!removed) {
      if (ids.length || subject) debugLog('Open thread did not match list', ids.join(',') || subject);
      return;
    }
    if (active) {
      app.currentEmails = ctx.currentEmails === app.currentEmails ? app.currentEmails : ctx.currentEmails;
      app.cachedEmails = ctx.cachedEmails === app.cachedEmails ? app.cachedEmails : ctx.cachedEmails;
      app.clickedEmailIds = ctx.clickedEmailIds;
      app.panel.updateDisplay();
    }
    app.cache.save();
    debugLog('Hid opened thread', ids[0] || subject);
  }

  openCompose() {
    if (!this.gBrowser) return;
    const targetTab = this.resolveTarget();
    if (!targetTab?.linkedBrowser) return;
    this.app.panel.hide();
    if (this.gBrowser.selectedTab !== targetTab) {
      this.gBrowser.selectedTab = targetTab;
    }
    try {
      targetTab.linkedBrowser.fixupAndLoadURIString(getGmailComposeUrl(), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
      });
      debugLog('Opened Gmail compose');
    } catch (e) {
      console.warn('[Live Gmail] Could not open Gmail compose:', e);
    }
  }

  openEmail(email) {
    const app = this.app;
    const targetTab =
      app.hoveredTab && this.isGmailAnchor(app.hoveredTab)
        ? app.hoveredTab
        : this.resolveTarget(app.activePanelContextKey);
    if (!targetTab || !this.gBrowser) return;

    if (this.gBrowser.selectedTab !== targetTab) {
      this.gBrowser.selectedTab = targetTab;
    }

    const gmailUrl = normalizeGmailOpenUrl(email.url) || getGmailInboxUrl();
    debugLog('Opening email', gmailUrl);
    this.openThreadWhenReady(targetTab, email, gmailUrl);

    app.clickedEmailIds.add(email.id);
    const idx = app.currentEmails.findIndex((item) => item.id === email.id);
    if (idx !== -1) app.currentEmails.splice(idx, 1);
    const cacheIdx = app.cachedEmails.findIndex((item) => item.id === email.id);
    if (cacheIdx !== -1) app.cachedEmails.splice(cacheIdx, 1);
    app.panel.updateDisplay();
    app.atom.scanContext(app.activePanelContextKey);
    app.panel.hide();
  }

  attachHoverListener(tab) {
    if (!tab || tab.hasAttribute('data-live-gmail-listener')) return;
    tab.addEventListener('mouseenter', (event) => this.onHover(event));
    tab.addEventListener('mouseleave', () => this.onLeave());
    tab.setAttribute('data-live-gmail-listener', 'true');
  }

  onHover(event) {
    const tab = event.currentTarget;
    if (!this.isGmailAnchor(tab)) {
      this.app.panel.cancelShowTimer();
      this.app.panel.scheduleHide();
      return;
    }
    this.app.panel.scheduleShow(tab);
  }

  onLeave() {
    this.app.panel.cancelShowTimer();
    this.app.panel.scheduleHide();
  }

  refreshAnchors() {
    const document = this.window.document;
    if (!this.gBrowser?.tabs) return;
    for (const tab of this.gBrowser.tabs) {
      if (tab.hasAttribute('zen-essential') || (tab.pinned && this.matchesGmailPattern(tab))) {
        this.attachHoverListener(tab);
      }
      if (!this.isGmailAnchor(tab, this.app.getPanelContextKey(tab))) continue;
      this.attachLoadListeners(tab);
      this.wakeGmailActor(tab);
      this.checkLoadState(tab);
    }
    for (const tab of document.querySelectorAll(
      '#zen-essentials .tabbrowser-tab[zen-essential], .zen-workspace-pinned-tabs-section .tabbrowser-tab[pinned]'
    )) {
      if (tab.hasAttribute('zen-essential') || this.matchesGmailPattern(tab)) {
        this.attachHoverListener(tab);
      }
    }
  }

  setupHoverDelegation() {
    const document = this.window.document;
    const onHover = (event) => {
      const tab = event.target.closest?.('.tabbrowser-tab');
      if (!tab || !this.isGmailAnchor(tab, this.app.getPanelContextKey(tab))) return;
      this.app.panel.scheduleShow(tab);
    };
    const roots = [
      document.querySelector('.zen-essentials-container'),
      document.getElementById('zen-essentials'),
      document.querySelector('.zen-workspace-pinned-tabs-section'),
      document.getElementById('tabbrowser-tabs')
    ];
    for (const root of roots) {
      if (!root || root.hasAttribute('data-live-gmail-hover-delegate')) continue;
      root.setAttribute('data-live-gmail-hover-delegate', 'true');
      root.addEventListener('mouseover', onHover, true);
    }
  }

  onWorkspaceOrContainerChanged(force = false) {
    const nextKey = this.app.getPanelContextKey();
    if (!force && nextKey === this.app.activePanelContextKey) return;
    this.app.panel.hide();
    this.app.scanInProgress = false;
    this.app.scanContextKey = null;
    this.app.loadScansInFlight.clear();
    this.app.cache.activate(nextKey);
  }

  setupWorkspaceMonitoring() {
    this.window.addEventListener('ZenWorkspacesUIUpdate', () =>
      this.onWorkspaceOrContainerChanged(false)
    );
    try {
      Services.prefs.addObserver(
        'zen.workspaces.separate-essentials',
        () => this.onWorkspaceOrContainerChanged(true),
        false
      );
    } catch (e) {}
  }

  setupMonitoring() {
    const document = this.window.document;
    this.refreshAnchors();
    if (this.gBrowser?.tabContainer) {
      const onChange = () => this.refreshAnchors();
      this.gBrowser.tabContainer.addEventListener('TabAttrModified', onChange);
      this.gBrowser.tabContainer.addEventListener('TabOpen', onChange);
      this.gBrowser.tabContainer.addEventListener('TabClose', onChange);
      this.gBrowser.tabContainer.addEventListener('TabPinned', onChange);
      this.gBrowser.tabContainer.addEventListener('TabUnpinned', onChange);
    }
    this.setupHoverDelegation();
    this.setupWorkspaceMonitoring();

    let timer = null;
    const debounced = () => {
      if (timer) this.window.clearTimeout(timer);
      timer = this.window.setTimeout(() => this.refreshAnchors(), 150);
    };
    const observer = new this.window.MutationObserver(debounced);
    const essentials = document.getElementById('zen-essentials');
    if (essentials) {
      observer.observe(essentials, {
        childList: true,
        attributes: true,
        attributeFilter: ['zen-essential', 'pinned', 'data-url', 'pending', 'label', 'image']
      });
    }
    const tabs = document.getElementById('tabbrowser-tabs');
    if (tabs) {
      observer.observe(tabs, {
        childList: true,
        attributes: true,
        subtree: true,
        attributeFilter: ['zen-essential', 'pinned', 'data-url']
      });
    }
  }
}
