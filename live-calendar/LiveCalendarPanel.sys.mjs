const {
  CONFIG,
  XUL_NS,
  canJoin,
  escapeHtml,
  formatClock,
  formatDayTitle,
  isPinnedCalendarTab,
  localDay
} = ChromeUtils.importESModule(
  'chrome://sine/content/live-calendar/LiveCalendarUtil.sys.mjs' + new URL(import.meta.url).search
);

export class LiveCalendarPanel {
  constructor(app) {
    this.app = app;
  }

  get document() {
    return this.app.window.document;
  }

  isOpen() {
    try {
      return this.app.panelElement?.state === 'open';
    } catch (e) {
      return false;
    }
  }

  create() {
    if (this.app.panelElement) return;
    const document = this.document;
    const panel = document.createElementNS(XUL_NS, 'panel');
    panel.id = CONFIG.PANEL_ID;
    panel.setAttribute('type', 'arrow');
    panel.setAttribute('nonnativepopover', 'true');
    panel.setAttribute('orient', 'vertical');
    panel.setAttribute('side', 'left');
    panel.setAttribute('noautohide', 'true');
    panel.setAttribute('level', 'top');

    const wrapper = document.createElement('div');
    wrapper.className = 'live-calendar-wrapper';

    const header = document.createElement('div');
    header.className = 'live-calendar-header';
    const title = document.createElement('span');
    title.className = 'live-calendar-title';
    title.textContent = 'Calendar';
    header.appendChild(title);

    const list = document.createElement('div');
    list.className = 'live-calendar-list';

    const add = document.createElement('button');
    add.className = 'live-calendar-add';
    add.type = 'button';
    add.title = 'New event';
    add.setAttribute('aria-label', 'New event');
    add.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    add.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.app.tabs.createEvent();
    });

    wrapper.append(header, list, add);
    panel.appendChild(wrapper);
    panel.addEventListener('mouseenter', () => {
      if (this.app.hideTimer) {
        this.app.window.clearTimeout(this.app.hideTimer);
        this.app.hideTimer = null;
      }
    });
    panel.addEventListener('mouseleave', () => this.scheduleHide());
    panel.addEventListener('popuphidden', () => this.unpinCompactChrome());
    document.documentElement.appendChild(panel);
    this.app.panelElement = panel;
  }

  pinCompactChrome(tab) {
    const target = tab?.querySelector('.tab-content, .tab-icon-stack')
      || tab?.closest('#zen-essentials, .zen-essentials-container, .zen-workspace-pinned-tabs-section');
    if (this.app.compactPinTarget && this.app.compactPinTarget !== target) this.unpinCompactChrome();
    if (!target) return;
    this.app.compactPinTarget = target;
    target.setAttribute('open', 'true');
    target.setAttribute('data-live-calendar-compact-pin', 'true');
  }

  unpinCompactChrome() {
    const target = this.app.compactPinTarget;
    if (!target) return;
    if (target.hasAttribute('data-live-calendar-compact-pin')) {
      target.removeAttribute('open');
      target.removeAttribute('data-live-calendar-compact-pin');
    }
    this.app.compactPinTarget = null;
  }

  scheduleShow(tab) {
    if (!tab || !this.app.tabs.isCalendarAnchor(tab)) return;
    if (this.app.hideTimer) {
      this.app.window.clearTimeout(this.app.hideTimer);
      this.app.hideTimer = null;
    }
    if (this.isOpen() && this.app.hoveredTab === tab) {
      this.cancelShowTimer();
      this.show(tab);
      return;
    }
    if (this.isOpen()) this.hide();
    if (this.app.pendingShowTab === tab && this.app.showTimer) return;
    this.cancelShowTimer();
    this.app.pendingShowTab = tab;
    this.app.showTimer = this.app.window.setTimeout(() => {
      this.app.showTimer = null;
      this.app.pendingShowTab = null;
      if (!tab.matches(':hover')) return;
      this.show(tab);
    }, CONFIG.HOVER_DELAY_MS);
  }

  show(tab) {
    const key = this.app.getContextKey(tab);
    this.app.cache.activate(key);
    this.app.hoveredTab = tab;
    if (!this.app.panelElement) this.create();
    if (this.app.hideTimer) {
      this.app.window.clearTimeout(this.app.hideTimer);
      this.app.hideTimer = null;
    }
    this.pinCompactChrome(tab);
    this.openAt(tab);
    this.updateDisplay();
    this.app.tabs.refreshLoaded(tab);
  }

  scheduleHide() {
    if (this.app.hideTimer) this.app.window.clearTimeout(this.app.hideTimer);
    this.app.hideTimer = this.app.window.setTimeout(() => {
      this.app.hideTimer = null;
      if (this.app.hoveredTab?.matches(':hover')) return;
      if (this.app.pendingShowTab?.matches(':hover')) return;
      if (this.app.panelElement?.matches(':hover')) return;
      this.hide();
    }, 200);
  }

  hide() {
    if (this.app.hideTimer) {
      this.app.window.clearTimeout(this.app.hideTimer);
      this.app.hideTimer = null;
    }
    this.cancelShowTimer();
    this.app.cache.persistActive(this.app.activeContextKey);
    this.unpinCompactChrome();
    if (this.app.panelElement) this.app.panelElement.hidePopup();
    this.app.hoveredTab = null;
  }

  cancelShowTimer() {
    if (this.app.showTimer) {
      this.app.window.clearTimeout(this.app.showTimer);
      this.app.showTimer = null;
    }
    this.app.pendingShowTab = null;
  }

  openAt(tab) {
    const panel = this.app.panelElement;
    if (!panel) return;
    const anchor = tab?.querySelector('.tab-content, .tab-icon-stack') || tab || this.document.documentElement;
    if (isPinnedCalendarTab(tab)) {
      const right = !!this.app.window.gZenVerticalTabsManager?._prefsRightSide;
      panel.setAttribute('side', right ? 'right' : 'left');
      const rows = Math.min(Math.max(this.visibleEvents().length || 1, 1), 6);
      panel.openPopup(anchor, {
        position: right ? 'topleft topright' : 'topright topleft',
        x: right ? -10 : 10,
        y: (rows * 52) / -2
      });
      return;
    }
    panel.setAttribute('side', 'left');
    const tabHeight = tab ? tab.getBoundingClientRect().height : 0;
    panel.openPopup(tab || this.document.documentElement, 'end_before', 4, tabHeight);
  }

  visibleEvents() {
    if (this.app.day !== localDay()) return [];
    return this.app.events || [];
  }

  updateDisplay() {
    const panel = this.app.panelElement;
    if (!panel) return;
    const title = panel.querySelector('.live-calendar-title');
    const list = panel.querySelector('.live-calendar-list');
    if (!list) return;
    const day = localDay();
    if (title) title.textContent = formatDayTitle(day);
    const events = this.visibleEvents();
    if (!events.length) {
      const empty = this.app.day === day ? 'Nothing on today' : 'Open Calendar to load today';
      list.innerHTML = `<div class="live-calendar-empty">${escapeHtml(this.document, empty)}</div>`;
      return;
    }
    const now = Date.now();
    list.innerHTML = events.map((event) => this.renderEvent(event, now)).join('');
    list.querySelectorAll('[data-calendar-action]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const card = node.closest('[data-event-id]');
        const item = events.find((entry) => entry.id === card?.getAttribute('data-event-id'));
        if (!item) return;
        if (node.getAttribute('data-calendar-action') === 'join') this.app.tabs.join(item);
        else this.app.tabs.openEvent(item);
      });
    });
  }

  renderEvent(event, now) {
    const doc = this.document;
    const start = formatClock(event.start);
    const end = formatClock(event.end);
    const when = event.allDay ? 'All day' : (start && end ? `${start} – ${end}` : 'Today');
    const join = canJoin(event, now)
      ? `<button type="button" class="live-calendar-join" data-calendar-action="join">Join</button>`
      : '';
    return `<div class="live-calendar-event" data-event-id="${escapeHtml(doc, event.id)}">
      <button type="button" class="live-calendar-open" data-calendar-action="open">
        <span class="live-calendar-when">${escapeHtml(doc, when)}</span>
        <span class="live-calendar-name">${escapeHtml(doc, event.title || '(No title)')}</span>
      </button>
      ${join}
    </div>`;
  }
}
