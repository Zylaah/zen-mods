const {
  CONFIG,
  debugLog,
  getTabUserContextId,
  isEssentialOrPinnedTab,
  isPinnedCalendarTab,
  pickPillEvent,
  pillText
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/calendar/LiveCalendarUtil.sys.mjs' + new URL(import.meta.url).search
);
const { hasToken, isEnabled, isExpired } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Accounts.sys.mjs' + new URL(import.meta.url).search
);

export class LiveCalendarTabs {
  constructor(app) {
    this.app = app;
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

  setup() {
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
  }

  refreshAnchors() {
    if (!this.gBrowser?.tabs) return;
    for (const tab of this.gBrowser.tabs) {
      const show = this.isCalendarAnchor(tab) && isEnabled('google') && (hasToken('google') || isExpired('google'));
      if (!show) {
        tab.removeAttribute('data-zi-calendar');
        this.clearPill(tab);
        this.clearSublabel(tab);
        continue;
      }
      tab.setAttribute('data-zi-calendar', 'true');
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
      if (!tab?.hasAttribute('data-zi-calendar')) return;
      this.app.panel.scheduleShow(tab);
    };
    for (const root of roots) {
      if (!root || root.hasAttribute('data-zi-calendar-hover')) continue;
      root.setAttribute('data-zi-calendar-hover', 'true');
      root.addEventListener('mouseover', onHover, true);
      root.addEventListener('mouseout', (event) => {
        const tab = event.target.closest?.('.tabbrowser-tab');
        if (!tab?.hasAttribute('data-zi-calendar')) return;
        const next = event.relatedTarget?.closest?.('.tabbrowser-tab');
        if (next === tab) return;
        this.app.panel.scheduleHide();
      }, true);
    }
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
    tab?.removeAttribute('data-live-calendar-pill');
    tab?.querySelectorAll('.live-calendar-pill').forEach((pill) => pill.remove());
  }

  setSublabel(tab, text) {
    const label = tab.querySelector('.zen-tab-sublabel');
    if (!label) return;
    if (!text) {
      this.clearSublabel(tab);
      return;
    }
    tab.setAttribute('data-live-calendar-sublabel', 'true');
    tab.setAttribute('zen-show-sublabel', text);
    try {
      this.document.l10n.setArgs(label, { tabSubtitle: text });
    } catch (e) {
      label.setAttribute('value', text);
    }
  }

  clearSublabel(tab) {
    if (!tab?.hasAttribute('data-live-calendar-sublabel')) return;
    tab.removeAttribute('data-live-calendar-sublabel');
    tab.removeAttribute('zen-show-sublabel');
    const label = tab.querySelector('.zen-tab-sublabel');
    if (!label) return;
    try {
      this.document.l10n.setArgs(label, { tabSubtitle: 'zen-default-pinned' });
    } catch (e) {
      label.setAttribute('value', '');
    }
  }

  updatePill(tab) {
    if (!this.isCalendarAnchor(tab) || !isEnabled('google') || isExpired('google') || !hasToken('google')) {
      this.clearPill(tab);
      this.clearSublabel(tab);
      return;
    }
    const events = this.app.cache.todayEvents(this.app.getContextKey(tab));
    const soon = pickPillEvent(events);
    const text = soon ? pillText(soon) : '';
    if (isPinnedCalendarTab(tab)) {
      this.clearPill(tab);
      this.setSublabel(tab, text);
      return;
    }
    this.clearSublabel(tab);
    const pill = this.ensurePill(tab);
    if (!text) {
      tab.removeAttribute('data-live-calendar-pill');
      pill.setAttribute('hidden', 'true');
      pill.textContent = '';
      pill.removeAttribute('value');
      return;
    }
    tab.setAttribute('data-live-calendar-pill', 'true');
    pill.removeAttribute('hidden');
    pill.textContent = '';
    pill.setAttribute('value', text);
  }

  updatePills() {
    for (const tab of this.gBrowser?.tabs || []) {
      if (this.isCalendarAnchor(tab)) this.updatePill(tab);
    }
  }
}
