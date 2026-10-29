const {
  CONFIG,
  XUL_NS,
  debugLog,
  escapeHtml,
  getGmailInboxUrl,
  isEssentialOrPinnedTab,
  isPinnedGmailTab,
  normalizeGmailOpenUrl
} = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailUtil.sys.mjs' + new URL(import.meta.url).search
);

function formatDate(dateString) {
  if (!dateString) return '';
  try {
    let cleanDate = dateString.trim();
    const timeMatch = cleanDate.match(/^(.+?)\s+\d{1,2}[\/:]\d{1,2}/);
    if (timeMatch) {
      cleanDate = timeMatch[1].trim();
    }
    const parsed = Date.parse(cleanDate);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    const monthDayMatch = cleanDate.match(/(\w+)\s+(\d{1,2})/i);
    if (monthDayMatch) {
      return monthDayMatch[1] + ' ' + monthDayMatch[2];
    }
    return cleanDate;
  } catch (e) {
    return dateString;
  }
}

export class LiveGmailPanel {
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
    header.className = 'live-gmail-header';

    const title = document.createElement('span');
    title.className = 'live-gmail-title';

    const gmailLogo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    gmailLogo.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    gmailLogo.setAttribute('width', '16');
    gmailLogo.setAttribute('height', '16');
    gmailLogo.setAttribute('viewBox', '0 0 48 48');
    gmailLogo.style.cssText = 'display:inline-block;vertical-align:middle;margin-right:6px';

