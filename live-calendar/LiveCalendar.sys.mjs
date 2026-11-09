const { debugLog, getTabUserContextId } = ChromeUtils.importESModule(
  'chrome://sine/content/live-calendar/LiveCalendarUtil.sys.mjs' + new URL(import.meta.url).search
);
const { LiveCalendarCache } = ChromeUtils.importESModule(
  'chrome://sine/content/live-calendar/LiveCalendarCache.sys.mjs' + new URL(import.meta.url).search
);
const { LiveCalendarPanel } = ChromeUtils.importESModule(
  'chrome://sine/content/live-calendar/LiveCalendarPanel.sys.mjs' + new URL(import.meta.url).search
);
const { LiveCalendarTabs } = ChromeUtils.importESModule(
  'chrome://sine/content/live-calendar/LiveCalendarTabs.sys.mjs' + new URL(import.meta.url).search
);

export class LiveCalendar {
  constructor(window) {
    this.window = window;
    this.day = '';
    this.events = [];
    this.hoveredTab = null;
    this.pendingShowTab = null;
    this.panelElement = null;
    this.activeContextKey = null;
    this.contexts = new Map();
    this.diskStore = {};
    this.showTimer = null;
    this.hideTimer = null;
    this.pillTimer = null;
    this.compactPinTarget = null;
    this.cache = new LiveCalendarCache(this);
    this.panel = new LiveCalendarPanel(this);
    this.tabs = new LiveCalendarTabs(this);
  }

  getContextKey(tab = this.hoveredTab) {
    if (tab) return String(getTabUserContextId(tab) || 0);
    const selected = this.window.gBrowser?.selectedTab;
    if (selected) return String(getTabUserContextId(selected) || 0);
    return '0';
  }

  init() {
    debugLog('Initializing Live Calendar');
    this.panel.create();
    this.tabs.setup();
    this.cache.load();
  }

  destroy() {
    this.tabs.stop();
    this.panel.hide();
    if (this.panelElement?.remove) {
      try { this.panelElement.remove(); } catch (e) {}
    }
    this.panelElement = null;
  }
}

export function createLiveCalendar(window) {
  return new LiveCalendar(window);
}
