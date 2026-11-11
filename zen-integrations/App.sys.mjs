const { debugLog } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);
const { ZenCache } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Cache.sys.mjs' + new URL(import.meta.url).search
);
const { ZenScan } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Scan.sys.mjs' + new URL(import.meta.url).search
);
const { ZenPanel } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Panel.sys.mjs' + new URL(import.meta.url).search
);
const { ZenTabs } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Tabs.sys.mjs' + new URL(import.meta.url).search
);
const { gmailProvider } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/Gmail.sys.mjs' + new URL(import.meta.url).search
);
const { outlookProvider } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/Outlook.sys.mjs' + new URL(import.meta.url).search
);

export class ZenIntegrations {
  constructor(window) {
    this.window = window;
    this.providers = [gmailProvider, outlookProvider];
    this.currentEmails = [];
    this.cachedEmails = [];
    this.hoveredTab = null;
    this.panelElement = null;
    this.clickedEmailIds = new Set();
    this.scanInProgress = false;
    this.scanMemCache = {};
    this.scanInFlight = new Set();
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

    this.cache = new ZenCache(this);
    this.scan = new ZenScan(this);
    this.panel = new ZenPanel(this);
    this.tabs = new ZenTabs(this);
  }

  providerForKey(key) {
    const id = String(key || '').split(':')[0];
    return this.providers.find((provider) => provider.id === id) || null;
  }

  onReadState(browser, data) {
    const tab = this.tabs.tabForBrowser(browser);
    this.tabs.noteOpenThread(tab, data);
    this.scan.onReadStateChanged(tab);
  }

  onFeedDocument() {}

  init() {
    debugLog('Initializing');
    this.cache.load();
    this.tabs.cleanupScannerTabs();
    this.panel.create();
    this.tabs.setupMonitoring();
    this.tabs.scanLoadedAnchors();
    for (const tab of this.tabs.anchors()) {
      if (!this.tabs.findLoadedAnchor(this.tabs.providerFor(tab)?.contextKey(tab, this.tabs.getUrlHints(tab)))) {
        this.scan.requestScan(tab, { force: false });
      }
    }
    this.scan.startPoll();
    debugLog('Initialized');
  }

  destroy() {
    this.tabs.stopInboxWatch();
    this.scan.stopPoll();
    this.panel.hide();
    if (this.panelElement?.remove) {
      try { this.panelElement.remove(); } catch (e) {}
    }
    this.panelElement = null;
  }
}

export function createZenIntegrations(window) {
  return new ZenIntegrations(window);
}
