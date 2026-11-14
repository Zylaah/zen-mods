const { CONFIG, debugLog, getTabUserContextId, localDay } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/calendar/LiveCalendarUtil.sys.mjs' + new URL(import.meta.url).search
);
const { hasToken, isEnabled, isExpired } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Accounts.sys.mjs' + new URL(import.meta.url).search
);
const { beginGoogleSignIn, fetchGoogleDay } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/calendar/CalendarAuth.sys.mjs' + new URL(import.meta.url).search
);
const { LiveCalendarCache } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/calendar/LiveCalendarCache.sys.mjs' + new URL(import.meta.url).search
);
const { LiveCalendarPanel } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/calendar/LiveCalendarPanel.sys.mjs' + new URL(import.meta.url).search
);
const { LiveCalendarTabs } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/calendar/LiveCalendarTabs.sys.mjs' + new URL(import.meta.url).search
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
    this.notices = new Map();
    this.dayInFlight = new Set();
    this.dayForcePending = new Set();
    this.pollTimer = null;
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
    this.pollTimer = this.window.setInterval(() => this.refreshOpenDays(), CONFIG.POLL_MS);
    this.window.setTimeout(() => this.refreshOpenDays(), 500);
  }

  setNotice(key, notice) {
    const storeKey = String(key ?? '');
    if (notice?.text) this.notices.set(storeKey, notice);
    else this.notices.delete(storeKey);
    if (this.panel.isOpen() && String(this.activeContextKey) === storeKey) {
      this.panel.updateDisplay();
    }
  }

  noticeFor(key = this.activeContextKey) {
    return this.notices.get(String(key ?? '')) || null;
  }

  beginSignIn(tab) {
    const anchor = tab || this.hoveredTab || this.tabs.targetTab();
    if (!anchor) return;
    beginGoogleSignIn(this, anchor, this.getContextKey(anchor));
  }

  refreshOpenDays() {
    const tabs = this.window.gBrowser?.tabs;
    if (!tabs) return;
    for (const tab of tabs) {
      if (this.tabs.isCalendarAnchor(tab)) this.refreshDay(tab);
    }
  }

  refreshDay(tab, { force = false } = {}) {
    if (!tab || !this.tabs.isCalendarAnchor(tab)) return;
    if (!isEnabled('google')) return;
    const key = this.getContextKey(tab);
    if (isExpired('google') || !hasToken('google')) {
      if (isExpired('google')) {
        this.setNotice(key, { text: 'Reconnect Google Calendar', reconnect: true });
      }
      this.tabs.updatePills();
      return;
    }
    const ctx = this.cache.getOrCreateContext(key);
    const fresh = ctx.day === localDay() && Date.now() - (ctx.fetchedAt || 0) < CONFIG.CACHE_MS;
    if (!force && fresh) return;
    if (this.dayInFlight.has(key)) {
      if (force) this.dayForcePending.add(key);
      return;
    }
    this.dayInFlight.add(key);
    fetchGoogleDay(this.window, tab, key).then((events) => {
      this.cache.applyDay(key, localDay(), events, 'google', 'complete');
      console.log(
        '[Live Calendar] google',
        localDay(),
        events.map((event) => `${event.title || '?'} ${event.allDay ? 'all-day' : event.start || ''}`)
      );
      this.tabs.updatePills();
      this.setNotice(key, null);
    }).catch((error) => {
      const text = error?.message || 'Calendar request failed';
      this.setNotice(key, {
        text: error?.expired ? 'Reconnect Google Calendar' : text,
        reconnect: !!error?.expired
      });
      if (!error?.signin) console.warn('[Live Calendar]', text);
    }).finally(() => {
      this.dayInFlight.delete(key);
      if (this.dayForcePending.delete(key)) this.refreshDay(tab, { force: true });
    });
  }

  destroy() {
    if (this.pollTimer) {
      this.window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