    const path = (fill, d) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('fill', fill);
      el.setAttribute('d', d);
      return el;
    };
    gmailLogo.appendChild(path('#4caf50', 'M45,16.2l-5,2.75l-5,4.75L35,40h7c1.657,0,3-1.343,3-3V16.2z'));
    gmailLogo.appendChild(path('#1e88e5', 'M3,16.2l3.614,1.71L13,23.7V40H6c-1.657,0-3-1.343-3-3V16.2z'));
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('fill', '#e53935');
    polygon.setAttribute('points', '35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17');
    gmailLogo.appendChild(polygon);
    gmailLogo.appendChild(
      path(
        '#c62828',
        'M3,12.298V16.2l10,7.5V11.2L9.876,8.859C9.132,8.301,8.228,8,7.298,8h0C4.924,8,3,9.924,3,12.298z'
      )
    );
    gmailLogo.appendChild(
      path(
        '#fbc02d',
        'M45,12.298V16.2l-10,7.5V11.2l3.124-2.341C38.868,8.301,39.772,8,40.702,8h0 C43.076,8,45,9.924,45,12.298z'
      )
    );

    title.appendChild(gmailLogo);
    title.appendChild(document.createTextNode('Unread'));
    header.appendChild(title);

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
      app.tabs.openCompose();
    });

    wrapper.appendChild(header);
    wrapper.appendChild(content);
    wrapper.appendChild(composeButton);
    panel.appendChild(wrapper);
    document.documentElement.appendChild(panel);

    panel.addEventListener('mouseenter', () => {
      if (app.hideTimer) {
        clearTimeout(app.hideTimer);
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
      if (zenDark === 'true') {
        isDark = true;
      } else if (zenDark === 'false') {
        isDark = false;
      } else {
        const zenScheme = Services.prefs.getIntPref('zen.view.window.scheme', 2);
        if (zenScheme === 0) isDark = true;
        else if (zenScheme === 1) isDark = false;
        else isDark = win.matchMedia?.('(prefers-color-scheme: dark)').matches;
      }
    } catch (e) {
      isDark = win.matchMedia?.('(prefers-color-scheme: dark)').matches;
    }
    if (isDark) {
      panel.setAttribute('data-theme', 'dark');
    } else {
      panel.removeAttribute('data-theme');
    }
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
    if (this.app.compactPinTarget && this.app.compactPinTarget !== target) {
      this.unpinCompactChrome();
    }
    if (!target) return;
    this.app.compactPinTarget = target;
    target.setAttribute('open', 'true');
    target.setAttribute('data-live-gmail-compact-pin', 'true');
  }

  unpinCompactChrome() {
    const target = this.app.compactPinTarget;
    if (!target) return;
    if (target.hasAttribute('data-live-gmail-compact-pin')) {
      target.removeAttribute('open');
      target.removeAttribute('data-live-gmail-compact-pin');
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
    if (isPinnedGmailTab(tab)) {
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
      clearTimeout(this.app.showTimer);
      this.app.showTimer = null;
    }
    this.app.pendingShowTab = null;
  }

  scheduleShow(tab) {
    if (!tab || !this.app.tabs.isGmailAnchor(tab, this.app.getPanelContextKey(tab))) return;
    if (this.app.hideTimer) {
      clearTimeout(this.app.hideTimer);
      this.app.hideTimer = null;
    }
    if (this.isOpen()) {
      this.cancelShowTimer();
      this.show(tab);
      return;
    }
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
    const contextKey = app.getPanelContextKey(tab);
    app.cache.activate(contextKey);
    const isAnchorHover = tab && app.tabs.isGmailAnchor(tab, contextKey);

    if (tab && isEssentialOrPinnedTab(tab) && !isAnchorHover) {
      this.hide();
      return;
    }
    if (!isAnchorHover) {
      if (app.cachedEmails.length === 0 && app.currentEmails.length === 0) {
        debugLog('No Gmail hover or cached data; not showing panel');
        this.hide();
        return;
      }
    }

    app.hoveredTab = tab;
    if (!app.panelElement) this.create();
    this.updateTheme();
    if (app.hideTimer) {
      clearTimeout(app.hideTimer);
      app.hideTimer = null;
    }
    this.pinCompactChrome(tab);
    this.openAt(tab);
    this.updateDisplay();
    if (isAnchorHover) app.atom.requestScan(tab, { force: false });
  }

  scheduleHide() {
    if (this.app.hideTimer) clearTimeout(this.app.hideTimer);
    const delayMs = this.app.scanInProgress ? 350 : 200;
    this.app.hideTimer = this.app.window.setTimeout(() => {
      this.app.hideTimer = null;
      if (this.app.hoveredTab?.matches(':hover')) return;
      if (this.app.panelElement?.matches(':hover')) return;
      this.hide();
    }, delayMs);
  }

  hide() {
    if (this.app.hideTimer) {
      clearTimeout(this.app.hideTimer);
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
    const el = panel.querySelector('.live-gmail-error');
    const loading = panel.querySelector('.live-gmail-loading');
    if (el) {
      el.textContent = message;
      el.style.display = 'block';
    }
    if (loading) loading.style.display = 'none';
  }

  hideError() {
    const el = this.app.panelElement?.querySelector('.live-gmail-error');
    if (el) el.style.display = 'none';
  }

  updateDisplay() {
    const app = this.app;
    const panel = app.panelElement;
    if (!panel) return;
    const document = this.document;
    const emailsContainer = panel.querySelector('.live-gmail-emails');
    const loadingContainer = panel.querySelector('.live-gmail-loading');
    const composeBtn = panel.querySelector('.live-gmail-compose-btn');
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
      const emptyMessage =
        isUnloaded && !hasScanned ? 'Sign in to Gmail to see unread mail' : 'No unread emails';
      emailsContainer.innerHTML = `<div class="live-gmail-empty">${emptyMessage}</div>`;
      setComposeVisible(false);
      return;
    }

    setComposeVisible(true);
    for (const email of emailsToShow) {
      const el = document.createElement('div');
      el.className = 'live-gmail-email-item';
      if (email.isUnread) el.classList.add('live-gmail-unread');
      const from = email.from.replace(/<[^>]*>/g, '').trim();
      el.innerHTML = `
        <div class="live-gmail-email-header">
          <span class="live-gmail-email-from">${escapeHtml(document, from)}</span>
          <span class="live-gmail-email-date">${escapeHtml(document, formatDate(email.date))}</span>
        </div>
        <div class="live-gmail-email-subject">${escapeHtml(document, email.subject || '(No subject)')}</div>
        <div class="live-gmail-email-snippet-wrap"><div class="live-gmail-email-snippet">${escapeHtml(document, email.snippet || '')}</div></div>
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
