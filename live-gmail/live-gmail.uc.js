// ==UserScript==
// @name           Live Gmail Panel
// @description    Displays Gmail inbox emails in a floating panel when hovering over Gmail essential or pinned tabs
// @author         Bxth
// @version        3.6.1
// @namespace      https://github.com/zen-browser/desktop
// ==/UserScript==

(function() {
  'use strict';

  const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';

  // Configuration
  const CONFIG = {
    GMAIL_URL_PREF: 'live-gmail.url',
    DEBUG_PREF: 'live-gmail.debug',
    DEFAULT_GMAIL_URL: 'mail.google.com',
    MAX_EMAILS: 20,
    PANEL_ID: 'live-gmail-panel',
    SCANNER_TAB_ATTR: 'data-live-gmail-scanner',
    HOVER_DELAY_MS: 200,
    ATOM_CACHE_MS: 60000,
    ATOM_TIMEOUT_MS: 8000,
    ATOM_MAX_BYTES: 500000
  };

  const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
  const Cr = globalThis.Cr || Components.results;

  /**
   * Check if debug logging is enabled
   */
  function isDebugEnabled() {
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        return Services.prefs.getBoolPref(CONFIG.DEBUG_PREF, false);
      }
    } catch (e) {}
    return false;
  }

  /**
   * Debug log function (only logs if DEBUG_PREF is enabled)
   */
  function debugLog(...args) {
    if (isDebugEnabled()) {
      console.log('[Live Gmail]', ...args);
    }
  }

  // State
  let currentEmails = [];
  let cachedEmails = []; // Lightweight in-memory cache for when tab is closed
  let hoveredTab = null;
  let panelElement = null;
  let gmailTabs = new Map();
  let clickedEmailIds = new Set();
  let messageListenersRegistered = false;
  let scanInProgress = false;
  let atomMemCache = {}; // contextKey -> { ts, feedUrl, emails }
  let atomInFlight = new Set();
  let readStateTimers = new Map();
  let hideTimer = null;
  let showTimer = null;
  let pendingShowTab = null;
  let cachedFrameScriptUrl = null;
  let loadScanTimers = new WeakMap();
  let loadScansInFlight = new Set();
  let activeLoadScanTabs = new WeakSet();
  let activePanelContextKey = null; // Firefox container id as string, e.g. "0" / "2"
  let scanContextKey = null; // context key for an in-flight hover scan
  let panelContexts = new Map(); // contextKey -> { currentEmails, cachedEmails, clickedEmailIds }
  let diskCacheStore = {}; // persisted cache keyed by contextKey
  let compactPinTarget = null; // non-tab node with [open] while the panel is shown

  /**
   * Firefox container id on a tab (default 0).
   * Cookie jars and Atom fetches are isolated by this id.
   */
  function getTabUserContextId(tab) {
    if (!tab) return 0;
    if (typeof tab.userContextId === 'number' && !Number.isNaN(tab.userContextId)) {
      return tab.userContextId;
    }
    return parseInt(tab.getAttribute('usercontextid') || '0', 10) || 0;
  }

  /**
   * Panel cache key: one panel state per Firefox container.
   * Zen shares essentials across workspaces that use the same container, so inbox
   * content only differs by container — not by workspace uuid.
   */
  function getPanelContextKey(tab = hoveredTab) {
    if (tab) return String(getTabUserContextId(tab) || 0);

    if (window.gZenWorkspaces?.containerSpecificEssentials) {
      const active = window.gZenWorkspaces?.getActiveWorkspaceFromCache?.();
      if (typeof active?.containerTabId === 'number') {
        return String(active.containerTabId || 0);
      }
    }

    const selected = gBrowser?.selectedTab;
    if (selected) return String(getTabUserContextId(selected) || 0);
    return '0';
  }

  /**
   * Container id from a panel context key.
   * Supports current keys ("2") and legacy workspace keys ("uuid:2", "default:0").
   */
  function getContextContainerId(contextKey) {
    const key = String(contextKey || '0');
    if (key.includes(':')) {
      return parseInt(key.split(':').pop() || '0', 10) || 0;
    }
    return parseInt(key, 10) || 0;
  }

  /**
   * Whether a tab belongs to the Firefox container of a panel context key.
   */
  function tabMatchesContainerContext(tab, contextKey) {
    if (!tab) return false;
    return getTabUserContextId(tab) === getContextContainerId(contextKey);
  }

  function isEssentialOrPinnedTab(tab) {
    return !!(tab && (tab.hasAttribute('zen-essential') || tab.pinned));
  }

  function normalizeDiskCacheEntry(entry) {
    if (Array.isArray(entry)) {
      return { emails: entry, lastScanTs: 0 };
    }
    if (entry && Array.isArray(entry.emails)) {
      return {
        emails: entry.emails,
        lastScanTs: typeof entry.lastScanTs === 'number' ? entry.lastScanTs : 0
      };
    }
    return { emails: [], lastScanTs: 0 };
  }

  function getOrCreatePanelContext(key) {
    const storeKey = String(key ?? 0);
    if (!panelContexts.has(storeKey)) {
      const entry = Object.prototype.hasOwnProperty.call(diskCacheStore, storeKey)
        ? normalizeDiskCacheEntry(diskCacheStore[storeKey])
        : { emails: [], lastScanTs: 0 };
      panelContexts.set(storeKey, {
        currentEmails: [],
        cachedEmails: entry.emails.slice(),
        clickedEmailIds: new Set(),
        hasScanned: Object.prototype.hasOwnProperty.call(diskCacheStore, storeKey),
        lastScanTs: entry.lastScanTs
      });
    } else {
      hydrateContextFromDisk(storeKey, panelContexts.get(storeKey));
    }
    return panelContexts.get(storeKey);
  }

  /**
   * Fill an already-created context from disk. Startup can create an empty
   * context (workspace UI / first hover) before IOUtils.readUTF8 finishes.
   */
  function hydrateContextFromDisk(key, ctx) {
    if (!ctx || !Object.prototype.hasOwnProperty.call(diskCacheStore, key)) return;
    const entry = normalizeDiskCacheEntry(diskCacheStore[key]);
    ctx.hasScanned = true;
    if (!ctx.lastScanTs && entry.lastScanTs) {
      ctx.lastScanTs = entry.lastScanTs;
    }
    if (ctx.cachedEmails.length === 0 && entry.emails.length > 0) {
      ctx.cachedEmails = entry.emails.slice();
    }
  }

  function persistActiveContextToMemory(key = activePanelContextKey) {
    if (!key) return;
    const ctx = getOrCreatePanelContext(key);
    ctx.currentEmails = currentEmails;
    ctx.cachedEmails = cachedEmails;
  }

  /**
   * Switch the in-memory email state to a container context.
   */
  function activatePanelContext(key) {
    if (key == null || key === '') return;
    const storeKey = String(key);

    if (storeKey !== activePanelContextKey) {
      persistActiveContextToMemory(activePanelContextKey);
      activePanelContextKey = storeKey;
      debugLog('Panel context:', storeKey);
    }

    const ctx = getOrCreatePanelContext(storeKey);
    currentEmails = ctx.currentEmails;
    cachedEmails = ctx.cachedEmails;
    clickedEmailIds = ctx.clickedEmailIds;
  }

  /**
   * Resolve the tab that owns a frame-script message manager.
   */
  function getTabForMessageManager(mm) {
    if (!mm || !gBrowser?.tabs) return null;
    for (const tab of gBrowser.tabs) {
      try {
        if (tab.linkedBrowser?.messageManager === mm) return tab;
      } catch (e) {}
    }
    return null;
  }

  /**
   * React when the active container changes (or separate-essentials is toggled).
   * Same-container workspace switches are a no-op — essentials and inbox are shared.
   */
  function onWorkspaceOrContainerChanged(force = false) {
    const nextKey = getPanelContextKey();
    if (!force && nextKey === activePanelContextKey) {
      return;
    }

    hidePanel();
    scanInProgress = false;
    scanContextKey = null;
    loadScansInFlight.clear();
    activatePanelContext(nextKey);
  }

  /**
   * Collect URL hints from a tab (works when unloaded — data-url may be missing until first open)
   */
  function getTabUrlHints(tab) {
    const hints = [];
    if (!tab) return hints;

    for (const attr of ['data-url', 'zen-origin-url', 'data-original-url']) {
      const value = tab.getAttribute(attr);
      if (value) hints.push(value);
    }

    // pending="true" is a flag, not a URL; pending="https://..." holds the restore URI on some builds
    const pendingVal = tab.getAttribute('pending');
    if (pendingVal && pendingVal !== 'true') hints.push(pendingVal);

    // SessionStore lazy URL/title — reliable on cold-start pending essentials
    try {
      if (typeof SessionStore !== 'undefined') {
        const lazyUrl = SessionStore.getLazyTabValue(tab, 'url');
        if (lazyUrl) hints.push(lazyUrl);
        const lazyTitle = SessionStore.getLazyTabValue(tab, 'title');
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

  /**
   * Match Gmail by URL pattern, pending URI, favicon, or label (unloaded essentials)
   */
  function tabMatchesGmailPattern(tab) {
    const pattern = getGmailUrlPattern();
    const hints = getTabUrlHints(tab);

    if (hints.some((hint) => hint.includes(pattern))) {
      return true;
    }

    const image = (tab.getAttribute('image') || '').toLowerCase();
    if (image.includes('mail.google') || image.includes('google.com/mail') || image.includes('gmail')) {
      return true;
    }

    const label = (tab.getAttribute('label') || tab.label || '').toLowerCase();
    if (label === 'gmail' || label.includes('mail.google')) {
      return true;
    }

    return false;
  }

  /**
   * Gmail essential or pinned tab for the given Firefox container.
   */
  function isGmailAnchorTab(tab, contextKey = getPanelContextKey(tab)) {
    if (!isEssentialOrPinnedTab(tab)) return false;
    if (!tabMatchesContainerContext(tab, contextKey)) return false;
    return tabMatchesGmailPattern(tab);
  }

  function getGmailInboxUrl() {
    return `https://${getGmailUrlPattern()}/mail/u/0/#inbox`;
  }

  function getGmailComposeUrl() {
    return `https://${getGmailUrlPattern()}/mail/u/0/#inbox?compose=new`;
  }

  /**
   * Resolve the Gmail essential tab to use for navigation (hovered, existing, or new)
   */
  function resolveGmailTargetTab(contextKey = activePanelContextKey || getPanelContextKey()) {
    if (hoveredTab && isGmailAnchorTab(hoveredTab, contextKey)) {
      return hoveredTab;
    }

    const existing = findGmailAnchorTab(contextKey);
    if (existing) return existing;

    if (!gBrowser) return null;

    const pattern = getGmailUrlPattern();
    const gmailUrl = `https://${pattern}/`;
    const containerId = getContextContainerId(contextKey);

    try {
      const addTabArgs = {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
      };
      if (containerId) {
        addTabArgs.userContextId = containerId;
      }

      return gBrowser.addTab(gmailUrl, addTabArgs);
    } catch (err) {
      console.warn('[Live Gmail] Could not create Gmail tab:', err);
      return null;
    }
  }

  /**
   * Switch to the Gmail essential tab and open a new compose draft
   */
  function openGmailCompose() {
    if (!gBrowser) return;

    const targetTab = resolveGmailTargetTab();
    if (!targetTab?.linkedBrowser) return;

    hidePanel();

    if (gBrowser.selectedTab !== targetTab) {
      gBrowser.selectedTab = targetTab;
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

  function isPanelOpen() {
    try {
      return panelElement?.state === 'open';
    } catch (e) {
      return false;
    }
  }

  function shouldShowLoadProgress(contextKey) {
    if (activePanelContextKey !== contextKey || !isPanelOpen()) return false;
    return currentEmails.length === 0 && cachedEmails.length === 0;
  }

  function finishLoadScanForTab(tab) {
    if (tab) activeLoadScanTabs.delete(tab);
  }

  function scheduleLoadScan(tab) {
    if (!tab || tab.closing) return;
    if (activeLoadScanTabs.has(tab) || loadScanTimers.has(tab)) return;
    const timer = setTimeout(() => {
      loadScanTimers.delete(tab);
      performLoadScan(tab);
    }, 400);
    loadScanTimers.set(tab, timer);
  }

  function performLoadScan(tab) {
    if (!tab || tab.closing || !isGmailAnchorTab(tab)) return;

    const browser = tab.linkedBrowser;
    if (browser && !isTabPendingOrDiscarded(tab) && !activeLoadScanTabs.has(tab)) {
      activeLoadScanTabs.add(tab);
      tab.setAttribute('data-live-gmail-was-loaded', 'true');
      loadFrameScript(browser);
    }

    requestAtomScan(tab, { force: false });
  }

  /**
   * Actual loaded document URL — unlike currentURI, this is not satisfied by
   * SessionStore lazy stubs after discard/unload.
   */
  function getBrowserDocumentSpec(browser) {
    if (!browser?.browsingContext) return '';
    try {
      return browser.documentURI?.spec || '';
    } catch (e) {
      return '';
    }
  }

  function isLoadedGmailBrowser(browser) {
    if (!browser) return false;
    try {
      if (!browser.browsingContext) return false;
      if (browser.browsingContext.discarded) return false;
      return getBrowserDocumentSpec(browser).includes(getGmailUrlPattern());
    } catch (e) {
      return false;
    }
  }

  function isTabDiscardedOrUnloaded(tab) {
    if (!tab?.linkedBrowser) return true;
    try {
      if (tab.hasAttribute('discarded')) return true;
      if (tab.linkedBrowser.browsingContext?.discarded) return true;
      return !isLoadedGmailBrowser(tab.linkedBrowser);
    } catch (e) {
      return true;
    }
  }

  function isTabPendingOrDiscarded(tab) {
    if (!tab) return true;
    if (tab.hasAttribute('pending')) return true;
    if (tab.hasAttribute('discarded')) return true;
    if (!tab.linkedPanel) return true;
    return false;
  }

  function findLoadedGmailAnchorTab(contextKey = activePanelContextKey || getPanelContextKey()) {
    if (!gBrowser?.tabs) return null;
    for (const tab of gBrowser.tabs) {
      if (!isGmailAnchorTab(tab, contextKey)) continue;
      if (isTabPendingOrDiscarded(tab)) continue;
      if (isBrowserNavigationComplete(tab.linkedBrowser)) return tab;
    }
    return null;
  }

  function isBrowserNavigationComplete(browser) {
    if (!isLoadedGmailBrowser(browser)) return false;
    try {
      if (browser.webProgress?.isLoadingDocument) return false;
    } catch (e) {}
    return true;
  }

  /**
   * Refresh unread mail for this container (Atom). Works with a discarded tab.
   */
  function scanLoadedGmailEssential(contextKey = activePanelContextKey || getPanelContextKey()) {
    const anchor =
      findLoadedGmailAnchorTab(contextKey) || findGmailAnchorTab(contextKey);
    if (!anchor) return false;
    performLoadScan(anchor);
    return true;
  }

  function checkGmailEssentialLoadState(tab) {
    if (!isGmailAnchorTab(tab)) return;

    const wasLoaded = tab.getAttribute('data-live-gmail-was-loaded') === 'true';
    const isLoaded =
      !isTabPendingOrDiscarded(tab) &&
      tab.linkedBrowser &&
      isLoadedGmailBrowser(tab.linkedBrowser);

    if (isLoaded && !wasLoaded) {
      scheduleLoadScan(tab);
    } else if (!isLoaded && wasLoaded) {
      finishLoadScanForTab(tab);
      tab.removeAttribute('data-live-gmail-was-loaded');
      const contextKey = getPanelContextKey(tab);
      loadScansInFlight.delete(contextKey);
      if (activePanelContextKey === contextKey) {
        scanInProgress = false;
      }
    }
  }

  function attachGmailEssentialLoadListeners(tab) {
    if (tab.hasAttribute('data-live-gmail-load-mon')) return;
    tab.setAttribute('data-live-gmail-load-mon', 'true');

    tab.addEventListener('SSTabRestored', () => {
      debugLog('Gmail essential SSTabRestored');
      scheduleLoadScan(tab);
    });
  }

  function scanAllLoadedGmailEssentials() {
    if (!gBrowser?.tabs) return;
    for (const tab of gBrowser.tabs) {
      if (!isGmailAnchorTab(tab, getPanelContextKey(tab))) continue;
      attachGmailEssentialLoadListeners(tab);
      checkGmailEssentialLoadState(tab);
    }
  }

  /**
   * Returns the path to the cache file in the Firefox profile directory
   */
  function getCacheFilePath() {
    const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
    return PathUtils.join(profileDir, 'live-gmail-cache.json');
  }

  /**
   * Fold legacy workspace:container cache keys into container-only keys.
   * Prefers newer lastScanTs, then the entry with more emails.
   */
  function migrateDiskCacheStore(store) {
    const migrated = {};

    for (const [key, entry] of Object.entries(store || {})) {
      const containerKey = String(getContextContainerId(key));
      const normalized = normalizeDiskCacheEntry(entry);
      const existing = migrated[containerKey];

      if (!existing) {
        migrated[containerKey] = normalized;
        continue;
      }

      const preferNew =
        normalized.lastScanTs > existing.lastScanTs ||
        (normalized.lastScanTs === existing.lastScanTs &&
          normalized.emails.length > existing.emails.length);

      if (preferNew) {
        migrated[containerKey] = normalized;
      }
    }

    return migrated;
  }

  /**
   * Persist all container caches to the profile file
   */
  function saveCacheToPrefs() {
    try {
      persistActiveContextToMemory(activePanelContextKey);

      for (const [key, ctx] of panelContexts.entries()) {
        diskCacheStore[key] = {
          emails: ctx.cachedEmails.slice(0, CONFIG.MAX_EMAILS).map(e => ({
            id: e.id,
            threadId: e.threadId || e.id,
            url: e.url || '',
            from: e.from,
            subject: e.subject,
            snippet: e.snippet || '',
            date: e.date,
            isUnread: e.isUnread
          })),
          lastScanTs: ctx.lastScanTs || 0
        };
      }

      diskCacheStore = migrateDiskCacheStore(diskCacheStore);
      IOUtils.writeUTF8(getCacheFilePath(), JSON.stringify(diskCacheStore)).catch(() => {});
    } catch (e) {}
  }

  /**
   * Restore per-container caches from the profile file on startup
   */
  function loadCacheFromPrefs() {
    try {
      IOUtils.readUTF8(getCacheFilePath()).then(json => {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) {
          // Legacy single-cache format
          diskCacheStore = migrateDiskCacheStore({ '0': parsed });
        } else if (parsed && typeof parsed === 'object') {
          diskCacheStore = migrateDiskCacheStore(parsed);
        }

        for (const storeKey of Object.keys(diskCacheStore)) {
          getOrCreatePanelContext(storeKey);
        }

        const activeKey = getPanelContextKey();
        activatePanelContext(activeKey);

        const count = getOrCreatePanelContext(activeKey).cachedEmails.length;
        debugLog('Restored', count, 'emails for context', activeKey);
        updateEmailDisplay();
      }).catch(() => {
        activatePanelContext(getPanelContextKey());
      });
    } catch (e) {
      activatePanelContext(getPanelContextKey());
    }
  }

  /**
   * Find the Gmail essential or pinned tab in the given container (loaded or discarded)
   */
  function findGmailAnchorTab(contextKey = activePanelContextKey || getPanelContextKey()) {
    const loaded = findLoadedGmailAnchorTab(contextKey);
    if (loaded) return loaded;

    if (!gBrowser?.tabs) return null;
    for (const tab of gBrowser.tabs) {
      if (isGmailAnchorTab(tab, contextKey)) return tab;
    }
    return null;
  }

  /**
   * Close any leftover scanner tabs created by older versions of this mod
   */
  function cleanupScannerTabs() {
    if (!gBrowser?.tabs) return;
    for (const tab of Array.from(gBrowser.tabs)) {
      if (tab.hasAttribute(CONFIG.SCANNER_TAB_ATTR)) {
        try { gBrowser.removeTab(tab, { animate: false }); } catch (e) {}
      }
    }
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ('0000000' + (h >>> 0).toString(36)).slice(-8);
  }

  function gmailAccountSlotFromHints(hints) {
    for (const hint of hints || []) {
      const match = String(hint).match(/\/mail\/u\/(\d+)/);
      if (match) return match[1];
    }
    return '0';
  }

  function getGmailFeedUrl(tab) {
    const slot = gmailAccountSlotFromHints(getTabUrlHints(tab));
    return `https://${getGmailUrlPattern()}/mail/u/${slot}/feed/atom`;
  }

  function normalizeGmailOpenUrl(url) {
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

  function parseGmailAtom(xml, feedUrl) {
    const feed = new DOMParser().parseFromString(xml, 'application/xml');
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

  function cancelAuthPrompt() {
    return {
      QueryInterface: ChromeUtils.generateQI([
        Ci.nsIInterfaceRequestor,
        Ci.nsIAuthPrompt,
        Ci.nsIAuthPrompt2
      ]),
      getInterface(iid) {
        return this.QueryInterface(iid);
      },
      prompt() {
        return false;
      },
      promptUsernameAndPassword() {
        return false;
      },
      promptPassword() {
        return false;
      },
      promptAuth() {
        return false;
      },
      asyncPromptAuth(_channel, callback) {
        try {
          callback.onAuthCancelled(null, false);
        } catch (e) {}
      }
    };
  }

  /**
   * Fetch Gmail's unread Atom feed with the container's cookies.
   * Uses TYPE_SAVEAS_DOWNLOAD so the content principal actually attaches cookies
   * (same pattern as Zen live folders). Auth prompts are cancelled so a 401
   * cannot open Gmail's HTTP Basic dialog.
   */
  function fetchAtomXml(feedUrl, userContextId) {
    const uri = Services.io.newURI(feedUrl);
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {
      userContextId: userContextId || 0
    });
    const channel = NetUtil.newChannel({
      uri,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
      loadingPrincipal: principal,
      triggeringPrincipal: principal,
      securityFlags:
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL |
        Ci.nsILoadInfo.SEC_COOKIES_INCLUDE
    }).QueryInterface(Ci.nsIHttpChannel);
    channel.notificationCallbacks = cancelAuthPrompt();

    return new Promise((resolve, reject) => {
      const chunks = [];
      let totalLength = 0;
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const timer = setTimeout(() => {
        try {
          channel.cancel(Cr.NS_BINDING_ABORTED);
        } catch (e) {}
        finish(reject, new Error('Timeout'));
      }, CONFIG.ATOM_TIMEOUT_MS);

      channel.asyncOpen({
        onStartRequest() {},
        onDataAvailable(request, stream, _offset, count) {
          totalLength += count;
          if (totalLength > CONFIG.ATOM_MAX_BYTES) {
            request.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
            return;
          }
          chunks.push(NetUtil.readInputStream(stream, count));
        },
        onStopRequest(_request, status) {
          if (!Components.isSuccessCode(status)) {
            finish(reject, new Error('Network error'));
            return;
          }
          const bytes = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
          }
          let httpStatus = 0;
          let finalUrl = feedUrl;
          try {
            httpStatus = channel.responseStatus;
          } catch (e) {}
          try {
            finalUrl = channel.URI.spec;
          } catch (e) {}
          finish(resolve, {
            status: httpStatus,
            finalUrl,
            text: new TextDecoder('utf-8').decode(bytes)
          });
        }
      });
    });
  }

  function applyAtomEmails(allEmails, targetKey) {
    const viewKey = activePanelContextKey;
    const restoreView = targetKey && viewKey && targetKey !== viewKey;
    if (targetKey && restoreView) {
      activatePanelContext(targetKey);
    }

    const clickedIds = clickedEmailIds;
    const nextEmails = allEmails.filter((email) => !clickedIds.has(email.id));
    currentEmails = nextEmails;
    cachedEmails = nextEmails.slice();

    const ctx = getOrCreatePanelContext(targetKey);
    ctx.hasScanned = true;
    ctx.lastScanTs = Date.now();
    persistActiveContextToMemory(targetKey);
    saveCacheToPrefs();

    const currentIds = new Set(allEmails.map((email) => email.id));
    for (const clickedId of clickedIds) {
      if (!currentIds.has(clickedId)) clickedIds.delete(clickedId);
    }

    scanContextKey = null;
    loadScansInFlight.delete(targetKey);

    if (restoreView && viewKey) {
      activatePanelContext(viewKey);
    }

    scanInProgress = false;
    if (targetKey === viewKey) {
      hideError();
      updateEmailDisplay();
    }
  }

  async function requestAtomScan(tab, { force = false } = {}) {
    if (!tab) return;
    const contextKey = getPanelContextKey(tab);
    const feedUrl = getGmailFeedUrl(tab);
    const cached = atomMemCache[contextKey];
    if (
      !force &&
      cached &&
      cached.feedUrl === feedUrl &&
      Date.now() - cached.ts < CONFIG.ATOM_CACHE_MS
    ) {
      if (activePanelContextKey !== contextKey || (currentEmails.length === 0 && cachedEmails.length === 0)) {
        applyAtomEmails(cached.emails, contextKey);
      }
      return;
    }

    if (atomInFlight.has(contextKey)) return;
    atomInFlight.add(contextKey);
    scanContextKey = contextKey;
    loadScansInFlight.add(contextKey);

    if (shouldShowLoadProgress(contextKey)) {
      scanInProgress = true;
      updateEmailDisplay();
    }

    try {
      const { status, finalUrl, text } = await fetchAtomXml(
        feedUrl,
        getTabUserContextId(tab)
      );
      if (status === 401 || status === 403) {
        const err = new Error('Sign-in required');
        err.signin = true;
        throw err;
      }
      const head = (text || '').slice(0, 2000);
      if (
        /accounts\.google\.com|ServiceLogin/i.test(finalUrl || '') ||
        /accounts\.google\.com|ServiceLogin/i.test(head)
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
        finalUrl !== feedUrl &&
        !finalUrl.startsWith('https://mail.google.com/mail/')
      ) {
        throw new Error('Feed URL changed');
      }

      const emails = parseGmailAtom(text, feedUrl);
      atomMemCache[contextKey] = { ts: Date.now(), feedUrl, emails };
      debugLog('Atom scan', emails.length, 'unread, context=', contextKey);
      applyAtomEmails(emails, contextKey);
    } catch (e) {
      debugLog('Atom fetch failed', e && e.message ? e.message : e);
      scanInProgress = false;
      loadScansInFlight.delete(contextKey);
      if (scanContextKey === contextKey) scanContextKey = null;
      if (
        e?.signin &&
        activePanelContextKey === contextKey &&
        currentEmails.length === 0 &&
        cachedEmails.length === 0
      ) {
        showError('Sign in to Gmail to see unread mail');
      }
      updateEmailDisplay();
    } finally {
      atomInFlight.delete(contextKey);
      finishLoadScanForTab(tab);
    }
  }

  function onGmailReadStateChanged(tab) {
    if (!tab || !isGmailAnchorTab(tab)) return;
    const contextKey = getPanelContextKey(tab);
    if (readStateTimers.has(contextKey)) {
      clearTimeout(readStateTimers.get(contextKey));
    }
    readStateTimers.set(
      contextKey,
      setTimeout(() => {
        readStateTimers.delete(contextKey);
        requestAtomScan(tab, { force: true });
      }, 400)
    );
  }

  // ============================================
  // Frame script: watch inbox read-state only
  // ============================================

  /**
   * Content script: watch Gmail inbox read-state. Unread mail comes from Atom in chrome.
   */
  const GMAIL_FRAME_SCRIPT = `
(function() {
  'use strict';
  const SCAN_DEBOUNCE_MS = 500;
  let observer = null;
  let scanTimeout = null;
  let lastReadKey = '';
  let DEBUG_ENABLED = false;

  function frameDebugLog(...args) {
    if (DEBUG_ENABLED) content.console.log('[Live Gmail Frame]', ...args);
  }

  function isGmail() {
    try {
      return content.location.hostname === 'mail.google.com';
    } catch (e) {
      return false;
    }
  }

  function readStateKey() {
    const rows = content.document.querySelectorAll('tr.zA, tr[role="row"], div[role="row"]');
    const parts = [];
    for (const row of rows) {
      const unread = row.classList.contains('zE') || row.getAttribute('data-is-read') === 'false';
      const id = row.getAttribute('data-legacy-thread-id') || row.getAttribute('data-thread-id') || '';
      parts.push((unread ? 'u' : 'r') + id);
    }
    return String(rows.length) + ':' + parts.join(',');
  }

  function maybeNotify() {
    if (!isGmail()) return;
    const key = readStateKey();
    if (key === lastReadKey) return;
    lastReadKey = key;
    frameDebugLog('read-state changed');
    sendAsyncMessage('LiveGmail:ReadState', { key: key });
  }

  function setupObserver() {
    if (observer) observer.disconnect();
    const target = content.document.querySelector('div[role="main"]') || content.document.body;
    if (!target) {
      content.setTimeout(setupObserver, 1000);
      return;
    }
    observer = new content.MutationObserver(function() {
      if (scanTimeout) content.clearTimeout(scanTimeout);
      scanTimeout = content.setTimeout(maybeNotify, SCAN_DEBOUNCE_MS);
    });
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  addMessageListener('LiveGmail:SetDebug', function(message) {
    DEBUG_ENABLED = !!(message && message.data && message.data.enabled);
  });

  if (isGmail()) {
    if (content.document.readyState === 'complete') setupObserver();
    else content.addEventListener('load', setupObserver, { once: true });
  }
})();
`;

  /**
   * Load the frame script into a browser
   */
  function loadFrameScript(browser) {
    if (!browser || !browser.messageManager) {
      debugLog('Cannot load frame script: no messageManager');
      return false;
    }
    
    try {
      if (!cachedFrameScriptUrl) {
        cachedFrameScriptUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(GMAIL_FRAME_SCRIPT);
      }
      browser.messageManager.loadFrameScript(cachedFrameScriptUrl, true);
      
      // Send debug state to frame script immediately
      try {
        browser.messageManager.sendAsyncMessage('LiveGmail:SetDebug', {
          enabled: isDebugEnabled()
        });
      } catch (e) {}
      
      debugLog('Frame script loaded into tab');
      return true;
    } catch (e) {
      console.error('[Live Gmail] Error loading frame script:', e);
      return false;
    }
  }

  /**
   * Set up message listeners
   */
  function setupMessageListeners() {
    if (messageListenersRegistered) return;
    
    try {
      const globalMM = Services.mm;
      if (!globalMM) {
        console.warn('[Live Gmail] Global message manager not available');
        return;
      }
      
      globalMM.addMessageListener('LiveGmail:ReadState', (message) => {
        try {
          const sourceTab = getTabForMessageManager(message.target);
          if (sourceTab) onGmailReadStateChanged(sourceTab);
        } catch (e) {
          console.error('[Live Gmail] Error handling read-state:', e);
        }
      });
      
      messageListenersRegistered = true;
      debugLog('Message listeners registered');
    } catch (e) {
      console.error('[Live Gmail] Error setting up message listeners:', e);
    }
  }

  /**
   * Initialize DOM mode
   */
  function initDomMode() {
    debugLog('Initializing Atom unread source');
    setupMessageListeners();
    scanAllLoadedGmailEssentials();
    if (!findLoadedGmailAnchorTab()) {
      const tab = findGmailAnchorTab();
      if (tab) requestAtomScan(tab, { force: false });
    }
    return true;
  }

  /**
   * Create the floating panel as a native XUL popup
   */
  function createPanel() {
    if (panelElement) return;

    panelElement = document.createElementNS(XUL_NS, 'panel');
    panelElement.id = CONFIG.PANEL_ID;
    panelElement.setAttribute('type', 'arrow');
    panelElement.setAttribute('nonnativepopover', 'true');
    panelElement.setAttribute('orient', 'vertical');
    panelElement.setAttribute('side', 'left');
    panelElement.setAttribute('noautohide', 'true');
    panelElement.setAttribute('level', 'top');

    // Header
    const header = document.createElement('div');
    header.className = 'live-gmail-header';
    
    const title = document.createElement('span');
    title.className = 'live-gmail-title';
    
    // Gmail logo
    const gmailLogo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    gmailLogo.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    gmailLogo.setAttribute('width', '16');
    gmailLogo.setAttribute('height', '16');
    gmailLogo.setAttribute('viewBox', '0 0 48 48');
    gmailLogo.style.cssText = 'display:inline-block;vertical-align:middle;margin-right:6px';
    
    const gmailPath1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    gmailPath1.setAttribute('fill', '#4caf50');
    gmailPath1.setAttribute('d', 'M45,16.2l-5,2.75l-5,4.75L35,40h7c1.657,0,3-1.343,3-3V16.2z');
    
    const gmailPath2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    gmailPath2.setAttribute('fill', '#1e88e5');
    gmailPath2.setAttribute('d', 'M3,16.2l3.614,1.71L13,23.7V40H6c-1.657,0-3-1.343-3-3V16.2z');
    
    const gmailPolygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    gmailPolygon.setAttribute('fill', '#e53935');
    gmailPolygon.setAttribute('points', '35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17');
    
    const gmailPath3 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    gmailPath3.setAttribute('fill', '#c62828');
    gmailPath3.setAttribute('d', 'M3,12.298V16.2l10,7.5V11.2L9.876,8.859C9.132,8.301,8.228,8,7.298,8h0C4.924,8,3,9.924,3,12.298z');
    
    const gmailPath4 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    gmailPath4.setAttribute('fill', '#fbc02d');
    gmailPath4.setAttribute('d', 'M45,12.298V16.2l-10,7.5V11.2l3.124-2.341C38.868,8.301,39.772,8,40.702,8h0 C43.076,8,45,9.924,45,12.298z');
    
    gmailLogo.appendChild(gmailPath1);
    gmailLogo.appendChild(gmailPath2);
    gmailLogo.appendChild(gmailPolygon);
    gmailLogo.appendChild(gmailPath3);
    gmailLogo.appendChild(gmailPath4);
    
    title.appendChild(gmailLogo);
    title.appendChild(document.createTextNode('Unread'));
    header.appendChild(title);
    
    // Content
    const content = document.createElement('div');
    content.className = 'live-gmail-content';
    
    const loading = document.createElement('div');
    loading.className = 'live-gmail-loading';
    loading.textContent = 'Loading unread emails...';
    
    const emails = document.createElement('div');
    emails.className = 'live-gmail-emails';
    
    const error = document.createElement('div');
    error.className = 'live-gmail-error';
    error.style.display = 'none';
    
    content.appendChild(loading);
    content.appendChild(emails);
    content.appendChild(error);

    // Wrap all HTML content in a single div so layout is handled by the HTML
    // engine, completely independent of XUL's box model on the <panel> host.
    const wrapper = document.createElement('div');
    wrapper.className = 'live-gmail-wrapper';
    const composeButton = document.createElement('button');
    composeButton.type = 'button';
    composeButton.className = 'live-gmail-compose-btn';
    composeButton.setAttribute('aria-label', 'New message');
    composeButton.title = 'New message';
    composeButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>`;
    composeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openGmailCompose();
    });

    wrapper.appendChild(header);
    wrapper.appendChild(content);
    wrapper.appendChild(composeButton);

    panelElement.appendChild(wrapper);
    document.documentElement.appendChild(panelElement);
    
    panelElement.addEventListener('mouseenter', () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    });

    panelElement.addEventListener('mouseleave', scheduleHide);
    panelElement.addEventListener('popuphidden', unpinCompactChrome);

    updatePanelTheme();
    watchThemeChanges();
  }

  /**
   * Sync panel theme — light-dark() is unreliable on controls inside XUL panels
   */
  function updatePanelTheme() {
    if (!panelElement) return;

    let isDark = false;

    try {
      const zenDark = document.documentElement.getAttribute('zen-should-be-dark-mode');
      if (zenDark === 'true') {
        isDark = true;
      } else if (zenDark === 'false') {
        isDark = false;
      } else if (typeof Services !== 'undefined' && Services.prefs) {
        const zenScheme = Services.prefs.getIntPref('zen.view.window.scheme', 2);
        if (zenScheme === 0) isDark = true;
        else if (zenScheme === 1) isDark = false;
        else isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      }
    } catch (e) {
      isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    }

    if (isDark) {
      panelElement.setAttribute('data-theme', 'dark');
    } else {
      panelElement.removeAttribute('data-theme');
    }
  }

  function watchThemeChanges() {
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updatePanelTheme);
    }

    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        Services.prefs.addObserver('zen.view.window.scheme', updatePanelTheme, false);
      }
    } catch (e) {}

    const observer = new MutationObserver(updatePanelTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['zen-should-be-dark-mode', 'data-theme']
    });
  }

  /**
   * Monitor tabs for Gmail
   */
  function setupTabMonitoring() {
    updateGmailTabs();

    if (gBrowser && gBrowser.tabContainer) {
      gBrowser.tabContainer.addEventListener('TabAttrModified', handleTabChange);
      gBrowser.tabContainer.addEventListener('TabOpen', handleTabChange);
      gBrowser.tabContainer.addEventListener('TabClose', handleTabChange);
      gBrowser.tabContainer.addEventListener('TabPinned', handleTabChange);
      gBrowser.tabContainer.addEventListener('TabUnpinned', handleTabChange);
    }

    setupHoverDelegation();
    setupWorkspaceMonitoring();

    // Debounce for MutationObserver only — rapid tab attribute changes (favicon,
    // loading spinner, title) would otherwise rebuild gmailTabs on every tick.
    // Explicit tab events (TabOpen, TabClose, TabAttrModified) remain immediate.
    let updateGmailTabsTimer = null;
    const debouncedUpdateGmailTabs = () => {
      if (updateGmailTabsTimer) clearTimeout(updateGmailTabsTimer);
      updateGmailTabsTimer = setTimeout(updateGmailTabs, 150);
    };

    const observer = new MutationObserver(debouncedUpdateGmailTabs);

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


  /**
   * React when the active container changes (workspace switch may change container).
   */
  function setupWorkspaceMonitoring() {
    window.addEventListener('ZenWorkspacesUIUpdate', () => onWorkspaceOrContainerChanged(false));

    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        Services.prefs.addObserver(
          'zen.workspaces.separate-essentials',
          () => onWorkspaceOrContainerChanged(true),
          false
        );
      }
    } catch (e) {}
  }

  /**
   * Attach hover listeners to a single essential or pinned tab (once).
   */
  function attachHoverListener(tab) {
    if (!tab || tab.hasAttribute('data-live-gmail-listener')) return;
    tab.addEventListener('mouseenter', handleTabHover);
    tab.addEventListener('mouseleave', handleTabLeave);
    tab.setAttribute('data-live-gmail-listener', 'true');
  }

  /**
   * Update Gmail tabs list
   */
  function updateGmailTabs() {
    gmailTabs.clear();
    
    if (!gBrowser || !gBrowser.tabs) return;

    const pattern = getGmailUrlPattern();

    for (const tab of gBrowser.tabs) {
      if (tab.hasAttribute('zen-essential') || (tab.pinned && tabMatchesGmailPattern(tab))) {
        attachHoverListener(tab);
      }

      if (!isGmailAnchorTab(tab, getPanelContextKey(tab))) continue;

      attachGmailEssentialLoadListeners(tab);
      checkGmailEssentialLoadState(tab);

      const hints = getTabUrlHints(tab);
      const tabUrl = hints.find((h) => h.includes(pattern)) || hints[0] || '';
      gmailTabs.set(tab, tabUrl);
    }

    // Cold start: tabs may appear in these strips before gBrowser.tabs is complete.
    for (const tab of document.querySelectorAll(
      '#zen-essentials .tabbrowser-tab[zen-essential], .zen-workspace-pinned-tabs-section .tabbrowser-tab[pinned]'
    )) {
      if (tab.hasAttribute('zen-essential') || tabMatchesGmailPattern(tab)) {
        attachHoverListener(tab);
      }
    }
  }

  /**
   * Get Gmail URL pattern
   */
  function getGmailUrlPattern() {
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        return Services.prefs.getStringPref(CONFIG.GMAIL_URL_PREF, CONFIG.DEFAULT_GMAIL_URL);
      }
    } catch (e) {}
    return CONFIG.DEFAULT_GMAIL_URL;
  }

  /**
   * Fallback hover delegation for essentials and pinned tabs, for cases where the
   * per-tab mouseenter listener in updateGmailTabs was not yet attached.
   */
  function setupHoverDelegation() {
    const onHover = (event) => {
      const tab = event.target.closest?.('.tabbrowser-tab');
      if (!tab || !isGmailAnchorTab(tab, getPanelContextKey(tab))) return;
      scheduleShow(tab);
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

  /**
   * Handle tab hover
   */
  function handleTabHover(event) {
    const tab = event.currentTarget;
    if (!isGmailAnchorTab(tab)) {
      // Use the delayed hide rather than an instant one so the grace period
      // applies regardless of which side the cursor exits the Gmail tab from.
      // If the cursor continues on to the panel, its mouseenter cancels this.
      cancelShowTimer();
      scheduleHide();
      return;
    }

    // Do NOT set hoveredTab here — showPanel sets it after computing context.
    scheduleShow(tab);
  }

  /**
   * Handle tab leave
   */
  function handleTabLeave() {
    cancelShowTimer();
    scheduleHide();
  }

  /**
   * Check if there is at least one Gmail tab open
   */
  function hasGmailTab() {
    try {
      const pattern = getGmailUrlPattern();
      
      // Check tabs via browsers
      if (gBrowser && gBrowser.browsers) {
        for (const browser of gBrowser.browsers) {
          try {
            const spec = browser.currentURI ? browser.currentURI.spec : '';
            if (spec && spec.includes(pattern)) {
              return true;
            }
          } catch (e) {
            continue;
          }
        }
      }
      
      return false;
    } catch (e) {
      console.warn('[Live Gmail] hasGmailTab check failed:', e);
      return false;
    }
  }

  /**
   * Cancel a pending panel open triggered by hover.
   */
  function cancelShowTimer() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    pendingShowTab = null;
  }

  /**
   * Open the panel after the user has hovered a Gmail essential or pinned tab long enough.
   * If the panel is already open, switch context immediately.
   */
  function scheduleShow(tab) {
    if (!tab || !isGmailAnchorTab(tab, getPanelContextKey(tab))) return;

    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

    if (isPanelOpen()) {
      cancelShowTimer();
      showPanel(tab);
      return;
    }

    if (pendingShowTab === tab && showTimer) return;

    cancelShowTimer();
    pendingShowTab = tab;

    showTimer = setTimeout(() => {
      showTimer = null;
      pendingShowTab = null;
      if (!tab.matches(':hover')) return;
      showPanel(tab);
    }, CONFIG.HOVER_DELAY_MS);
  }

  /**
   * Compact mode ignores [open] on <tab>. Pin a descendant instead, the same
   * way zen-folder-tabs-popup keeps the toolbox expanded.
   */
  function getCompactPinTarget(tab) {
    if (tab) {
      const inner = tab.querySelector('.tab-content, .tab-icon-stack');
      if (inner) return inner;
      const strip = tab.closest(
        '#zen-essentials, .zen-essentials-container, .zen-workspace-pinned-tabs-section'
      );
      if (strip) return strip;
    }
    return document.getElementById('zen-essentials')
      || document.querySelector('.zen-essentials-container')
      || document.querySelector('.zen-workspace-pinned-tabs-section');
  }

  function pinCompactChrome(tab) {
    const target = getCompactPinTarget(tab);
    if (compactPinTarget && compactPinTarget !== target) {
      unpinCompactChrome();
    }
    if (!target) return;
    compactPinTarget = target;
    target.setAttribute('open', 'true');
    target.setAttribute('data-live-gmail-compact-pin', 'true');
  }

  function unpinCompactChrome() {
    if (!compactPinTarget) return;
    if (compactPinTarget.hasAttribute('data-live-gmail-compact-pin')) {
      compactPinTarget.removeAttribute('open');
      compactPinTarget.removeAttribute('data-live-gmail-compact-pin');
    }
    compactPinTarget = null;
  }

  function isPinnedGmailTab(tab) {
    return !!(tab?.pinned && !tab.hasAttribute('zen-essential'));
  }

  /**
   * Same placement as zen-folder-tabs-popup: beside the pinned row, not below it.
   */
  function getFolderStylePopupOptions() {
    const isRightSide = !!window.gZenVerticalTabsManager?._prefsRightSide;
    const rows = Math.min(
      Math.max((currentEmails.length || cachedEmails.length || 0) + 1, 1),
      6
    );
    return {
      position: isRightSide ? 'topleft topright' : 'topright topleft',
      x: isRightSide ? -10 : 10,
      y: (rows * 48) / -2
    };
  }

  function getPinnedPopupAnchor(tab) {
    return tab?.querySelector('.tab-content, .tab-icon-stack') || tab;
  }

  function openGmailPanel(tab) {
    if (!panelElement) return;

    if (isPinnedGmailTab(tab)) {
      const isRightSide = !!window.gZenVerticalTabsManager?._prefsRightSide;
      panelElement.setAttribute('side', isRightSide ? 'right' : 'left');
      panelElement.openPopup(getPinnedPopupAnchor(tab) || document.documentElement, getFolderStylePopupOptions());
      return;
    }

    panelElement.setAttribute('side', 'left');
    const tabHeight = tab ? tab.getBoundingClientRect().height : 0;
    panelElement.openPopup(tab || document.documentElement, 'end_before', 4, tabHeight);
  }

  /**
   * Show panel
   */
  function showPanel(tab) {
    const contextKey = getPanelContextKey(tab);

    activatePanelContext(contextKey);

    const isAnchorHover = tab && isGmailAnchorTab(tab, contextKey);

    if (tab && isEssentialOrPinnedTab(tab) && !isAnchorHover) {
      hidePanel();
      return;
    }

    if (!isAnchorHover) {
      const hasCachedData = cachedEmails.length > 0 || currentEmails.length > 0;
      if (!hasCachedData && !hasGmailTab()) {
        debugLog('No Gmail hover, tab, or cached data; not showing panel');
        hidePanel();
        return;
      }
    }

    hoveredTab = tab;

    if (!panelElement) createPanel();
    updatePanelTheme();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

    pinCompactChrome(tab);
    openGmailPanel(tab);
    updateEmailDisplay();
    if (isAnchorHover) requestAtomScan(tab, { force: false });
  }

  /**
   * Schedule panel hide after a short delay, cancelling if the cursor returns
   * to either the tab or the panel in time. This prevents flicker when the
   * cursor briefly crosses the panel boundary on entry from the right.
   * Extra grace time while a load scan is in progress.
   */
  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    const delayMs = scanInProgress ? 350 : 200;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (hoveredTab?.matches(':hover')) return;
      if (panelElement?.matches(':hover')) return;
      hidePanel();
    }, delayMs);
  }

  /**
   * Hide panel
   */
  function hidePanel() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    cancelShowTimer();
    persistActiveContextToMemory(activePanelContextKey);
    unpinCompactChrome();
    if (panelElement) panelElement.hidePopup();
    hoveredTab = null;
  }

  /**
   * Handle tab changes
   */
  function handleTabChange() {
    updateGmailTabs();
  }

  /**
   * Update panel content
   */
  function updatePanelContent() {
    if (!panelElement) return;
    
    const content = panelElement.querySelector('.live-gmail-content');
    if (!content) return;
    
    content.innerHTML = `
        <div class="live-gmail-loading">Loading unread emails...</div>
        <div class="live-gmail-emails"></div>
        <div class="live-gmail-error" style="display: none;"></div>
      `;
      updateEmailDisplay();
  }

  /**
   * Update email display
   */
  function updateEmailDisplay() {
    if (!panelElement) return;

    const emailsContainer = panelElement.querySelector('.live-gmail-emails');
    const loadingContainer = panelElement.querySelector('.live-gmail-loading');
    const composeBtn = panelElement.querySelector('.live-gmail-compose-btn');

    if (!emailsContainer) return;

    // Always prefer showing cached data over a blank loading spinner
    const emailsToShow = currentEmails.length > 0
      ? currentEmails
      : cachedEmails;

    const setComposeVisible = (visible) => {
      if (composeBtn) composeBtn.style.display = visible ? '' : 'none';
    };

    // Show loading while a load scan is in flight and there is nothing to display yet
    const awaitingFirstScan = loadScansInFlight.has(activePanelContextKey);
    if ((scanInProgress || awaitingFirstScan) && emailsToShow.length === 0) {
      if (loadingContainer) loadingContainer.style.display = 'block';
      emailsContainer.innerHTML = '';
      setComposeVisible(false);
      return;
    }

    if (loadingContainer) loadingContainer.style.display = 'none';
    emailsContainer.innerHTML = '';

    if (emailsToShow.length === 0) {
      const contextAnchor = findGmailAnchorTab(activePanelContextKey);
      const isUnloaded = !contextAnchor || isTabDiscardedOrUnloaded(contextAnchor);
      const hasScanned = getOrCreatePanelContext(activePanelContextKey).hasScanned;
      const emptyMessage = isUnloaded && !hasScanned
        ? 'Sign in to Gmail to see unread mail'
        : 'No unread emails';
      emailsContainer.innerHTML = `<div class="live-gmail-empty">${emptyMessage}</div>`;
      setComposeVisible(false);
      return;
    }

    setComposeVisible(true);

    emailsToShow.forEach(email => {
      const el = document.createElement('div');
      el.className = 'live-gmail-email-item';
      if (email.isUnread) el.classList.add('live-gmail-unread');
      
      const from = email.from.replace(/<[^>]*>/g, '').trim();
      const subject = email.subject || '(No subject)';
      const snippet = email.snippet || '';
      const date = formatDate(email.date);

      el.innerHTML = `
        <div class="live-gmail-email-header">
          <span class="live-gmail-email-from">${escapeHtml(from)}</span>
          <span class="live-gmail-email-date">${escapeHtml(date)}</span>
        </div>
        <div class="live-gmail-email-subject">${escapeHtml(subject)}</div>
        <div class="live-gmail-email-snippet-wrap"><div class="live-gmail-email-snippet">${escapeHtml(snippet)}</div></div>
      `;

      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const targetTab = (hoveredTab && isGmailAnchorTab(hoveredTab))
          ? hoveredTab
          : resolveGmailTargetTab(activePanelContextKey);

        if (!targetTab || !gBrowser) return;

        if (gBrowser.selectedTab !== targetTab) {
          gBrowser.selectedTab = targetTab;
        }

        const gmailUrl = normalizeGmailOpenUrl(email.url) || getGmailInboxUrl();
        debugLog('Opening email', gmailUrl);

        try {
          const browser = targetTab.linkedBrowser;
          if (browser?.fixupAndLoadURIString) {
            browser.fixupAndLoadURIString(gmailUrl, {
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
            });
          }
        } catch (err) {
          console.warn('[Live Gmail] Could not open email:', err);
        }
        
        // Track clicked email by its stable ID
        clickedEmailIds.add(email.id);
        
        // Remove from current list
        const idx = currentEmails.findIndex(e => e.id === email.id);
        if (idx !== -1) {
          currentEmails.splice(idx, 1);
        }
        
        // Also remove from cache
        const cacheIdx = cachedEmails.findIndex(e => e.id === email.id);
        if (cacheIdx !== -1) {
          cachedEmails.splice(cacheIdx, 1);
        }
        
        updateEmailDisplay();

        // Rescan loaded tabs so the panel stays fresh (no wake needed — user is navigating to Gmail)
        scanLoadedGmailEssential(activePanelContextKey);

        hidePanel();
      });

      emailsContainer.appendChild(el);
    });
  }

  /**
   * Show error
   */
  function showError(message) {
    if (!panelElement) return;
    const el = panelElement.querySelector('.live-gmail-error');
    const loading = panelElement.querySelector('.live-gmail-loading');
    if (el) { el.textContent = message; el.style.display = 'block'; }
    if (loading) loading.style.display = 'none';
  }

  /**
   * Hide error
   */
  function hideError() {
    if (!panelElement) return;
    const el = panelElement.querySelector('.live-gmail-error');
    if (el) el.style.display = 'none';
  }

  /**
   * Format date - always returns "Mon DD" format
   */
  function formatDate(dateString) {
    if (!dateString) return '';
    
    try {
      // First, strip any trailing time tokens like "11/01" or "12:30"
      let cleanDate = dateString.trim();
      const timeMatch = cleanDate.match(/^(.+?)\s+\d{1,2}[\/:]\d{1,2}/);
      if (timeMatch) {
        cleanDate = timeMatch[1].trim();
      }
      
      // Try parsing the cleaned date
      let parsed = Date.parse(cleanDate);
      
      
      // If we got a valid date, format it
      if (!Number.isNaN(parsed)) {
        const date = new Date(parsed);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
      
      // Last resort: try to extract just month and day from the string
      const monthDayMatch = cleanDate.match(/(\w+)\s+(\d{1,2})/i);
      if (monthDayMatch) {
        return monthDayMatch[1] + ' ' + monthDayMatch[2];
      }
      
      return cleanDate;
    } catch (e) {
      return dateString;
    }
  }

  /**
   * Escape HTML
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  // Initialization
  // ============================================

  const UC_LIVE_GMAIL = {
    init: function() {
      if (!window.gBrowser) {
        if (isDebugEnabled()) console.warn('LiveGmail: gBrowser not ready, retrying...');
        setTimeout(() => this.init(), 200);
        return;
      }

      debugLog('Initializing UC_LIVE_GMAIL...');

      loadCacheFromPrefs();
      cleanupScannerTabs();
      createPanel();
      setupTabMonitoring();
      initDomMode();
      updatePanelContent();
      
      debugLog('Initialized successfully');
    }
  };

  // Debug API — context()/contexts() return Firefox container ids ("0", "2", …)
  window.liveGmailDebug = {
    showPanel: () => {
      if (panelElement) {
        pinCompactChrome(hoveredTab);
        panelElement.openPopup(document.documentElement, 'overlap', 100, 100);
      }
    },
    hidePanel,
    scan: () => {
      const tab = findGmailAnchorTab();
      if (tab) requestAtomScan(tab, { force: true });
    },
    rescan: () => scanAllLoadedGmailEssentials(),
    emails: () => currentEmails,
    context: () => activePanelContextKey,
    contexts: () => [...panelContexts.keys()],
    reInit: () => UC_LIVE_GMAIL.init()
  };

  if (document.readyState === 'complete') {
    UC_LIVE_GMAIL.init();
  } else {
    window.addEventListener('DOMContentLoaded', () => UC_LIVE_GMAIL.init());
  }

})();
