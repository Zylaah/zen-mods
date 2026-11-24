const {
  CONFIG,
  debugLog,
  getContextContainerId,
  getGmailUrlPattern,
  chromeAnimating,
  isEssentialOrPinnedTab,
  isGlanceTab,
  runAfterGlance
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);
const { isEnabled, providerOf, resolveAccountId } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Accounts.sys.mjs' + new URL(import.meta.url).search
);
const {
  emailMatchesThread,
  gmailAccountSlotFromHints,
  gmailAccountSlotFromUrl,
  gmailSpaUrl,
  gmailThreadIdFromUrl,
  isGmailThreadToken,
  normalizeGmailOpenUrl,
  subjectsMatch
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/Gmail.sys.mjs' + new URL(import.meta.url).search
);

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const FRAME_SCRIPT = 'chrome://sine/content/zen-integrations/GmailFrame.js';
const CONNECT_SEEN_PREF = 'zen-integrations.connect-callout.dismissed';

let connectSeen = null;

function connectSeenSet() {
  if (connectSeen) return connectSeen;
  connectSeen = new Set();
  try {
    for (const key of Services.prefs.getStringPref(CONNECT_SEEN_PREF, '').split(',')) {
      if (key) connectSeen.add(key);
    }
  } catch (e) {}
  return connectSeen;
}

function persistConnectSeen() {
  try {
    Services.prefs.setStringPref(CONNECT_SEEN_PREF, [...connectSeenSet()].join(','));
  } catch (e) {}
}

function rememberConnectSeen(key) {
  const seen = connectSeenSet();
  if (seen.has(key)) return;
  seen.add(key);
  persistConnectSeen();
}

function forgetConnectSeen(accountId) {
  const seen = connectSeenSet();
  const provider = providerOf(accountId);
  const container = getContextContainerId(accountId);
  if (!provider) return;
  let changed = false;
  for (const key of [...seen]) {
    if (providerOf(key) !== provider || getContextContainerId(key) !== container) continue;
    seen.delete(key);
    changed = true;
  }
  if (changed) persistConnectSeen();
}

export class ZenTabs {
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

  providerFor(tab) {
    if (!tab) return null;
    const hints = this.getUrlHints(tab);
    for (const provider of this.app.providers) {
      if (provider.matches(hints)) return provider;
    }
    return null;
  }

  isAnchor(tab, contextKey) {
    const provider = this.providerFor(tab);
    if (!provider || !isEssentialOrPinnedTab(tab)) return false;
    if (!contextKey) return true;
    return provider.contextKey(tab, this.getUrlHints(tab)) === String(contextKey);
  }

  getBrowserDocumentSpec(browser) {
    if (!browser?.browsingContext) return '';
    try {
      return browser.documentURI?.spec || '';
    } catch (e) {
      return '';
    }
  }

  isLoadedMailBrowser(tab) {
    const browser = tab?.linkedBrowser;
    if (!browser) return false;
    try {
      if (!browser.browsingContext || browser.browsingContext.discarded) return false;
      const provider = this.providerFor(tab);
      if (!provider) return false;
      return provider.matches([this.getBrowserDocumentSpec(browser)]);
    } catch (e) {
      return false;
    }
  }

