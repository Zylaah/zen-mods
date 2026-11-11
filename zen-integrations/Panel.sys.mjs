const {
  CONFIG,
  XUL_NS,
  escapeHtml,
  isPinnedStripTab
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);

function formatDate(dateString) {
  if (!dateString) return '';
  try {
    let cleanDate = dateString.trim();
    const timeMatch = cleanDate.match(/^(.+?)\s+\d{1,2}[\/:]\d{1,2}/);
    if (timeMatch) cleanDate = timeMatch[1].trim();
    const parsed = Date.parse(cleanDate);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    const monthDayMatch = cleanDate.match(/(\w+)\s+(\d{1,2})/i);
    if (monthDayMatch) return monthDayMatch[1] + ' ' + monthDayMatch[2];
    return cleanDate;
  } catch (e) {
    return dateString;
  }
}

export class ZenPanel {
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

  shouldShowLoadProgress(contextKey) {
    const app = this.app;
    if (app.activePanelContextKey !== contextKey || !this.isOpen()) return false;
    return app.currentEmails.length === 0 && app.cachedEmails.length === 0;
  }

  create() {
    const app = this.app;
    if (app.panelElement) return;
    const document = this.document;

    const panel = document.createElementNS(XUL_NS, 'panel');
    panel.id = CONFIG.PANEL_ID;
    panel.setAttribute('type', 'arrow');
    panel.setAttribute('nonnativepopover', 'true');
    panel.setAttribute('orient', 'vertical');
    panel.setAttribute('side', 'left');
    panel.setAttribute('noautohide', 'true');
    panel.setAttribute('level', 'top');

    const header = document.createElement('div');
    header.className = 'zi-header';
    const title = document.createElement('span');
    title.className = 'zi-title';
    title.textContent = 'Unread';
    header.appendChild(title);

    const content = document.createElement('div');
    content.className = 'zi-content';
    const loading = document.createElement('div');
    loading.className = 'zi-loading';
    loading.textContent = 'Loading unread mail...';
    const emails = document.createElement('div');
    emails.className = 'zi-emails';
    const error = document.createElement('div');
    error.className = 'zi-error';
    error.style.display = 'none';
    content.appendChild(loading);
    content.appendChild(emails);
    content.appendChild(error);

    const wrapper = document.createElement('div');
    wrapper.className = 'zi-wrapper';
    const composeButton = document.createElement('button');
    composeButton.type = 'button';
    composeButton.className = 'zi-compose';
    composeButton.setAttribute('aria-label', 'New message');
    composeButton.title = 'New message';
    composeButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>`;
    composeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      app.tabs.openCompose();
    });

    wrapper.appendChild(header);
    wrapper.appendChild(content);
    wrapper.appendChild(composeButton);
    panel.appendChild(wrapper);
    document.documentElement.appendChild(panel);

    panel.addEventListener('mouseenter', () => {
      if (app.hideTimer) {
        app.window.clearTimeout(app.hideTimer);
        app.hideTimer = null;
      }
    });
    panel.addEventListener('mouseleave', () => this.scheduleHide());
    panel.addEventListener('popuphidden', () => this.unpinCompactChrome());

    app.panelElement = panel;
    this.updateTheme();
    this.watchThemeChanges();
  }

  updateTheme() {
    const panel = this.app.panelElement;
    if (!panel) return;
    const document = this.document;
    const win = this.app.window;
    let isDark = false;
    try {
      const zenDark = document.documentElement.getAttribute('zen-should-be-dark-mode');
      if (zenDark === 'true') isDark = true;
      else if (zenDark === 'false') isDark = false;
      else {
        const zenScheme = Services.prefs.getIntPref('zen.view.window.scheme', 2);
        if (zenScheme === 0) isDark = true;
        else if (zenScheme === 1) isDark = false;
        else isDark = win.matchMedia?.('(prefers-color-scheme: dark)').matches;
      }
    } catch (e) {
      isDark = win.matchMedia?.('(prefers-color-scheme: dark)').matches;
    }
    if (isDark) panel.setAttribute('data-theme', 'dark');
    else panel.removeAttribute('data-theme');
  }

  watchThemeChanges() {
    const win = this.app.window;
    if (win.matchMedia) {
      win.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.updateTheme());
    }
    try {
      Services.prefs.addObserver('zen.view.window.scheme', () => this.updateTheme(), false);
    } catch (e) {}
    const observer = new win.MutationObserver(() => this.updateTheme());
    observer.observe(this.document.documentElement, {
      attributes: true,
      attributeFilter: ['zen-should-be-dark-mode', 'data-theme']
    });
  }

  getCompactPinTarget(tab) {
    const document = this.document;
    if (tab) {
      const inner = tab.querySelector('.tab-content, .tab-icon-stack');
      if (inner) return inner;
      const strip = tab.closest(
        '#zen-essentials, .zen-essentials-container, .zen-workspace-pinned-tabs-section'
      );
      if (strip) return strip;
    }
    return (
      document.getElementById('zen-essentials') ||
      document.querySelector('.zen-essentials-container') ||
      document.querySelector('.zen-workspace-pinned-tabs-section')
    );
  }

  pinCompactChrome(tab) {
    const target = this.getCompactPinTarget(tab);
    if (this.app.compactPinTarget && this.app.compactPinTarget !== target) this.unpinCompactChrome();
    if (!target) return;
    this.app.compactPinTarget = target;
    target.setAttribute('open', 'true');
    target.setAttribute('data-zi-compact-pin', 'true');
  }

  unpinCompactChrome() {
    const target = this.app.compactPinTarget;
    if (!target) return;
    if (target.hasAttribute('data-zi-compact-pin')) {
      target.removeAttribute('open');
      target.removeAttribute('data-zi-compact-pin');
    }
    this.app.compactPinTarget = null;
  }

  getFolderStylePopupOptions() {
    const isRightSide = !!this.app.window.gZenVerticalTabsManager?._prefsRightSide;
    const rows = Math.min(
      Math.max((this.app.currentEmails.length || this.app.cachedEmails.length || 0) + 1, 1),
      6
    );
    return {
      position: isRightSide ? 'topleft topright' : 'topright topleft',
      x: isRightSide ? -10 : 10,
      y: (rows * 48) / -2
    };
  }

  openAt(tab) {
    const panel = this.app.panelElement;
    if (!panel) return;
    const document = this.document;
    if (isPinnedStripTab(tab)) {
      const isRightSide = !!this.app.window.gZenVerticalTabsManager?._prefsRightSide;
      panel.setAttribute('side', isRightSide ? 'right' : 'left');
      const anchor = tab?.querySelector('.tab-content, .tab-icon-stack') || tab;
      panel.openPopup(anchor || document.documentElement, this.getFolderStylePopupOptions());
      return;
    }
    panel.setAttribute('side', 'left');
    const tabHeight = tab ? tab.getBoundingClientRect().height : 0;
    panel.openPopup(tab || document.documentElement, 'end_before', 4, tabHeight);
  }

  cancelShowTimer() {
    if (this.app.showTimer) {
      this.app.window.clearTimeout(this.app.showTimer);
      this.app.showTimer = null;
    }
    this.app.pendingShowTab = null;
  }

  scheduleShow(tab) {
    if (!tab || !this.app.tabs.isAnchor(tab)) return;
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
    const app = this.app;
    const provider = app.tabs.providerFor(tab);
    if (!provider || !app.tabs.isAnchor(tab)) {
      this.hide();
      return;
    }
    const contextKey = provider.contextKey(tab, app.tabs.getUrlHints(tab));
    app.cache.activate(contextKey);
    app.hoveredTab = tab;
    if (!app.panelElement) this.create();
    const title = app.panelElement.querySelector('.zi-title');
    if (title) title.textContent = provider.label;
    this.updateTheme();
    if (app.hideTimer) {
      app.window.clearTimeout(app.hideTimer);
      app.hideTimer = null;
    }
    this.pinCompactChrome(tab);
    this.openAt(tab);
    this.updateDisplay();
    app.scan.requestScan(tab, { force: false });
  }

  scheduleHide() {
    if (this.app.hideTimer) this.app.window.clearTimeout(this.app.hideTimer);
    const delayMs = this.app.scanInProgress ? 350 : 200;
    this.app.hideTimer = this.app.window.setTimeout(() => {
      this.app.hideTimer = null;
      if (this.app.hoveredTab?.matches(':hover')) return;
      if (this.app.pendingShowTab?.matches(':hover')) return;
      if (this.app.panelElement?.matches(':hover')) return;
      this.hide();
    }, delayMs);
  }

  hide() {
    if (this.app.hideTimer) {
      this.app.window.clearTimeout(this.app.hideTimer);
      this.app.hideTimer = null;
    }
    this.cancelShowTimer();
    this.app.cache.persistActive(this.app.activePanelContextKey);
    this.unpinCompactChrome();
    if (this.app.panelElement) this.app.panelElement.hidePopup();
    this.app.hoveredTab = null;
  }

  showError(message) {
    const panel = this.app.panelElement;
    if (!panel) return;
    const el = panel.querySelector('.zi-error');
    const loading = panel.querySelector('.zi-loading');
    if (el) {
      el.textContent = message;
      el.style.display = 'block';
    }
    if (loading) loading.style.display = 'none';
  }

  hideError() {
    const el = this.app.panelElement?.querySelector('.zi-error');
    if (!el) return;
    el.style.display = 'none';
    el.textContent = '';
  }

  updateDisplay() {
    const app = this.app;
    const panel = app.panelElement;
    if (!panel) return;
    this.hideError();
    const document = this.document;
    const emailsContainer = panel.querySelector('.zi-emails');
    const loadingContainer = panel.querySelector('.zi-loading');
    const composeBtn = panel.querySelector('.zi-compose');
    if (!emailsContainer) return;

    const emailsToShow = app.currentEmails.length > 0 ? app.currentEmails : app.cachedEmails;
    const setComposeVisible = (visible) => {
      if (composeBtn) composeBtn.style.display = visible ? '' : 'none';
    };
    const awaitingFirstScan = app.loadScansInFlight.has(app.activePanelContextKey);
    if ((app.scanInProgress || awaitingFirstScan) && emailsToShow.length === 0) {
      if (loadingContainer) loadingContainer.style.display = 'block';
      emailsContainer.innerHTML = '';
      setComposeVisible(false);
      return;
    }

    if (loadingContainer) loadingContainer.style.display = 'none';
    emailsContainer.innerHTML = '';

    if (emailsToShow.length === 0) {
      const contextAnchor = app.tabs.findAnchor(app.activePanelContextKey);
      const isUnloaded = !contextAnchor || app.tabs.isDiscardedOrUnloaded(contextAnchor);
      const hasScanned = app.cache.getOrCreateContext(app.activePanelContextKey).hasScanned;
      const provider = app.providerForKey(app.activePanelContextKey);
      const emptyMessage =
        isUnloaded && !hasScanned
          ? (provider?.signInMessage || 'Sign in to see unread mail')
          : 'No unread mail';
      emailsContainer.innerHTML = `<div class="zi-empty">${emptyMessage}</div>`;
      setComposeVisible(false);
      return;
    }

    setComposeVisible(true);
    for (const email of emailsToShow) {
      const el = document.createElement('div');
      el.className = 'zi-item';
      if (email.isUnread) el.classList.add('zi-unread');
      const from = String(email.from || '').replace(/<[^>]*>/g, '').trim();
      el.innerHTML = `
        <div class="zi-item-header">
          <span class="zi-from">${escapeHtml(document, from)}</span>
          <span class="zi-date">${escapeHtml(document, formatDate(email.date))}</span>
        </div>
        <div class="zi-subject">${escapeHtml(document, email.subject || '(No subject)')}</div>
        <div class="zi-snippet-wrap"><div class="zi-snippet">${escapeHtml(document, email.snippet || '')}</div></div>
      `;
      el.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        app.tabs.openEmail(email);
      });
      emailsContainer.appendChild(el);
    }
  }
}
