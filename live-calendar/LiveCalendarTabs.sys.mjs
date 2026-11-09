const {
  CONFIG,
  debugLog,
  eventBelongsToToday,
  getTabUserContextId,
  isEssentialOrPinnedTab,
  localDay,
  pickPillEvent,
  pillText
} = ChromeUtils.importESModule(
  'chrome://sine/content/live-calendar/LiveCalendarUtil.sys.mjs' + new URL(import.meta.url).search
);

export class LiveCalendarTabs {
  constructor(app) {
    this.app = app;
    this.watchListener = null;
  }

  get window() {
    return this.app.window;
  }

  get gBrowser() {
    return this.window.gBrowser;
  }

  get document() {
    return this.window.document;
  }

  getUrlHints(tab) {
    const hints = [];
    if (!tab) return hints;
    for (const attr of ['data-url', 'zen-origin-url', 'data-original-url']) {
      const value = tab.getAttribute(attr);
      if (value) hints.push(value);
    }
    const pending = tab.getAttribute('pending');
    if (pending && pending !== 'true') hints.push(pending);
    try {
      const lazy = this.window.SessionStore?.getLazyTabValue(tab, 'url');
      if (lazy) hints.push(lazy);
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

  isCalendarTab(tab) {
    const hints = this.getUrlHints(tab);
    const blob = hints.join('\n').toLowerCase();
    if (blob.includes(CONFIG.CALENDAR_URL) || blob.includes('logo_calendar')) return true;
    if (hints.some((hint) => /^https?:/i.test(hint))) return false;
    const label = (tab?.getAttribute('label') || tab?.label || '').toLowerCase();
    return label === 'calendar' || label.includes('google calendar');
  }

  isCalendarAnchor(tab) {
    return isEssentialOrPinnedTab(tab) && this.isCalendarTab(tab);
  }

  isLoaded(tab) {
    const browser = tab?.linkedBrowser;
    if (!browser) return false;
    try {
      if (tab.hasAttribute('discarded')) return false;
      if (browser.browsingContext?.discarded) return false;
      const spec = `${browser.currentURI?.spec || ''} ${browser.documentURI?.spec || ''}`;
      return spec.includes(CONFIG.CALENDAR_URL);
    } catch (e) {
      return false;
    }
  }

  setup() {
    this.startWatch();
    this.refreshAnchors();
    const onChange = () => this.refreshAnchors();
    const container = this.gBrowser?.tabContainer;
    if (container) {
      container.addEventListener('TabAttrModified', onChange);
      container.addEventListener('TabOpen', onChange);
      container.addEventListener('TabClose', onChange);
      container.addEventListener('TabPinned', onChange);
      container.addEventListener('TabUnpinned', onChange);
      container.addEventListener('TabSelect', onChange);
    }
    this.delegateHover();
    this.app.pillTimer = this.window.setInterval(() => this.refreshAnchors(), CONFIG.PILL_TICK_MS);
  }

  stop() {
    if (this.app.pillTimer) {
      this.window.clearInterval(this.app.pillTimer);
      this.app.pillTimer = null;
    }
    if (!this.watchListener) return;
    try { Services.mm.removeMessageListener('LiveCalendar:Day', this.watchListener); } catch (e) {}
    this.watchListener = null;
  }

  onDay(tab, data) {
    if (data?.debug) console.log('[Live Calendar] page', data.debug);
    if (!tab || !this.isCalendarAnchor(tab)) return;
    if (!data?.ok || data.day !== localDay()) return;
    const events = (Array.isArray(data.events) ? data.events : []).filter((event) => eventBelongsToToday(event));
    const key = this.app.getContextKey(tab);
    console.log(
      '[Live Calendar]',
      data.source || '',
      data.day,
      events.map((event) => `${event.title || '?'} ${event.allDay ? 'all-day' : event.start || ''}`)
    );
    this.app.cache.applyDay(key, data.day, events);
    this.updatePills();
    if (this.app.panel.isOpen() && String(this.app.activeContextKey) === String(key)) {
      this.app.panel.updateDisplay();
    }
  }

  startWatch() {
    if (this.watchListener) return;
    this.watchListener = (message) => {
      try {
        const tab = this.tabForTarget(message?.target);
        this.onDay(tab, message?.data || {});
      } catch (e) {
        debugLog('Calendar watch', e);
      }
    };
    try {
      Services.mm.addMessageListener('LiveCalendar:Day', this.watchListener);
    } catch (e) {
      debugLog('Could not listen for calendar', e);
    }
  }

  refreshAnchors() {
    if (!this.gBrowser?.tabs) return;
    for (const tab of this.gBrowser.tabs) {
      if (!this.isCalendarAnchor(tab)) {
        this.clearPill(tab);
        continue;
      }
      this.loadWatcher(tab);
      this.updatePill(tab);
    }
    this.delegateHover();
  }

  delegateHover() {
    const roots = [
      this.document.querySelector('.zen-essentials-container'),
      this.document.getElementById('zen-essentials'),
      this.document.querySelector('.zen-workspace-pinned-tabs-section'),
      this.document.getElementById('tabbrowser-tabs')
    ];
    const onHover = (event) => {
      const tab = event.target.closest?.('.tabbrowser-tab');
      if (!tab || !this.isCalendarAnchor(tab)) return;
      this.app.panel.scheduleShow(tab);
    };
    for (const root of roots) {
      if (!root || root.hasAttribute('data-live-calendar-hover')) continue;
      root.setAttribute('data-live-calendar-hover', 'true');
      root.addEventListener('mouseover', onHover, true);
      root.addEventListener('mouseout', (event) => {
        const tab = event.target.closest?.('.tabbrowser-tab');
        if (!tab || !this.isCalendarAnchor(tab)) return;
        const next = event.relatedTarget?.closest?.('.tabbrowser-tab');
        if (next === tab) return;
        this.app.panel.scheduleHide();
      }, true);
    }
  }

  loadWatcher(tab) {
    const browser = tab?.linkedBrowser;
    if (!this.isLoaded(tab) || !browser?.messageManager) return;
    const mm = browser.messageManager;
    if (!tab.__liveCalendarListener) {
      tab.__liveCalendarListener = (message) => {
        try { this.onDay(tab, message?.data || {}); } catch (e) { debugLog('Calendar watch', e); }
      };
      try { mm.addMessageListener('LiveCalendar:Day', tab.__liveCalendarListener); } catch (e) {}
    }
    try {
      mm.loadFrameScript('chrome://sine/content/live-calendar/LiveCalendarFrame.js', true);
    } catch (e) {
      debugLog('Could not load calendar watcher', e);
    }
  }

  refreshLoaded(tab) {
    if (!this.isLoaded(tab)) return;
    this.loadWatcher(tab);
    try {
      tab.linkedBrowser.messageManager.sendAsyncMessage('LiveCalendar:Refresh', {});
    } catch (e) {}
  }

  tabForTarget(target) {
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

  calendarSlot(tab) {
    const hints = this.getUrlHints(tab).join('\n');
    const match = hints.match(/\/calendar\/u\/(\d+)/);
    return match ? match[1] : '0';
  }

  targetTab() {
    if (this.app.hoveredTab && this.isCalendarAnchor(this.app.hoveredTab)) return this.app.hoveredTab;
    const key = this.app.activeContextKey || this.app.getContextKey();
    for (const tab of this.gBrowser?.tabs || []) {
      if (!this.isCalendarAnchor(tab)) continue;
      if (String(getTabUserContextId(tab) || 0) === String(key)) return tab;
    }
    return null;
  }

  select(tab) {
    if (!tab || !this.gBrowser) return;
    if (this.gBrowser.selectedTab !== tab) this.gBrowser.selectedTab = tab;
  }

  loadInTab(tab, url) {
    const browser = tab?.linkedBrowser;
    if (!browser?.fixupAndLoadURIString || !url) return;
    this.select(tab);
    this.app.panel.hide();
    browser.fixupAndLoadURIString(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
    });
  }

  createEvent() {
    const tab = this.targetTab();
    if (!tab) return;
    const slot = this.calendarSlot(tab);
    this.loadInTab(tab, `https://${CONFIG.CALENDAR_URL}/calendar/u/${slot}/r/eventedit`);
  }

  openEvent(event) {
    const tab = this.targetTab();
    if (!tab || !event) return;
    if (event.htmlLink) {
      this.loadInTab(tab, event.htmlLink);
      return;
    }
    this.select(tab);
    this.app.panel.hide();
  }

  join(event) {
    const url = event?.joinUrl;
    if (!url || !this.gBrowser) return;
    const tab = this.targetTab();
    const userContextId = getTabUserContextId(tab);
    this.app.panel.hide();
    try {
      const added = this.gBrowser.addTab(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        userContextId
      });
      this.gBrowser.selectedTab = added;
    } catch (e) {
      debugLog('Could not join', e);
    }
  }

  ensurePill(tab) {
    let pill = tab.querySelector(':scope > .live-calendar-pill, .tab-content .live-calendar-pill');
    if (pill) return pill;
    pill = this.document.createXULElement
      ? this.document.createXULElement('label')
      : this.document.createElementNS('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'label');
    pill.className = 'live-calendar-pill';
    pill.setAttribute('hidden', 'true');
    const host = tab.querySelector('.tab-content') || tab;
    host.appendChild(pill);
    return pill;
  }

  clearPill(tab) {
    tab?.querySelectorAll('.live-calendar-pill').forEach((pill) => pill.remove());
  }

  updatePill(tab) {
    if (!this.isCalendarAnchor(tab)) return;
    const pill = this.ensurePill(tab);
    const events = this.app.cache.todayEvents(this.app.getContextKey(tab));
    const soon = pickPillEvent(events);
    const text = soon ? pillText(soon) : '';
    if (!text) {
      pill.setAttribute('hidden', 'true');
      pill.textContent = '';
      pill.removeAttribute('value');
      return;
    }
    pill.removeAttribute('hidden');
    pill.textContent = text;
    pill.setAttribute('value', text);
  }

  updatePills() {
    for (const tab of this.gBrowser?.tabs || []) {
      if (this.isCalendarAnchor(tab)) this.updatePill(tab);
    }
  }
}
