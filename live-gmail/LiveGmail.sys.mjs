const { debugLog, getTabUserContextId } = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailUtil.sys.mjs' + new URL(import.meta.url).search
);
const { LiveGmailCache } = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailCache.sys.mjs' + new URL(import.meta.url).search
);
const { LiveGmailAtom } = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailAtom.sys.mjs' + new URL(import.meta.url).search
);
const { LiveGmailPanel } = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailPanel.sys.mjs' + new URL(import.meta.url).search
);
const { LiveGmailTabs } = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailTabs.sys.mjs' + new URL(import.meta.url).search
);

export class LiveGmail {
  constructor(window) {
    this.window = window;
    this.currentEmails = [];
    this.cachedEmails = [];
    this.hoveredTab = null;
    this.panelElement = null;
    this.clickedEmailIds = new Set();
    this.scanInProgress = false;
    this.atomMemCache = {};
    this.atomInFlight = new Set();
    this.readStateTimers = new Map();
    this.hideTimer = null;
    this.showTimer = null;
    this.pendingShowTab = null;
    this.loadScanTimers = new WeakMap();
    this.loadScansInFlight = new Set();
    this.activeLoadScanTabs = new WeakSet();
    this.activePanelContextKey = null;
    this.scanContextKey = null;
    this.panelContexts = new Map();
    this.diskCacheStore = {};
    this.compactPinTarget = null;

    this.cache = new LiveGmailCache(this);
    this.atom = new LiveGmailAtom(this);
    this.panel = new LiveGmailPanel(this);
    this.tabs = new LiveGmailTabs(this);
  }

  getPanelContextKey(tab = this.hoveredTab) {
    if (tab) return String(getTabUserContextId(tab) || 0);
    if (this.window.gZenWorkspaces?.containerSpecificEssentials) {
      const active = this.window.gZenWorkspaces?.getActiveWorkspaceFromCache?.();
      if (typeof active?.containerTabId === 'number') {
        return String(active.containerTabId || 0);
      }
    }
    const selected = this.window.gBrowser?.selectedTab;
    if (selected) return String(getTabUserContextId(selected) || 0);
    return '0';
  }

  onReadState(browser) {
    const tab = this.tabs.tabForBrowser(browser);
    this.atom.onReadStateChanged(tab);
  }

  onFeedDocument(browser, data) {
    this.atom.onFeedDocument(browser, data);
  }

  init() {
    debugLog('Initializing Live Gmail...');
    this.cache.load();
    this.tabs.cleanupScannerTabs();
    this.panel.create();
    this.tabs.setupMonitoring();
    this.tabs.scanLoadedAnchors();
    if (!this.tabs.findLoadedAnchor()) {
      const tab = this.tabs.findAnchor();
      if (tab) this.atom.requestScan(tab, { force: false });
    }
    debugLog('Initialized successfully');
  }

  destroy() {
    this.panel.hide();
    if (this.panelElement?.remove) {
      try {
        this.panelElement.remove();
      } catch (e) {}
    }
    this.panelElement = null;
  }
}

export function createLiveGmail(window) {
  return new LiveGmail(window);
}
