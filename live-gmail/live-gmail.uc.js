// ==UserScript==
// @name           Live Gmail Panel
// @description    Displays Gmail inbox emails in a floating panel when hovering over Gmail essential tabs
// @author         Bxth
// @version        3.4.0
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
    SCANNER_TAB_ATTR: 'data-live-gmail-scanner'
  };

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
  let lastLogTs = 0;
  let scanInProgress = false;
  let hideTimer = null;
  let cachedFrameScriptUrl = null;
  let loadScanTimers = new WeakMap();
  let loadScansInFlight = new Set();
  let activeLoadScanTabs = new WeakSet();
  let activePanelContextKey = null; // `${workspaceUuid}:${containerId}`
  let scanContextKey = null; // context key for an in-flight hover scan
  let panelContexts = new Map(); // contextKey -> { currentEmails, cachedEmails, clickedEmailIds }
  let diskCacheStore = {}; // persisted cache keyed by contextKey

  /**
   * Active Zen workspace uuid (space id)
   */
  function getActiveWorkspaceId() {
    try {
      return window.gZenWorkspaces?.getActiveWorkspaceFromCache?.()?.uuid || 'default';
    } catch (e) {}
    return 'default';
  }

  /**
   * Panel cache key: one panel state per workspace + container combination.
   * Essentials are shared across workspaces but each space/container may map to a different Gmail account.
   */
  function getPanelContextKey(tab = hoveredTab) {
    const workspaceId = getActiveWorkspaceId();
    let containerId = 0;

    if (window.gZenWorkspaces?.containerSpecificEssentials) {
      if (tab?.hasAttribute?.('zen-essential')) {
        containerId = parseInt(tab.getAttribute('usercontextid') || '0', 10);
      } else {
        const active = window.gZenWorkspaces?.getActiveWorkspaceFromCache?.();
        containerId = typeof active?.containerTabId === 'number' ? active.containerTabId : 0;
      }
    }

    return `${workspaceId}:${containerId}`;
  }

  function getContextContainerId(contextKey) {
    return parseInt(String(contextKey).split(':')[1] || '0', 10);
  }

  /**
   * Whether an essential belongs to the container portion of a panel context key.
   */
  function tabMatchesContainerContext(tab, contextKey) {
    if (!tab?.hasAttribute('zen-essential')) return false;
    if (!window.gZenWorkspaces?.containerSpecificEssentials) return true;

    const containerId = getContextContainerId(contextKey);
    if (!containerId) return true;

    const tabContainerId = parseInt(tab.getAttribute('usercontextid') || '0', 10);
    return tabContainerId === containerId;
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
    if (!panelContexts.has(key)) {
      const entry = Object.prototype.hasOwnProperty.call(diskCacheStore, key)
        ? normalizeDiskCacheEntry(diskCacheStore[key])
        : { emails: [], lastScanTs: 0 };
      panelContexts.set(key, {
        currentEmails: [],
        cachedEmails: entry.emails.slice(),
        clickedEmailIds: new Set(),
        hasScanned: Object.prototype.hasOwnProperty.call(diskCacheStore, key),
        lastScanTs: entry.lastScanTs
      });
    }
    return panelContexts.get(key);
  }

  function persistActiveContextToMemory(key = activePanelContextKey) {
    if (!key) return;
    const ctx = getOrCreatePanelContext(key);
    ctx.currentEmails = currentEmails;
    ctx.cachedEmails = cachedEmails;
  }

  /**
   * Switch the in-memory email state to a workspace/container context.
   */
  function activatePanelContext(key) {
    if (!key) return;

    if (key !== activePanelContextKey) {
      persistActiveContextToMemory(activePanelContextKey);
      activePanelContextKey = key;
      debugLog('Panel context:', key);
    }

    const ctx = getOrCreatePanelContext(key);
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
   * Whether a tab is a live scan source (loaded Gmail document).
   */
  function isLiveGmailScanSource(tab) {
    if (!tab?.linkedBrowser) return false;
    if (isTabPendingOrDiscarded(tab)) return false;
    return isLoadedGmailBrowser(tab.linkedBrowser);
  }

  function onWorkspaceOrContainerChanged() {
    hidePanel();
    scanInProgress = false;
    scanContextKey = null;
    loadScansInFlight.clear();
    activatePanelContext(getPanelContextKey());
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
   * Check if a tab is a Gmail essential tab for the given workspace/container context
   */
  function isGmailEssentialTab(tab, contextKey = getPanelContextKey(tab)) {
    if (!tab || !tab.hasAttribute('zen-essential')) return false;
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
    if (hoveredTab && isGmailEssentialTab(hoveredTab, contextKey)) {
      return hoveredTab;
    }

    const existing = findGmailEssentialTab(contextKey);
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

      const tab = gBrowser.addTab(gmailUrl, addTabArgs);
      if (tab && !tab.hasAttribute('zen-essential')) {
        if (window.gZenPinnedTabManager?.addToEssentials) {
          window.gZenPinnedTabManager.addToEssentials(tab);
        } else {
          tab.setAttribute('zen-essential', 'true');
        }
      }
      return tab;
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
    if (!tab || tab.closing || !isGmailEssentialTab(tab)) return;
    if (isTabPendingOrDiscarded(tab)) return;
    if (activeLoadScanTabs.has(tab)) return;

    const browser = tab.linkedBrowser;
    if (!browser) return;

    activeLoadScanTabs.add(tab);
    tab.setAttribute('data-live-gmail-was-loaded', 'true');

    const contextKey = getPanelContextKey(tab);
    scanContextKey = contextKey;
    loadScansInFlight.add(contextKey);

    if (shouldShowLoadProgress(contextKey)) {
      scanInProgress = true;
      updateEmailDisplay();
    }

    startLoadScanWhenReady(tab);
  }

  /**
   * Wait until the Gmail document has finished loading, then scan the inbox.
   */
  function startLoadScanWhenReady(tab) {
    const browser = tab?.linkedBrowser;
    if (!browser) return;

    const contextKey = getPanelContextKey(tab);
    let attempts = 0;
    let pollTimer = null;
    let scanStarted = false;

    const cleanup = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      try {
        browser.removeEventListener('load', onLoad);
      } catch (e) {}
    };

    const abortLoadScan = (reason) => {
      if (scanStarted) return;
      cleanup();
      debugLog('startLoadScanWhenReady:', reason);
      finishLoadScanForTab(tab);
      loadScansInFlight.delete(contextKey);
      scanInProgress = false;
      tab.removeAttribute('data-live-gmail-was-loaded');
      updateEmailDisplay();
    };

    const tryScan = () => {
      if (scanStarted) return;
      if (tab.closing || isTabPendingOrDiscarded(tab)) {
        abortLoadScan('tab unloaded');
        return;
      }
      if (!isLoadedGmailBrowser(browser)) {
        if (++attempts >= 150) {
          abortLoadScan('timed out waiting for Gmail document');
          return;
        }
        pollTimer = setTimeout(tryScan, 400);
        return;
      }
      if (!isBrowserNavigationComplete(browser)) {
        if (++attempts >= 150) {
          abortLoadScan('timed out waiting for navigation');
          return;
        }
        pollTimer = setTimeout(tryScan, 400);
        return;
      }

      scanStarted = true;
      cleanup();
      if (!scanBrowserWhenReady(browser, tab)) {
        finishLoadScanForTab(tab);
        loadScansInFlight.delete(contextKey);
        scanInProgress = false;
        tab.removeAttribute('data-live-gmail-was-loaded');
        updateEmailDisplay();
      }
    };

    const onLoad = () => {
      debugLog('startLoadScanWhenReady: browser load');
      tryScan();
    };

    browser.addEventListener('load', onLoad);
    tryScan();
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

  function findLoadedGmailEssentialTab(contextKey = activePanelContextKey || getPanelContextKey()) {
    if (!gBrowser?.tabs) return null;
    for (const tab of gBrowser.tabs) {
      if (!isGmailEssentialTab(tab, contextKey)) continue;
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

  function scanBrowserWhenReady(browser, tab) {
    if (!browser?.messageManager) return false;

    let finished = false;
    let pollTimer = null;
    let attempts = 0;

    const isStale = () =>
      !tab || tab.closing || isTabPendingOrDiscarded(tab) || !browser.messageManager;

    const cleanup = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      Services.mm.removeMessageListener('LiveGmail:ReadyStatus', onReady);
    };

    const finishWithError = () => {
      if (finished) return;
      finished = true;
      cleanup();
      debugLog('scanBrowserWhenReady: timed out or stale');
      if (tab) {
        finishLoadScanForTab(tab);
        loadScansInFlight.delete(getPanelContextKey(tab));
        tab.removeAttribute('data-live-gmail-was-loaded');
      }
      scanInProgress = false;
      updateEmailDisplay();
    };

    const sendScan = () => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        browser.messageManager.sendAsyncMessage('LiveGmail:RequestScan', {});
        debugLog('Sent RequestScan (inbox ready)');
      } catch (e) {
        console.warn('[Live Gmail] Could not send RequestScan:', e);
        if (tab) {
          finishLoadScanForTab(tab);
          loadScansInFlight.delete(getPanelContextKey(tab));
          tab.removeAttribute('data-live-gmail-was-loaded');
        }
        scanInProgress = false;
        updateEmailDisplay();
      }
    };

    const onReady = (message) => {
      if (finished || isStale()) return;
      if (!message.data?.inboxReady) return;
      debugLog('Inbox ready, rows=', message.data.rows);
      sendScan();
    };

    Services.mm.addMessageListener('LiveGmail:ReadyStatus', onReady);

    const poll = () => {
      if (finished) return;
      if (isStale()) {
        finishWithError();
        return;
      }
      try {
        browser.messageManager.sendAsyncMessage('LiveGmail:CheckReady', {});
      } catch (e) {}
      if (++attempts >= 150) {
        finishWithError();
        return;
      }
      pollTimer = setTimeout(poll, 400);
    };

    loadFrameScript(browser);
    poll();
    return true;
  }

  /**
   * Request a load scan on an already-loaded Gmail essential (e.g. after opening an email).
   */
  function scanLoadedGmailEssential(contextKey = activePanelContextKey || getPanelContextKey()) {
    const essential = findLoadedGmailEssentialTab(contextKey);
    if (!essential?.linkedBrowser) return false;
    performLoadScan(essential);
    return true;
  }

  function checkGmailEssentialLoadState(tab) {
    if (!isGmailEssentialTab(tab)) return;

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
      if (!isGmailEssentialTab(tab)) continue;
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
   * Persist all workspace/container caches to the profile file
   */
  function saveCacheToPrefs() {
    try {
      persistActiveContextToMemory(activePanelContextKey);

      for (const [key, ctx] of panelContexts.entries()) {
        diskCacheStore[key] = {
          emails: ctx.cachedEmails.slice(0, CONFIG.MAX_EMAILS).map(e => ({
            id: e.id,
            from: e.from,
            subject: e.subject,
            snippet: (e.snippet || '').substring(0, 60),
            date: e.date,
            isUnread: e.isUnread
          })),
          lastScanTs: ctx.lastScanTs || 0
        };
      }

      IOUtils.writeUTF8(getCacheFilePath(), JSON.stringify(diskCacheStore)).catch(() => {});
    } catch (e) {}
  }

  /**
   * Restore per-context caches from the profile file on startup
   */
  function loadCacheFromPrefs() {
    try {
      IOUtils.readUTF8(getCacheFilePath()).then(json => {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed)) {
          // Legacy single-cache format
          diskCacheStore = { 'default:0': parsed };
        } else if (parsed && typeof parsed === 'object') {
          diskCacheStore = parsed;
        }

        const activeKey = getPanelContextKey();
        activatePanelContext(activeKey);

        const count = getOrCreatePanelContext(activeKey).cachedEmails.length;
        if (count > 0) {
          debugLog('Restored', count, 'emails for context', activeKey);
          updateEmailDisplay();
        }
      }).catch(() => {
        activatePanelContext(getPanelContextKey());
      });
    } catch (e) {
      activatePanelContext(getPanelContextKey());
    }
  }

  /**
   * Find the Gmail essential tab in the active container (loaded or discarded)
   */
  function findGmailEssentialTab(contextKey = activePanelContextKey || getPanelContextKey()) {
    const loaded = findLoadedGmailEssentialTab(contextKey);
    if (loaded) return loaded;

    if (!gBrowser?.tabs) return null;
    for (const tab of gBrowser.tabs) {
      if (isGmailEssentialTab(tab, contextKey)) return tab;
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

  // ============================================
  // Frame Script for Gmail DOM Parsing
  // ============================================

  /**
   * The content script that runs in Gmail tabs to parse the inbox DOM.
   * This is injected via messageManager.loadFrameScript as a data: URL.
   */
  const GMAIL_FRAME_SCRIPT = `
(function() {
  'use strict';
  
  const MAX_EMAILS = 20;
  const SCAN_DEBOUNCE_MS = 500;
  let scanTimeout = null;
  let observer = null;
  let lastScanResult = null;
  let lastDebugLog = 0;
  const DEBUG_INTERVAL_MS = 5000;
  let cachedRowSelector = null;
  
  // Debug logging function (controlled by parent via message)
  let DEBUG_ENABLED = false;
  function frameDebugLog(...args) {
    if (DEBUG_ENABLED) {
      content.console.log('[Live Gmail Frame]', ...args);
    }
  }
  
  frameDebugLog('Script loaded on', content.location.href);
  
  /**
   * Check if current page is Gmail inbox
   */
  function isGmailInbox() {
    return content.location.href.includes('mail.google.com');
  }
  
  /**
   * Extract thread ID from a Gmail row element
   */
  function extractThreadId(row) {
    const attrs = ['data-legacy-thread-id', 'data-thread-id', 'data-legacy-message-id', 
                   'data-message-id', 'data-id', 'data-uid', 'data-internalid'];
    for (const attr of attrs) {
      const val = row.getAttribute(attr);
      if (val) return val;
    }
    
    // Try to find link with thread hash
    const links = row.querySelectorAll('a[href*="#inbox/"], a[href*="#all/"], a[href*="#sent/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/#(?:inbox|all|sent|starred|label)\\/([a-zA-Z0-9]+)/);
      if (match && match[1]) return match[1];
    }
    
    if (row.id && row.id.length > 5) return row.id;
    return null;
  }

  /**
   * Extract a Gmail URL/hash from a row
   */
  function extractGmailUrl(row) {
    if (row.tagName === 'A' && row.href) return row.href;
    
    const link = row.querySelector('a[href*="#inbox/"], a[href*="#all/"], a[href*="#sent/"], a[href*="#label/"]');
    if (link) return link.href || link.getAttribute('href') || '';
    
    const anyLink = row.querySelector('a[href*="#"]');
    if (anyLink) return anyLink.getAttribute('href') || '';
    return '';
  }
  
  /**
   * Check if a row represents an unread email
   */
  function isUnread(row) {
    const cls = row.classList;
    if (cls.contains('zE')) return true;
    if (cls.contains('unread')) return true;
    if (cls.contains('yO')) return false;
    if (row.getAttribute('data-is-read') === 'false') return true;

    const ariaLabel = (row.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('unread') || ariaLabel.includes('non lu') || 
        ariaLabel.includes('no leído') || ariaLabel.includes('nicht gelesen')) return true;

    const boldElements = row.querySelectorAll('b, strong');
    if (boldElements.length > 0) return true;

    return false;
  }
  
  /**
   * Extract sender name from row
   */
  function extractSender(row) {
    const emailSpan = row.querySelector('span[email]');
    if (emailSpan) return emailSpan.getAttribute('name') || emailSpan.textContent.trim();
    
    const selectors = ['td.yX span.yP', 'td.yX span.zF', 'span.bA4 span', 'td.xY span'];
    for (const sel of selectors) {
      const el = row.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    
    const bold = row.querySelector('b, strong');
    if (bold && bold.textContent.trim()) return bold.textContent.trim();
    return 'Unknown';
  }
  
  /**
   * Extract subject from row
   */
  function extractSubject(row) {
    const selectors = ['span.bog', 'span.bqe', 'td.xY span.y2'];
    for (const sel of selectors) {
      const el = row.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return '(No subject)';
  }
  
  /**
   * Extract snippet from row
   */
  function extractSnippet(row) {
    const selectors = ['span.y2', 'span.Zt'];
    for (const sel of selectors) {
      const el = row.querySelector(sel);
      if (el && el.textContent.trim()) {
        let text = el.textContent.trim();
        if (text.startsWith('-')) text = text.substring(1).trim();
        return text.substring(0, 200);
      }
    }
    return '';
  }
  
  /**
   * Extract date from row - prefer short text content over full title
   */
  function extractDate(row) {
    const selectors = ['td.xW span', 'span.bq3', 'td:last-child span', 'span[title]'];
    for (const sel of selectors) {
      const el = row.querySelector(sel);
      if (el) {
        // Prefer the visible text content (usually short like "Dec 5" or "10:30")
        const text = el.textContent.trim();
        if (text && text.length < 20) return text;
      }
    }
    return '';
  }
  
  /**
   * Find email rows in the inbox.
   * Caches the first selector that returns results so subsequent scans pay
   * only one querySelectorAll instead of up to seven.
   */
  function findEmailRows() {
    if (cachedRowSelector) {
      const rows = content.document.querySelectorAll(cachedRowSelector);
      if (rows.length > 0) return Array.from(rows);
      // Cached selector no longer works (e.g. Gmail navigated away); fall through.
      cachedRowSelector = null;
    }

    const rowSelectors = [
      'tr.zA',
      'tr[role="row"]',
      'div[role="row"]',
      '[data-legacy-thread-id]',
      '[data-thread-id]',
      'div.Cp tr',
      'div[role="main"] tr'
    ];
    
    for (const selector of rowSelectors) {
      const rows = content.document.querySelectorAll(selector);
      if (rows.length > 0) {
        cachedRowSelector = selector;
        return Array.from(rows);
      }
    }
    
    const links = content.document.querySelectorAll('a[href*="#inbox/"], a[href*="#all/"]');
    if (links.length > 0) return Array.from(links);
    return [];
  }
  
  /**
   * Scan inbox DOM and extract unread emails
   */
  function scanInbox() {
    if (!isGmailInbox()) return null;
    
    const rows = findEmailRows();
    const threads = [];
    let unreadCount = 0;
    let rowIndex = 0;
    
    for (const row of rows) {
      rowIndex++;
      if (threads.length >= MAX_EMAILS) break;
      if (!isUnread(row)) continue;
      unreadCount++;
      
      const gmailUrl = extractGmailUrl(row);
      let threadId = extractThreadId(row);
      
      if (!threadId && gmailUrl) {
        const match = gmailUrl.match(/#(?:inbox|all|sent|starred|label)\\/([^/?#]+)/i);
        if (match && match[1]) threadId = match[1];
      }
      
      const sender = extractSender(row);
      const subject = extractSubject(row);
      const date = extractDate(row);
      
      // Generate stable fallback ID based on content (not position)
      if (!threadId) {
        // Simple hash of sender + subject + date for stable identification
        const contentStr = sender + '|' + subject + '|' + date;
        let hash = 0;
        for (let i = 0; i < contentStr.length; i++) {
          hash = ((hash << 5) - hash) + contentStr.charCodeAt(i);
          hash = hash & hash; // Convert to 32bit integer
        }
        threadId = 'hash-' + Math.abs(hash).toString(36);
      }
      
      threads.push({
        id: threadId,
        threadId: threadId,
        from: sender,
        subject: subject,
        snippet: extractSnippet(row),
        date: date,
        isUnread: true,
        url: gmailUrl,
        rowIndex: threads.length // Store index for clicking
      });
    }
    
    const now = Date.now();
    if (now - lastDebugLog > DEBUG_INTERVAL_MS) {
      lastDebugLog = now;
      frameDebugLog('rows=', rows.length, 'unread=', unreadCount, 'threads=', threads.length);
    }
    
    return {
      threads,
      timestamp: Date.now(),
      meta: {
        rows: rows.length,
        unread: unreadCount,
        inboxReady: rows.length > 0 || (
          !!content.document.querySelector('div[role="main"]') &&
          !content.document.querySelector('[aria-busy="true"], [role="progressbar"]')
        )
      }
    };
  }
  
  /**
   * Debounced scan that sends results to parent
   */
  function debouncedScan() {
    if (scanTimeout) content.clearTimeout(scanTimeout);
    scanTimeout = content.setTimeout(() => {
      const result = scanInbox();
      // Never push partial results — chrome waits for a complete inbox.
      if (result && result.meta.inboxReady) {
        const resultStr = JSON.stringify(result.threads);
        if (resultStr !== lastScanResult) {
          lastScanResult = resultStr;
          sendAsyncMessage('LiveGmail:UnreadData', result);
        }
      }
    }, SCAN_DEBOUNCE_MS);
  }
  
  /**
   * Set up mutation observer
   */
  function setupObserver() {
    if (observer) observer.disconnect();
    
    const target = content.document.querySelector('div[role="main"]') || 
                   content.document.querySelector('div.Cp') || 
                   content.document.body;
    
    if (!target) {
      content.setTimeout(setupObserver, 1000);
      return;
    }
    
    observer = new content.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          debouncedScan();
          return;
        }
        if (mutation.type === 'attributes') {
          // Only react to class changes on row-level elements, not deeply nested ones.
          // Gmail fires hundreds of attribute mutations per second on icons, buttons,
          // and hover highlights — filtering here prevents the debounce from being
          // perpetually reset by irrelevant noise.
          const el = mutation.target;
          if (
            el.tagName === 'TR' ||
            el.getAttribute('role') === 'row' ||
            el.classList.contains('zA')
          ) {
            debouncedScan();
            return;
          }
        }
      }
    });
    observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  
  // Message handlers
  addMessageListener('LiveGmail:RequestScan', () => {
    frameDebugLog('Received RequestScan');
    const result = scanInbox();
    if (result && result.meta.inboxReady) {
      lastScanResult = JSON.stringify(result.threads);
      sendAsyncMessage('LiveGmail:UnreadData', result);
    }
  });
  
  addMessageListener('LiveGmail:CheckReady', () => {
    const result = scanInbox();
    if (!result) {
      sendAsyncMessage('LiveGmail:ReadyStatus', { ready: false, inboxReady: false, rows: 0 });
      return;
    }
    sendAsyncMessage('LiveGmail:ReadyStatus', {
      ready: result.meta.inboxReady,
      inboxReady: result.meta.inboxReady,
      rows: result.meta.rows
    });
  });
  
  addMessageListener('LiveGmail:OpenThread', (message) => {
    try {
      const data = message && message.data ? message.data : {};
      const rowIndex = data.rowIndex;
      const targetUrl = data.url || '';
      frameDebugLog('OpenThread', data);
      
      // Try to click the row by index first (most reliable for Gmail SPA)
      if (rowIndex !== undefined && rowIndex !== null) {
        const rows = findEmailRows();
        let unreadIdx = 0;
        for (const row of rows) {
          if (isUnread(row)) {
            if (unreadIdx === rowIndex) {
              frameDebugLog('Clicking row at index', rowIndex);
              // Try to find and click a link in the row
              const link = row.querySelector('a[href*="#"], a[role="link"]') || row.querySelector('a');
              if (link) {
                link.click();
                return;
              }
              // Fallback: click the row itself
              row.click();
              return;
            }
            unreadIdx++;
          }
        }
      }
      
      // Fallback: navigate via URL (only if it's a real Gmail URL, not a fallback)
      if (targetUrl && !targetUrl.includes('idx-') && !targetUrl.includes('row-') && !targetUrl.includes('hash-')) {
        if (/^https?:/i.test(targetUrl)) {
          content.location.href = targetUrl;
        } else if (targetUrl.startsWith('#')) {
          content.location.hash = targetUrl;
      } else {
          content.location.href = 'https://mail.google.com/mail/u/0/' + targetUrl;
        }
      }
    } catch (e) {
      content.console.warn('[Live Gmail Frame] OpenThread failed:', e);
    }
  });
  
  // Initialize — observer for live updates; chrome sends RequestScan on tab load.
  function init() {
    frameDebugLog('Initializing...');
    const start = () => setupObserver();
    if (content.document.readyState === 'complete') {
      start();
    } else {
      content.addEventListener('load', start, { once: true });
    }
  }
  
  // Listen for debug enable/disable
  addMessageListener('LiveGmail:SetDebug', (message) => {
    DEBUG_ENABLED = message && message.data ? message.data.enabled : false;
  });
  
  if (content.location.href.includes('mail.google.com')) {
    init();
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
      
      globalMM.addMessageListener('LiveGmail:UnreadData', (message) => {
        try {
          handleFrameScriptData(message.data, message.target);
        } catch (e) {
          console.error('[Live Gmail] Error handling frame script data:', e);
        }
      });
      
      messageListenersRegistered = true;
      debugLog('Message listeners registered');
    } catch (e) {
      console.error('[Live Gmail] Error setting up message listeners:', e);
    }
  }


  /**
   * Handle data from frame script
   */
  function handleFrameScriptData(payload, sourceMM) {
    if (!payload || !Array.isArray(payload.threads)) return;

    const sourceTab = getTabForMessageManager(sourceMM);
    if (sourceTab && !isLiveGmailScanSource(sourceTab)) {
      const staleKey = scanContextKey || getPanelContextKey(sourceTab);
      debugLog('Ignoring scan from unloaded tab');
      finishLoadScanForTab(sourceTab);
      if (staleKey) loadScansInFlight.delete(staleKey);
      scanInProgress = false;
      updateEmailDisplay();
      return;
    }

    const rows = payload.meta?.rows ?? 0;
    const inboxReady = payload.meta?.inboxReady === true;
    const isAuthoritative = rows > 0 || inboxReady;

    if (!isAuthoritative) {
      debugLog('Premature scan (inbox not ready), waiting for MutationObserver update');
      if (activePanelContextKey) updateEmailDisplay();
      return;
    }

    const targetKey = scanContextKey || activePanelContextKey;
    const viewKey = activePanelContextKey;
    const restoreView = targetKey && viewKey && targetKey !== viewKey;

    if (targetKey && restoreView) {
      activatePanelContext(targetKey);
    }

    // Throttle noisy logs
    const now = Date.now();
    if (payload.meta && now - lastLogTs > 10000) {
      lastLogTs = now;
      debugLog('Frame meta rows=', payload.meta.rows, 'unread=', payload.meta.unread, 'context=', targetKey);
      debugLog('Received', payload.threads.length, 'threads from frame');
    }

    const clickedIds = clickedEmailIds;
    const allEmails = payload.threads.slice(0, CONFIG.MAX_EMAILS).map((thread, idx) => ({
      id: thread.id || thread.threadId || '',
      threadId: thread.threadId || thread.id || '',
      from: thread.from || 'Unknown',
      subject: thread.subject || '(No subject)',
      date: thread.date || '',
      snippet: (thread.snippet || '').substring(0, 100),
      isUnread: thread.isUnread !== false,
      url: thread.url || '',
      rowIndex: thread.rowIndex !== undefined ? thread.rowIndex : idx
    }));

    const nextEmails = allEmails.filter(email => !clickedIds.has(email.id));

    currentEmails = nextEmails;
    cachedEmails = nextEmails.slice();
    const ctx = getOrCreatePanelContext(targetKey);
    ctx.hasScanned = true;
    ctx.lastScanTs = Date.now();
    persistActiveContextToMemory(targetKey);
    saveCacheToPrefs();

    const currentIds = new Set(allEmails.map(e => e.id));
    for (const clickedId of clickedIds) {
      if (!currentIds.has(clickedId)) {
        clickedIds.delete(clickedId);
      }
    }

    scanContextKey = null;
    loadScansInFlight.delete(targetKey);
    finishLoadScanForTab(sourceTab);

    if (restoreView && viewKey) {
      activatePanelContext(viewKey);
    }

    if (targetKey === viewKey) {
      scanInProgress = false;
      hideError();
      updateEmailDisplay();
    } else {
      scanInProgress = false;
    }
  }

  /**
   * Initialize DOM mode
   */
  function initDomMode() {
    debugLog('Initializing DOM mode');
    setupMessageListeners();
    scanAllLoadedGmailEssentials();
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

    const cacheAge = document.createElement('span');
    cacheAge.className = 'live-gmail-cache-age';
    cacheAge.setAttribute('aria-live', 'polite');
    header.appendChild(cacheAge);
    
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
    }

    setupEssentialsHoverDelegation();
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
        attributeFilter: ['zen-essential', 'data-url', 'pending', 'label', 'image']
      });
    }

    const tabs = document.getElementById('tabbrowser-tabs');
    if (tabs) {
      observer.observe(tabs, { childList: true, attributes: true, subtree: true, attributeFilter: ['zen-essential', 'data-url'] });
    }
  }


  /**
   * React to workspace (space) switches — each space gets its own panel cache.
   */
  function setupWorkspaceMonitoring() {
    window.addEventListener('ZenWorkspacesUIUpdate', onWorkspaceOrContainerChanged);

    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        Services.prefs.addObserver('zen.workspaces.separate-essentials', onWorkspaceOrContainerChanged, false);
      }
    } catch (e) {}
  }

  /**
   * Attach hover listeners to a single essential tab (once).
   */
  function attachEssentialHoverListener(tab) {
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
    const contextKey = getPanelContextKey();

    for (const tab of gBrowser.tabs) {
      if (!tab.hasAttribute('zen-essential')) continue;

      attachEssentialHoverListener(tab);

      if (tabMatchesGmailPattern(tab)) {
        attachGmailEssentialLoadListeners(tab);
        checkGmailEssentialLoadState(tab);
      }

      if (!tabMatchesGmailPattern(tab)) continue;
      if (!tabMatchesContainerContext(tab, contextKey)) continue;

      const hints = getTabUrlHints(tab);
      const tabUrl = hints.find((h) => h.includes(pattern)) || hints[0] || '';
      gmailTabs.set(tab, tabUrl);
    }

    // Also attach via the essentials DOM — on cold start tabs may appear here
    // before all session metadata is reflected in gBrowser.tabs iteration.
    for (const tab of document.querySelectorAll('#zen-essentials .tabbrowser-tab[zen-essential]')) {
      attachEssentialHoverListener(tab);
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
   * Fallback hover delegation on the essentials strip, for cases where the
   * per-tab mouseenter listener in updateGmailTabs was not yet attached.
   */
  function setupEssentialsHoverDelegation() {
    const root =
      document.querySelector('.zen-essentials-container') ||
      document.getElementById('zen-essentials');
    if (!root || root.hasAttribute('data-live-gmail-hover-delegate')) return;

    root.setAttribute('data-live-gmail-hover-delegate', 'true');
    root.addEventListener(
      'mouseover',
      (event) => {
        const tab = event.target.closest('.tabbrowser-tab');
        if (!tab?.hasAttribute('zen-essential')) return;
        if (!isGmailEssentialTab(tab)) return;
        showPanel(tab);
      },
      true
    );
  }

  /**
   * Handle tab hover
   */
  function handleTabHover(event) {
    const tab = event.currentTarget;
    if (!isGmailEssentialTab(tab)) {
      // Use the delayed hide rather than an instant one so the grace period
      // applies regardless of which side the cursor exits the Gmail tab from.
      // If the cursor continues on to the panel, its mouseenter cancels this.
      scheduleHide();
      return;
    }

    // Do NOT set hoveredTab here — showPanel sets it after computing context.
    showPanel(tab);
  }

  /**
   * Handle tab leave
   */
  function handleTabLeave() {
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
   * Show panel
   */
  function showPanel(tab) {
    const contextKey = getPanelContextKey(tab);

    activatePanelContext(contextKey);

    const isEssentialHover = tab && isGmailEssentialTab(tab);

    if (tab && tab.hasAttribute('zen-essential') && !isEssentialHover) {
      hidePanel();
      return;
    }

    // Gmail essential hover always opens the panel
    if (!isEssentialHover) {
      const hasCachedData = cachedEmails.length > 0 || currentEmails.length > 0;
      if (!hasCachedData && !hasGmailTab()) {
        debugLog('No Gmail essential hover, tab, or cached data; not showing panel');
        hidePanel();
        return;
      }
    }

    hoveredTab = tab;

    if (!panelElement) createPanel();
    updatePanelTheme();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

    const tabHeight = tab ? tab.getBoundingClientRect().height : 0;
    panelElement.openPopup(tab || document.documentElement, 'end_before', 4, tabHeight);
    updateEmailDisplay();
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
    persistActiveContextToMemory(activePanelContextKey);
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
   * Format a cache timestamp for the panel header.
   */
  function formatCacheAge(timestamp) {
    if (!timestamp) return '';

    const diffMs = Math.max(0, Date.now() - timestamp);
    const sec = Math.floor(diffMs / 1000);

    if (sec < 60) return 'Updated just now';

    const min = Math.floor(sec / 60);
    if (min < 60) return min === 1 ? 'Updated 1 min ago' : `Updated ${min} min ago`;

    const hr = Math.floor(min / 60);
    if (hr < 24) return hr === 1 ? 'Updated 1 hr ago' : `Updated ${hr} hr ago`;

    const days = Math.floor(hr / 24);
    if (days < 7) return days === 1 ? 'Updated 1 day ago' : `Updated ${days} days ago`;

    return 'Updated ' + new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
  }

  /**
   * Show cache age in the header when the essential tab is unloaded.
   */
  function updateCacheAgeLabel() {
    const ageEl = panelElement?.querySelector('.live-gmail-cache-age');
    if (!ageEl) return;

    const contextKey = activePanelContextKey;
    if (!contextKey) {
      ageEl.textContent = '';
      ageEl.hidden = true;
      return;
    }

    const essential = findGmailEssentialTab(contextKey);
    const isUnloaded = essential && isTabDiscardedOrUnloaded(essential);
    if (!isUnloaded) {
      ageEl.textContent = '';
      ageEl.hidden = true;
      return;
    }

    const ctx = getOrCreatePanelContext(contextKey);
    if (!ctx.hasScanned || !ctx.lastScanTs) {
      ageEl.textContent = '';
      ageEl.hidden = true;
      return;
    }

    ageEl.textContent = formatCacheAge(ctx.lastScanTs);
    ageEl.hidden = false;
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

    const finishDisplay = () => {
      updateCacheAgeLabel();
    };

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
      finishDisplay();
      return;
    }

    if (loadingContainer) loadingContainer.style.display = 'none';
    emailsContainer.innerHTML = '';

    if (emailsToShow.length === 0) {
      const contextEssential = findGmailEssentialTab(activePanelContextKey);
      const isUnloaded = !contextEssential || isTabDiscardedOrUnloaded(contextEssential);
      const hasScanned = getOrCreatePanelContext(activePanelContextKey).hasScanned;
      const emptyMessage = isUnloaded && !hasScanned
        ? 'Load Gmail to see inbox'
        : 'No unread emails';
      emailsContainer.innerHTML = `<div class="live-gmail-empty">${emptyMessage}</div>`;
      setComposeVisible(false);
      finishDisplay();
      return;
    }

    setComposeVisible(true);

    emailsToShow.forEach(email => {
      const el = document.createElement('div');
      el.className = 'live-gmail-email-item';
      if (email.isUnread) el.classList.add('live-gmail-unread');
      
      // Ensure consistent height
      el.style.minHeight = '70px';
      el.style.height = '70px';
      el.style.display = 'flex';
      el.style.flexDirection = 'column';
      
      const from = email.from.replace(/<[^>]*>/g, '').trim();
      const subject = email.subject || '(No subject)';
      const snippet = email.snippet || '';
      const date = formatDate(email.date);

      el.innerHTML = `
        <div class="live-gmail-email-header" style="flex-shrink: 0;">
          <span class="live-gmail-email-from">${escapeHtml(from)}</span>
          <span class="live-gmail-email-date">${escapeHtml(date)}</span>
        </div>
        <div class="live-gmail-email-subject" style="flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(subject)}</div>
        <div class="live-gmail-email-snippet" style="flex: 1; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; min-height: 0; padding-top: 2px; line-height: 1.3;">${escapeHtml(snippet)}</div>
      `;

      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const targetTab = (hoveredTab && isGmailEssentialTab(hoveredTab))
          ? hoveredTab
          : resolveGmailTargetTab(activePanelContextKey);

        if (!targetTab || !gBrowser) return;
        
        // Select the tab
        if (gBrowser.selectedTab !== targetTab) {
          gBrowser.selectedTab = targetTab;
        }
        
        let gmailUrl = email.url || `https://mail.google.com/mail/u/0/#inbox/${email.threadId || email.id}`;
        
        if (!/^https?:/i.test(gmailUrl)) {
          if (gmailUrl.startsWith('#')) {
            gmailUrl = 'https://mail.google.com/mail/u/0/' + gmailUrl;
          } else {
            gmailUrl = 'https://mail.google.com/mail/u/0/' + gmailUrl;
          }
        }
        
        debugLog('Opening email at rowIndex:', email.rowIndex, 'url:', gmailUrl);

        // Wait for tab to be ready, then send OpenThread message
        const waitForTabReady = (tab, maxAttempts = 50) => {
          return new Promise((resolve) => {
            let attempts = 0;
            let gmailReady = false;
            let readyCheckListener = null;
            
            const checkReady = () => {
              attempts++;
              
              if (tab.linkedBrowser && tab.linkedBrowser.messageManager) {
                try {
                  const browser = tab.linkedBrowser;
                  const uri = browser.currentURI;
                  
                  if (uri && uri.spec.includes(getGmailUrlPattern())) {
                    // Browser is loaded and on Gmail
                    if (!gmailReady) {
                      // First time: inject frame script and wait for Gmail to be ready
                      loadFrameScript(browser);
                      
                      // Set up listener for ready status
                      if (!readyCheckListener) {
                        readyCheckListener = (message) => {
                          if (message.name === 'LiveGmail:ReadyStatus' && message.data?.inboxReady) {
                            gmailReady = true;
                            debugLog('Gmail inbox is ready, rows:', message.data.rows);
                            
                            // Now send the OpenThread message immediately
                            try {
                              debugLog('Sending OpenThread message:', {
                                threadId: email.threadId || email.id,
                                url: gmailUrl,
                                rowIndex: email.rowIndex
                              });
                              browser.messageManager.sendAsyncMessage('LiveGmail:OpenThread', {
                                threadId: email.threadId || email.id,
                                url: gmailUrl,
                                rowIndex: email.rowIndex
                              });
                              debugLog('Sent OpenThread to tab');
                              
                              // Clean up listener
                              if (readyCheckListener) {
                                Services.mm.removeMessageListener('LiveGmail:ReadyStatus', readyCheckListener);
                              }
                              resolve(true);
                            } catch (err) {
                              console.warn('[Live Gmail] Could not send OpenThread:', err);
                              if (readyCheckListener) {
                                Services.mm.removeMessageListener('LiveGmail:ReadyStatus', readyCheckListener);
                              }
                              resolve(false);
                            }
                          }
                        };
                        
                        Services.mm.addMessageListener('LiveGmail:ReadyStatus', readyCheckListener);
                      }
                      
                      // Request ready check from frame script immediately
                      try {
                        browser.messageManager.sendAsyncMessage('LiveGmail:CheckReady', {});
                      } catch (e) {
                        debugLog('Could not send CheckReady:', e);
                      }
                    }
                    
                    // Continue checking if not ready yet
                    if (!gmailReady && attempts < maxAttempts) {
                      setTimeout(checkReady, 50);
                    } else if (!gmailReady) {
                      console.warn('[Live Gmail] Gmail did not become ready in time');
                      if (readyCheckListener) {
                        Services.mm.removeMessageListener('LiveGmail:ReadyStatus', readyCheckListener);
                      }
                      resolve(false);
                    }
                    return;
                  }
                } catch (e) {
                  debugLog('Error checking tab ready:', e);
                }
              }
              
              if (attempts >= maxAttempts) {
                console.warn('[Live Gmail] Tab did not become ready in time');
                if (readyCheckListener) {
                  Services.mm.removeMessageListener('LiveGmail:ReadyStatus', readyCheckListener);
                }
                resolve(false);
                return;
              }
              
              setTimeout(checkReady, 100);
            };
            
            // Also listen for load event
            if (tab.linkedBrowser) {
              tab.linkedBrowser.addEventListener('load', () => {
                setTimeout(checkReady, 500);
              }, { once: true });
            }
            
            checkReady();
          });
        };

        // Always use waitForTabReady to ensure frame script is loaded
        waitForTabReady(targetTab).then((success) => {
          if (success) {
            debugLog('Successfully navigated to email');
          } else {
            console.warn('[Live Gmail] Failed to navigate to email, falling back to URL navigation');
            // Fallback: navigate via URL
            try {
              const browser = targetTab.linkedBrowser;
              if (browser && browser.currentURI) {
                browser.loadURI(gmailUrl, {
                  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
                });
              }
            } catch (err) {
              console.warn('[Live Gmail] Could not navigate via URL:', err);
            }
          }
        });
        
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

    finishDisplay();
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

  // Debug functions
  window.liveGmailDebug = {
    showPanel: () => {
      if (panelElement) {
        panelElement.openPopup(document.documentElement, 'overlap', 100, 100);
      }
    },
    hidePanel,
    scan: () => scanLoadedGmailEssential(),
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
