const {
  CONFIG,
  XUL_NS,
  canJoin,
  eventBelongsToToday,
  eventEndMs,
  eventStartMs,
  formatClock,
  isPinnedCalendarTab,
  localDay
} = ChromeUtils.importESModule(
  'chrome://sine/content/live-calendar/LiveCalendarUtil.sys.mjs' + new URL(import.meta.url).search
);

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const HOUR_PX = 50;
const MIN_BLOCK_PX = 28;
const VIEW_PX = 300;

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

  html(tag, className, text) {
    const node = this.document.createElementNS(HTML_NS, tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  iconButton(className, title, paths, onClick) {
    const button = this.html('button', className);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    const svg = this.document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = this.document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
    }
    button.appendChild(svg);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
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

    const wrapper = this.html('div', 'live-calendar-wrapper');
    const scroll = this.html('div', 'live-calendar-scroll');
    wrapper.append(
      scroll,
      this.iconButton(
        'live-calendar-add',
        'New event',
        ['M8 2.5v11M2.5 8h11'],
        () => this.app.tabs.createEvent()
      )
    );
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
    const wasOpen = this.isOpen();
    this.app.cache.activate(key);
    this.app.hoveredTab = tab;
    if (!this.app.panelElement) this.create();
    if (this.app.hideTimer) {
      this.app.window.clearTimeout(this.app.hideTimer);
      this.app.hideTimer = null;
    }
    this.pinCompactChrome(tab);
    this.updateDisplay(!wasOpen);
    this.openAt(tab);
    this.app.refreshDay(tab);
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
      panel.openPopup(anchor, {
        position: right ? 'topleft topright' : 'topright topleft',
        x: right ? -10 : 10,
        y: -(VIEW_PX / 2)
      });
      return;
    }
    panel.setAttribute('side', 'left');
    const tabHeight = tab ? tab.getBoundingClientRect().height : 0;
    panel.openPopup(tab || this.document.documentElement, 'end_before', 4, tabHeight);
  }

  visibleEvents() {
    if (this.app.day !== localDay()) return [];
    return (this.app.events || []).filter((event) => eventBelongsToToday(event));
  }

  dayStartMs() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }

  minutesOf(ms, dayStart) {
    return Math.max(0, Math.min(1440, (ms - dayStart) / 60000));
  }

  hourLabel(hour) {
    return new Date(2000, 0, 1, hour % 24).toLocaleTimeString([], { hour: 'numeric' });
  }

  layoutColumns(blocks) {
    blocks.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
    let cluster = [];
    let clusterEnd = -1;
    const finish = () => {
      const cols = Math.max(1, ...cluster.map((block) => block.col + 1));
      cluster.forEach((block) => { block.cols = cols; });
      cluster = [];
    };
    const ends = [];
    for (const block of blocks) {
      if (cluster.length && block.top >= clusterEnd) {
        finish();
        ends.length = 0;
      }
      let col = ends.findIndex((end) => end <= block.top);
      if (col === -1) col = ends.length;
      ends[col] = block.bottom;
      block.col = col;
      cluster.push(block);
      clusterEnd = Math.max(clusterEnd, block.bottom);
    }
    if (cluster.length) finish();
  }

  appendNotice(parent, notice, block) {
    const host = this.html('div', block ? 'live-calendar-gate' : 'live-calendar-note');
    if (!notice.canSignIn) {
      host.appendChild(this.html('p', 'live-calendar-note-text', notice.text));
      parent.appendChild(host);
      return;
    }
    const button = this.html('button', 'live-calendar-signin', notice.text);
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.app.beginSignIn(this.app.hoveredTab || this.app.tabs.targetTab());
    });
    host.appendChild(button);
    parent.appendChild(host);
  }

  updateDisplay(scrollToNow = false) {
    const panel = this.app.panelElement;
    if (!panel) return;
    const scroll = panel.querySelector('.live-calendar-scroll');
    if (!scroll) return;
    const previousTop = scroll.scrollTop;
    scroll.replaceChildren();

    const events = this.visibleEvents();
    const notice = this.app.noticeFor();
    const now = Date.now();
    const dayStart = this.dayStartMs();
    const nowMin = (now - dayStart) / 60000;

    const timed = [];
    const loose = [];
    for (const event of events) {
      const start = eventStartMs(event);
      if (event.allDay || !Number.isFinite(start)) {
        loose.push(event);
        continue;
      }
      let end = eventEndMs(event);
      if (!Number.isFinite(end) || end <= start) end = start + 30 * 60000;
      timed.push({ event, startMin: this.minutesOf(start, dayStart), endMin: this.minutesOf(end, dayStart) });
    }

    if (!events.length && notice?.text) {
      this.appendNotice(scroll, notice, true);
      return;
    }
    if (!events.length && this.app.day !== localDay()) {
      scroll.appendChild(this.html('div', 'live-calendar-empty', 'Loading today'));
      return;
    }

    if (notice?.text) this.appendNotice(scroll, notice, false);

    if (loose.length) {
      const strip = this.html('div', 'live-calendar-loose');
      for (const event of loose) {
        const chip = this.html('button', 'live-calendar-chip', event.title || 'Event');
        chip.type = 'button';
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.app.tabs.openEvent(event);
        });
        strip.appendChild(chip);
      }
      scroll.appendChild(strip);
    }

    const startHour = 0;
    const endHour = 24;
    const totalPx = (endHour - startHour) * HOUR_PX;

    const grid = this.html('div', 'live-calendar-grid');
    grid.style.height = `${totalPx}px`;

    for (let hour = startHour; hour < endHour; hour++) {
      const row = this.html('div', 'live-calendar-hour');
      row.style.top = `${(hour - startHour) * HOUR_PX}px`;
      row.style.height = `${HOUR_PX}px`;
      row.appendChild(this.html('span', 'live-calendar-hour-line'));
      row.appendChild(this.html('span', 'live-calendar-hour-label', this.hourLabel(hour)));
      grid.appendChild(row);
    }

    const blocks = timed.map((item) => {
      const top = (item.startMin / 60 - startHour) * HOUR_PX;
      const height = Math.max(MIN_BLOCK_PX, ((item.endMin - item.startMin) / 60) * HOUR_PX - 2);
      return { ...item, top, bottom: top + height, height };
    });
    this.layoutColumns(blocks);

    for (const block of blocks) {
      const { event } = block;
      const node = this.html('div', 'live-calendar-block');
      const colWidth = 100 / block.cols;
      node.style.top = `${block.top + 1}px`;
      node.style.height = `${block.height}px`;
      node.style.left = `calc(var(--lc-gutter) + (100% - var(--lc-gutter) - 8px) * ${block.col / block.cols})`;
      node.style.width = `calc((100% - var(--lc-gutter) - 8px) * ${colWidth / 100} - 3px)`;
      if (now >= eventStartMs(event) && now <= (eventEndMs(event) || 0)) node.setAttribute('data-live', 'true');

      const title = this.html('span', 'live-calendar-block-title', event.title || 'Event');
      node.appendChild(title);
      if (block.height >= 40) {
        const when = `${formatClock(event.start)} – ${formatClock(event.end)}`;
        node.appendChild(this.html('span', 'live-calendar-block-time', when));
      }
      if (canJoin(event, now)) {
        const join = this.html('button', 'live-calendar-join', 'Join');
        join.type = 'button';
        join.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.app.tabs.join(event);
        });
        node.appendChild(join);
      }
      node.addEventListener('click', () => this.app.tabs.openEvent(event));
      grid.appendChild(node);
    }

    if (nowMin >= startHour * 60 && nowMin <= endHour * 60) {
      const line = this.html('div', 'live-calendar-now');
      line.style.top = `${(nowMin / 60 - startHour) * HOUR_PX}px`;
      line.appendChild(this.html('span', 'live-calendar-now-dot'));
      grid.appendChild(line);
    }

    scroll.appendChild(grid);

    const nowTop = (nowMin / 60 - startHour) * HOUR_PX;
    this.app.window.requestAnimationFrame(() => {
      const target = scrollToNow
        ? Math.max(0, nowTop - HOUR_PX * 1.2 + (loose.length ? 0 : 0))
        : previousTop;
      scroll.scrollTop = target;
    });
  }
}