  isDiscardedOrUnloaded(tab) {
    if (!tab?.linkedBrowser) return true;
    try {
      if (tab.hasAttribute('discarded')) return true;
      if (tab.linkedBrowser.browsingContext?.discarded) return true;
      return !this.isLoadedMailBrowser(tab);
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

  isNavigationComplete(tab) {
    if (!this.isLoadedMailBrowser(tab)) return false;
    try {
      if (tab.linkedBrowser?.webProgress?.isLoadingDocument) return false;
    } catch (e) {}
    return true;
  }

  findLoadedAnchor(contextKey = this.app.activePanelContextKey) {
    if (!contextKey || !this.gBrowser?.tabs) return null;
    for (const tab of this.gBrowser.tabs) {
      if (!this.isAnchor(tab, contextKey)) continue;
      if (this.isPendingOrDiscarded(tab)) continue;
      if (this.isNavigationComplete(tab)) return tab;
    }
    return null;
  }

  anchors() {
    const byContext = new Map();
    for (const tab of this.gBrowser?.tabs || []) {
      if (!isEssentialOrPinnedTab(tab)) continue;
      const provider = this.providerFor(tab);
      if (!provider) continue;
      const key = provider.contextKey(tab, this.getUrlHints(tab));
      const current = byContext.get(key);
      if (!current || (this.isPendingOrDiscarded(current) && !this.isPendingOrDiscarded(tab))) {
        byContext.set(key, tab);
      }
    }
    return [...byContext.values()];
  }

  findAnchor(contextKey = this.app.activePanelContextKey) {
    if (!contextKey) return null;
    const loaded = this.findLoadedAnchor(contextKey);
    if (loaded) return loaded;
    for (const tab of this.gBrowser?.tabs || []) {
      if (this.isAnchor(tab, contextKey)) return tab;
    }
    return null;
  }

  resolveTarget(contextKey = this.app.activePanelContextKey) {
    if (this.app.hoveredTab && this.isAnchor(this.app.hoveredTab, contextKey)) return this.app.hoveredTab;
    const existing = this.findAnchor(contextKey);
    if (existing) return existing;
    const provider = this.app.providerForKey(contextKey);
    if (!provider || !this.gBrowser) return null;
    const hints = this.getUrlHints(this.app.hoveredTab);
    const containerId = getContextContainerId(contextKey);
    try {
      const addTabArgs = {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
      };
      if (containerId) addTabArgs.userContextId = containerId;
      return this.gBrowser.addTab(provider.homeUrl(hints), addTabArgs);
    } catch (err) {
      console.warn('[Zen Integrations] Could not create tab:', err);
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
    if (!tab || tab.closing || !this.isAnchor(tab)) return;
    if (tab.linkedBrowser && !this.isPendingOrDiscarded(tab) && !this.app.activeLoadScanTabs.has(tab)) {
      this.app.activeLoadScanTabs.add(tab);
      tab.setAttribute('data-zi-was-loaded', 'true');
    }
    this.app.scan.requestScan(tab, { force: false });
  }

  checkLoadState(tab) {
    if (!this.isAnchor(tab)) return;
    const wasLoaded = tab.getAttribute('data-zi-was-loaded') === 'true';
    const isLoaded = !this.isPendingOrDiscarded(tab) && this.isLoadedMailBrowser(tab);
    if (isLoaded && !wasLoaded) {
      this.scheduleLoadScan(tab);
      this.loadInboxWatcher(tab);
    } else if (!isLoaded && wasLoaded) {
      this.finishLoadScan(tab);
      tab.removeAttribute('data-zi-was-loaded');
      const provider = this.providerFor(tab);
      const contextKey = provider?.contextKey(tab, this.getUrlHints(tab));
      if (contextKey) this.app.loadScansInFlight.delete(contextKey);
      if (this.app.activePanelContextKey === contextKey) this.app.scanInProgress = false;
    }
  }

  attachLoadListeners(tab) {
    if (tab.hasAttribute('data-zi-load-mon')) return;
    tab.setAttribute('data-zi-load-mon', 'true');
    tab.addEventListener('SSTabRestored', () => {
      debugLog('Mail tab SSTabRestored');
      this.scheduleLoadScan(tab);
    });
  }

  scanLoadedAnchors() {
    if (!this.gBrowser?.tabs) return;
    for (const tab of this.gBrowser.tabs) {
      if (!this.isAnchor(tab)) continue;
      this.attachLoadListeners(tab);
      if (this.providerFor(tab)?.id === 'gmail') {
        this.wakeGmailActor(tab);
        this.loadInboxWatcher(tab);
      }
      this.checkLoadState(tab);
    }
  }

  cleanupScannerTabs() {
    if (!this.gBrowser?.tabs) return;
    for (const tab of Array.from(this.gBrowser.tabs)) {
      if (tab.hasAttribute(CONFIG.SCANNER_TAB_ATTR) || tab.hasAttribute(CONFIG.LEGACY_SCANNER_TAB_ATTR)) {
        try { this.gBrowser.removeTab(tab, { animate: false }); } catch (e) {}
      }
    }
  }

  loadInboxWatcher(tab) {
    if (this.providerFor(tab)?.id !== 'gmail') return;
    const browser = tab?.linkedBrowser;
    if (!this.isLoadedMailBrowser(tab) || !browser.messageManager) return;
    try {
      browser.messageManager.loadFrameScript(FRAME_SCRIPT, true);
    } catch (e) {
      debugLog('Could not load inbox watcher', e);
    }
  }

  tabForMessageTarget(target) {
    if (!target || !this.gBrowser?.tabs) return null;
    for (const tab of this.gBrowser.tabs) {
      const browser = tab.linkedBrowser;
      if (!browser) continue;
      if (target === browser) return tab;
      try {
        if (browser.messageManager === target) return tab;
      } catch (e) {}
    }
    return null;
  }

  startInboxWatch() {
    if (this.inboxWatchListener) return;
    this.inboxWatchListener = (message) => {
      try {
        const tab = this.tabForMessageTarget(message?.target);
        if (!tab || this.providerFor(tab)?.id !== 'gmail' || !this.isAnchor(tab)) return;
        const data = message.data || {};
        this.noteOpenThread(tab, {
          href: data.href || '',
          threadIds: data.readIds || [],
          subject: data.subject || ''
        });
      } catch (e) {
        debugLog('Inbox watcher', e);
      }
    };
    try {
      Services.mm.addMessageListener('LiveGmail:InboxWatch', this.inboxWatchListener);
    } catch (e) {
      debugLog('Could not listen for inbox watcher', e);
    }
  }

  stopInboxWatch() {
    if (!this.inboxWatchListener) return;
    try { Services.mm.removeMessageListener('LiveGmail:InboxWatch', this.inboxWatchListener); } catch (e) {}
    this.inboxWatchListener = null;
  }

  wakeGmailActor(tab) {
    if (!this.isLoadedMailBrowser(tab)) return;
    try {
      tab.linkedBrowser.browsingContext?.currentWindowGlobal?.getActor('LiveGmail');
    } catch (e) {}
  }

  outlookActor(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor('ZenOutlook') || null;
    } catch (e) {
      return null;
    }
  }

  openOutlook(tab, email) {
    const provider = this.providerFor(tab) || this.app.providerForKey(this.app.activePanelContextKey);
    const link = provider?.readingPaneUrl?.(email) || '';
    if (link) {
      this.openOutlookLink(tab, link);
      return;
    }
    const browser = tab?.linkedBrowser;
    if (browser && !this.isLoadedMailBrowser(tab)) {
      this.loadMailUrl(browser, provider?.homeUrl(this.getUrlHints(tab)) || '');
    }
    const win = this.app.window;
    const started = Date.now();
    const tick = () => {
      const actor = this.outlookActor(tab?.linkedBrowser);
      if (actor?.sendQuery) {
        actor.sendQuery('ZenOutlook:Open', {
          id: email?.threadId || '',
          subject: email?.subject || ''
        }).catch((err) => {
          debugLog('Outlook open failed', err && err.message ? err.message : err);
        });
        return;
      }
      if (Date.now() - started > 8000) return;
      win.setTimeout(tick, 200);
    };
    tick();
  }

  openOutlookLink(tab, url) {
    const browser = tab?.linkedBrowser;
    const actor = this.outlookActor(browser);
    if (actor?.sendQuery && this.isLoadedMailBrowser(tab)) {
      actor.sendQuery('ZenOutlook:OpenLink', { url }).catch(() => this.loadMailUrl(browser, url));
      return;
    }
    this.loadMailUrl(browser, url);
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
    return { ids, subject: email?.subject || '', from: email?.from || '' };
  }

  inboxUrlFor(email, tab) {
    const slot = gmailAccountSlotFromUrl(email?.url || '') || gmailAccountSlotFromHints(this.getUrlHints(tab)) || '0';
    return `https://${getGmailUrlPattern()}/mail/u/${slot}/#inbox`;
  }

  loadMailUrl(browser, url) {
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
        const loaded = this.isLoadedMailBrowser(tab) && this.isNavigationComplete(tab);
        if (!loaded) {
          if (!loadedInbox && Date.now() - started > 1200 && browser && !this.isLoadedMailBrowser(tab)) {
            loadedInbox = true;
            this.loadMailUrl(browser, this.inboxUrlFor(email, tab));
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
        this.loadMailUrl(tab?.linkedBrowser, gmailSpaUrl(gmailUrl) || gmailUrl);
        return;
      }
      const actor = this.gmailActor(tab.linkedBrowser);
      if (!actor?.sendQuery) {
        this.loadMailUrl(tab.linkedBrowser, gmailSpaUrl(gmailUrl) || gmailUrl);
        return;
      }
      actor.sendQuery('LiveGmail:OpenThread', this.threadPayload(email)).then((result) => {
        if (result?.ok) {
          debugLog('Opened thread from inbox row');
          return;
        }
        debugLog('No inbox row matched, opening permalink');
        this.loadMailUrl(tab.linkedBrowser, gmailSpaUrl(gmailUrl) || gmailUrl);
      }).catch((err) => {
        console.warn('[Zen Integrations] Could not open thread:', err);
        this.loadMailUrl(tab.linkedBrowser, gmailSpaUrl(gmailUrl) || gmailUrl);
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
    const provider = this.providerFor(tab);
    const key = provider?.contextKey(tab, this.getUrlHints(tab));
    if (!key) return;
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
    const provider = this.providerFor(targetTab) || this.app.providerForKey(this.app.activePanelContextKey);
    if (!provider) return;
    this.app.panel.hide();
    if (this.gBrowser.selectedTab !== targetTab) this.gBrowser.selectedTab = targetTab;
    try {
      this.loadMailUrl(targetTab.linkedBrowser, provider.composeUrl(this.getUrlHints(targetTab)));
      debugLog('Opened compose', provider.id);
    } catch (e) {
      console.warn('[Zen Integrations] Could not open compose:', e);
    }
  }

  openEmail(email) {
    const app = this.app;
    const targetTab =
      app.hoveredTab && this.isAnchor(app.hoveredTab)
        ? app.hoveredTab
        : this.resolveTarget(app.activePanelContextKey);
    if (!targetTab || !this.gBrowser) return;
    if (this.gBrowser.selectedTab !== targetTab) this.gBrowser.selectedTab = targetTab;

    const provider = this.providerFor(targetTab) || app.providerForKey(app.activePanelContextKey);
    if (provider?.id === 'gmail') {
      const gmailUrl = normalizeGmailOpenUrl(email.url) || provider.homeUrl(this.getUrlHints(targetTab));
      debugLog('Opening Gmail', gmailUrl);
      this.openThreadWhenReady(targetTab, email, gmailUrl);
    } else if (provider?.id === 'outlook') {
      debugLog('Opening Outlook row', email.subject);
      this.openOutlook(targetTab, email);
    } else {
      const url = email.url || provider?.homeUrl(this.getUrlHints(targetTab)) || '';
      debugLog('Opening mail', url);
      this.loadMailUrl(targetTab.linkedBrowser, url);
    }

    app.clickedEmailIds.add(email.id);
    const idx = app.currentEmails.findIndex((item) => item.id === email.id);
    if (idx !== -1) app.currentEmails.splice(idx, 1);
    const cacheIdx = app.cachedEmails.findIndex((item) => item.id === email.id);
    if (cacheIdx !== -1) app.cachedEmails.splice(cacheIdx, 1);
    app.cache.persistActive(app.activePanelContextKey);
    app.cache.save();
    app.panel.updateDisplay();
    app.scan.scanContext(app.activePanelContextKey);
    app.panel.hide();
  }

  attachHoverListener(tab) {
    if (!tab || tab.hasAttribute('data-zi-listener')) return;
    tab.addEventListener('mouseenter', (event) => this.onHover(event));
    tab.addEventListener('mouseleave', () => this.onLeave());
    tab.setAttribute('data-zi-listener', 'true');
  }

  onHover(event) {
    const tab = event.currentTarget;
    if (!tab.hasAttribute('data-zi-mail')) return;
    this.app.panel.scheduleShow(tab);
  }

  onLeave() {
    this.app.panel.cancelShowTimer();
    this.app.panel.scheduleHide();
  }

  scheduleRefresh() {
    if (!this._afterGlance) this._afterGlance = {};
    runAfterGlance(this.window, this._afterGlance, () => this.refreshAnchors());
  }

  refreshAnchors() {
    if (chromeAnimating(this.window)) {
      this.scheduleRefresh();
      return;
    }
    const document = this.window.document;
    if (!this.gBrowser?.tabs) return;
    for (const tab of this.gBrowser.tabs) {
      if (isGlanceTab(tab)) continue;
      const provider = this.providerFor(tab);
      const accountKey = provider?.contextKey(tab, this.getUrlHints(tab));
      const mail = this.isAnchor(tab) && !!accountKey && isEnabled(accountKey);
      if (mail) tab.setAttribute('data-zi-mail', 'true');
      else tab.removeAttribute('data-zi-mail');
      if (tab.hasAttribute('zen-essential') || (tab.pinned && mail)) {
        this.attachHoverListener(tab);
      }
      if (!mail) continue;
      this.attachLoadListeners(tab);
      if (this.providerFor(tab)?.id === 'gmail') {
        this.wakeGmailActor(tab);
        this.loadInboxWatcher(tab);
      }
      this.checkLoadState(tab);
    }
    for (const tab of document.querySelectorAll(
      '#zen-essentials .tabbrowser-tab[zen-essential], .zen-workspace-pinned-tabs-section .tabbrowser-tab[pinned]'
    )) {
      if (tab.hasAttribute('data-zi-mail')) this.attachHoverListener(tab);
    }
    this.layoutRetries = 0;
    this.maybeShowConnectCallout();
  }

  calloutTabs() {
    const tabs = [];
    const seen = new Set();
    const add = (tab) => {
      if (!tab || seen.has(tab)) return;
      seen.add(tab);
      tabs.push(tab);
    };
    try {
      for (const tab of this.gBrowser?.tabs || []) add(tab);
    } catch (e) {}
    try {
      const extra = this.window.document.querySelectorAll(
        '#zen-essentials .tabbrowser-tab, .zen-essentials-container .tabbrowser-tab, .zen-workspace-pinned-tabs-section .tabbrowser-tab'
      );
      for (const tab of extra) add(tab);
    } catch (e) {}
    return tabs;
  }

  calloutAnchorVisible(tab) {
    const win = tab?.ownerGlobal;
    if (!tab?.isConnected || !win) return false;
    const essentials = tab.closest('.zen-essentials-container');
    if (essentials?.hasAttribute('hidden')) return false;
    const space = tab.closest('zen-workspace');
    if (space) {
      const activeId = win.gZenWorkspaces?.activeWorkspace;
      if (activeId && space.id && space.id !== activeId) return false;
    }
    return true;
  }

  connectIdentity(tab) {
    if (!isEssentialOrPinnedTab(tab)) return null;
    const provider = this.providerFor(tab);
    let key = '';
    let accountProvider = '';
    if (provider) {
      key = provider.contextKey(tab, this.getUrlHints(tab));
      accountProvider = provider.id === 'gmail' ? 'google' : provider.id;
    } else if (this.app.calendar?.tabs.isCalendarAnchor(tab)) {
      key = this.app.calendar.tabs.accountKey(tab);
      accountProvider = 'google';
    }
    if (!key) return null;
    const container = getContextContainerId(key);
    // An essential with no container id stays on the default jar. Skip it.
    if (tab.hasAttribute('zen-essential') && !(container > 0)) return null;
    return {
      tab,
      key,
      container,
      accountProvider,
      essential: tab.hasAttribute('zen-essential')
    };
  }

  connectCandidate(tab, seen) {
    const item = this.connectIdentity(tab);
    if (!item || seen.has(item.key) || resolveAccountId(item.key)) return null;
    return item;
  }

  nextConnectCandidate() {
    const seen = connectSeenSet();
    const byKey = new Map();
    for (const tab of this.calloutTabs()) {
      const item = this.connectCandidate(tab, seen);
      if (!item) continue;
      const current = byKey.get(item.key);
      if (!current || (item.essential && !current.essential)) byKey.set(item.key, item);
    }
    return byKey.values().next().value || null;
  }

  connectSnapshot() {
    const seen = connectSeenSet();
    return this.calloutTabs().map((tab) => {
      const identity = this.connectIdentity(tab);
      return {
        label: tab.getAttribute('label') || tab.label || '',
        pinned: !!tab.pinned,
        essential: tab.hasAttribute('zen-essential'),
        key: identity?.key || '',
        seen: identity ? seen.has(identity.key) : false,
        account: identity ? resolveAccountId(identity.key) : '',
        visible: this.calloutAnchorVisible(tab)
      };
    });
  }

  maybeShowConnectCallout() {
    if (this.connectCallout || this.connectCalloutPending) return;
    const item = this.nextConnectCandidate();
    if (item) {
      this.layoutRetries = 0;
      this.connectCalloutPending = true;
      this.openConnectCallout(item);
      return;
    }
    const rows = this.connectSnapshot().filter((row) => row.key && !row.account);
    if (rows.length) {
      console.log('[Zen Integrations] Connect callout skipped', JSON.stringify(rows));
    }
  }

  forgetConnectSeen(accountId) {
    forgetConnectSeen(accountId);
  }

  hideConnectCallout() {
    if (typeof this.connectCleanup === 'function') {
      const cleanup = this.connectCleanup;
      this.connectCleanup = null;
      cleanup();
    }
  }

  pinConnectSidebar() {
    const box = this.window.document.getElementById('navigator-toolbox');
    if (!box) return;
    box.setAttribute('zen-user-show', 'true');
    this.connectToolbox = box;
    this.app.panel.pinCompactChrome(this.connectTab);
  }

  unpinConnectSidebar() {
    if (this.connectToolbox?.getAttribute('zen-user-show') === 'true') {
      this.connectToolbox.removeAttribute('zen-user-show');
    }
    this.connectToolbox = null;
    this.app.panel.unpinCompactChrome();
  }

  positionConnectCallout(card, tab) {
    const win = this.window;
    const width = 244;
    const height = card.getBoundingClientRect().height || 90;
    const gap = 12;
    const isRightSide =
      win.document.documentElement.getAttribute('zen-right-side') === 'true' ||
      !!win.gZenVerticalTabsManager?._prefsRightSide;
    card.dataset.side = isRightSide ? 'right' : 'left';
    const anchor = tab?.querySelector?.('.tab-content, .tab-icon-stack') || tab;
    const rect = anchor?.getBoundingClientRect?.() || { left: 24, right: 24, top: 80, width: 0, height: 0 };
    const rawLeft = isRightSide ? rect.left - width - gap : (rect.right || 0) + gap;
    const left = Math.max(12, Math.min(rawLeft || 12, win.innerWidth - width - 12));
    const rawTop = (rect.top || 80) + (rect.height || 0) / 2 - height / 2;
    const top = Math.max(12, Math.min(rawTop || 80, win.innerHeight - height - 12));
    const tailY = Math.max(18, Math.min((rect.top || 80) + (rect.height || 0) / 2 - top, height - 18));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.setProperty('--zi-tail-y', `${Math.round(tailY)}px`);
    card.style.transformOrigin = `${isRightSide ? '100%' : '0%'} ${Math.round(tailY)}px`;
    return true;
  }

  openConnectCallout(item) {
    const win = this.window;
    const doc = win.document;
    const { tab, key, container, accountProvider } = item;
    this.hideConnectCallout();
    doc.getElementById('zi-connect')?.remove();
    this.connectTab = tab;
    this.pinConnectSidebar();

    const make = (tag, className, parent, text) => {
      const node = doc.createElementNS(HTML_NS, tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      parent?.append(node);
      return node;
    };

    const card = make('div', 'zi-connect');
    card.id = 'zi-connect';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Connect to preview on hover');
    const scheme = win.getComputedStyle?.(doc.documentElement)?.colorScheme;
    if (scheme) card.style.colorScheme = scheme;
    const arrow = make('div', 'zi-connect-arrow', card);
    arrow.setAttribute('aria-hidden', 'true');
    const close = make('button', 'zi-connect-close', card, '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    make('div', 'zi-connect-title', card, 'Connect to preview on hover');
    const button = make('button', 'zi-connect-button', card, 'Connect');
    button.type = 'button';

    (doc.getElementById('browser') || doc.documentElement).appendChild(card);
    this.positionConnectCallout(card, tab);
    card.offsetWidth;
    card.setAttribute('data-open', '');
    this.connectCallout = card;
    this.connectCalloutPending = false;
    console.log('[Zen Integrations] Connect callout shown', key, tab.label);

    const reposition = () => {
      if (chromeAnimating(win)) return;
      this.positionConnectCallout(card, tab);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      rememberConnectSeen(key);
      this.hideConnectCallout();
      win.setTimeout(() => this.maybeShowConnectCallout(), 0);
    };
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('resize', reposition);
    const positionTimer = win.setInterval(reposition, 400);

    this.connectCleanup = () => {
      win.clearInterval(positionTimer);
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('resize', reposition);
      card.remove();
      this.unpinConnectSidebar();
      if (this.connectCallout === card) this.connectCallout = null;
      this.connectTab = null;
    };

    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      rememberConnectSeen(key);
      this.hideConnectCallout();
      win.setTimeout(() => this.maybeShowConnectCallout(), 0);
    });

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      rememberConnectSeen(key);
      this.hideConnectCallout();
      try {
        const { connectDiscoveredAccount } = ChromeUtils.importESModule(
          'chrome://sine/content/zen-integrations/Settings.sys.mjs' + new URL(import.meta.url).search
        );
        connectDiscoveredAccount(win, accountProvider, container).catch((error) => {
          console.warn('[Zen Integrations] Connect from callout failed', error);
        });
      } catch (error) {
        console.warn('[Zen Integrations] Connect import failed', error);
      }
      win.setTimeout(() => this.maybeShowConnectCallout(), 0);
    });
  }

  setupHoverDelegation() {
    const document = this.window.document;
    const onHover = (event) => {
      const tab = event.target.closest?.('.tabbrowser-tab');
      if (!tab?.hasAttribute('data-zi-mail')) return;
      this.app.panel.scheduleShow(tab);
    };
    const roots = [
      document.querySelector('.zen-essentials-container'),
      document.getElementById('zen-essentials'),
      document.querySelector('.zen-workspace-pinned-tabs-section'),
      document.getElementById('tabbrowser-tabs')
    ];
    for (const root of roots) {
      if (!root || root.hasAttribute('data-zi-hover-delegate')) continue;
      root.setAttribute('data-zi-hover-delegate', 'true');
      root.addEventListener('mouseover', onHover, true);
    }
  }

  onWorkspaceOrContainerChanged() {
    this.app.panel.hide();
    this.app.scanInProgress = false;
    this.app.scanContextKey = null;
    this.app.loadScansInFlight.clear();
    if (this.connectCallout && this.connectTab && !this.calloutAnchorVisible(this.connectTab)) {
      this.hideConnectCallout();
    }
    this.maybeShowConnectCallout();
  }

  setupWorkspaceMonitoring() {
    this.window.addEventListener('ZenWorkspacesUIUpdate', () => this.onWorkspaceOrContainerChanged());
    this.window.addEventListener('AfterWorkspacesSessionRestore', () => this.refreshAnchors());
    try {
      Services.prefs.addObserver('zen.workspaces.separate-essentials', () => this.onWorkspaceOrContainerChanged(), false);
    } catch (e) {}
  }

  setupMonitoring() {
    this.startInboxWatch();
    this.refreshAnchors();
    const onChange = () => this.scheduleRefresh();
    this.window.addEventListener('TabPinned', onChange, true);
    this.window.addEventListener('TabUnpinned', onChange, true);
    this.window.addEventListener('TabAttrModified', onChange, true);
    if (this.gBrowser?.tabContainer) {
      this.gBrowser.tabContainer.addEventListener('TabAttrModified', onChange);
      this.gBrowser.tabContainer.addEventListener('TabOpen', onChange);
      this.gBrowser.tabContainer.addEventListener('TabClose', onChange);
      this.gBrowser.tabContainer.addEventListener('TabPinned', onChange);
      this.gBrowser.tabContainer.addEventListener('TabUnpinned', onChange);
    }
    this.setupHoverDelegation();
    this.setupWorkspaceMonitoring();

    const observer = new this.window.MutationObserver(onChange);
    const document = this.window.document;
    const essentials = document.getElementById('zen-essentials');
    if (essentials) {
      observer.observe(essentials, {
        attributes: true,
        attributeFilter: ['zen-essential', 'pinned', 'data-url', 'pending', 'label', 'image']
      });
    }
    const tabs = document.getElementById('tabbrowser-tabs');
    if (tabs) {
      observer.observe(tabs, {
        attributes: true,
        subtree: true,
        attributeFilter: ['zen-essential', 'pinned', 'data-url']
      });
    }
  }
}
