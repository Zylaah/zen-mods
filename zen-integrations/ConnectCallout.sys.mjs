const {
  debugLog,
  getContextContainerId,
  chromeAnimating,
  isEssentialOrPinnedTab
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);
const { providerOf, resolveAccountId } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Accounts.sys.mjs' + new URL(import.meta.url).search
);

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const CONNECT_SEEN_PREF = 'zen-integrations.connect-callout.dismissed';

let connectSeen = null;

function connectSeenSet() {
  if (connectSeen) return connectSeen;
  connectSeen = new Set();
  try {
    for (const key of Services.prefs.getStringPref(CONNECT_SEEN_PREF, '').split(',')) {
      if (key) connectSeen.add(key);
    }
  } catch (e) {}
  return connectSeen;
}

function persistConnectSeen() {
  try {
    Services.prefs.setStringPref(CONNECT_SEEN_PREF, [...connectSeenSet()].join(','));
  } catch (e) {}
}

function rememberConnectSeen(key) {
  const seen = connectSeenSet();
  if (seen.has(key)) return;
  seen.add(key);
  persistConnectSeen();
}

function forgetConnectSeen(accountId) {
  const seen = connectSeenSet();
  const provider = providerOf(accountId);
  const container = getContextContainerId(accountId);
  if (!provider) return;
  let changed = false;
  for (const key of [...seen]) {
    if (providerOf(key) !== provider || getContextContainerId(key) !== container) continue;
    seen.delete(key);
    changed = true;
  }
  if (changed) persistConnectSeen();
}

export class ConnectCallout {
  constructor(tabs) {
    this.tabs = tabs;
  }

  get window() {
    return this.tabs.window;
  }

  get app() {
    return this.tabs.app;
  }

  get gBrowser() {
    return this.tabs.gBrowser;
  }

  providerFor(tab) {
    return this.tabs.providerFor(tab);
  }

  getUrlHints(tab) {
    return this.tabs.getUrlHints(tab);
  }

  calloutTabs() {
    const tabs = [];
    const seen = new Set();
    const add = (tab) => {
      if (!tab || seen.has(tab)) return;
      seen.add(tab);
      tabs.push(tab);
    };
    try {
      for (const tab of this.gBrowser?.tabs || []) add(tab);
    } catch (e) {}
    try {
      const extra = this.window.document.querySelectorAll(
        '#zen-essentials .tabbrowser-tab, .zen-essentials-container .tabbrowser-tab, .zen-workspace-pinned-tabs-section .tabbrowser-tab'
      );
      for (const tab of extra) add(tab);
    } catch (e) {}
    return tabs;
  }

  calloutAnchorVisible(tab) {
    const win = tab?.ownerGlobal;
    if (!tab?.isConnected || !win) return false;
    const essentials = tab.closest('.zen-essentials-container');
    if (essentials?.hasAttribute('hidden')) return false;
    const space = tab.closest('zen-workspace');
    if (space) {
      const activeId = win.gZenWorkspaces?.activeWorkspace;
      if (activeId && space.id && space.id !== activeId) return false;
    }
    return true;
  }

  connectIdentity(tab) {
    if (!isEssentialOrPinnedTab(tab)) return null;
    const provider = this.providerFor(tab);
    let key = '';
    let accountProvider = '';
    if (provider) {
      key = provider.contextKey(tab, this.getUrlHints(tab));
      accountProvider = provider.id === 'gmail' ? 'google' : provider.id;
    } else if (this.app.calendar?.tabs.isCalendarAnchor(tab)) {
      key = this.app.calendar.tabs.accountKey(tab);
      accountProvider = 'google';
    }
    if (!key) return null;
    const container = getContextContainerId(key);
    // An essential with no container id stays on the default jar. Skip it.
    if (tab.hasAttribute('zen-essential') && !(container > 0)) return null;
    return {
      tab,
      key,
      container,
      accountProvider,
      essential: tab.hasAttribute('zen-essential')
    };
  }

  connectCandidate(tab, seen) {
    const item = this.connectIdentity(tab);
    if (!item || seen.has(item.key) || resolveAccountId(item.key)) return null;
    return item;
  }

  nextConnectCandidate() {
    const seen = connectSeenSet();
    const byKey = new Map();
    for (const tab of this.calloutTabs()) {
      const item = this.connectCandidate(tab, seen);
      if (!item) continue;
      const current = byKey.get(item.key);
      if (!current || (item.essential && !current.essential)) byKey.set(item.key, item);
    }
    return byKey.values().next().value || null;
  }

  connectSnapshot() {
    const seen = connectSeenSet();
    return this.calloutTabs().map((tab) => {
      const identity = this.connectIdentity(tab);
      return {
        label: tab.getAttribute('label') || tab.label || '',
        pinned: !!tab.pinned,
        essential: tab.hasAttribute('zen-essential'),
        key: identity?.key || '',
        seen: identity ? seen.has(identity.key) : false,
        account: identity ? resolveAccountId(identity.key) : '',
        visible: this.calloutAnchorVisible(tab)
      };
    });
  }

  maybeShowConnectCallout() {
    if (this.connectCallout || this.connectCalloutPending) return;
    const item = this.nextConnectCandidate();
    if (item) {
      this.tabs.layoutRetries = 0;
      this.connectCalloutPending = true;
      this.openConnectCallout(item);
      return;
    }
    const rows = this.connectSnapshot().filter((row) => row.key && !row.account);
    if (rows.length) {
      debugLog('Connect callout skipped', JSON.stringify(rows));
    }
  }

  forgetConnectSeen(accountId) {
    forgetConnectSeen(accountId);
  }

  hideConnectCallout() {
    if (typeof this.connectCleanup === 'function') {
      const cleanup = this.connectCleanup;
      this.connectCleanup = null;
      cleanup();
    }
  }

  pinConnectSidebar() {
    const box = this.window.document.getElementById('navigator-toolbox');
    if (!box) return;
    box.setAttribute('zen-user-show', 'true');
    this.connectToolbox = box;
    this.app.panel.pinCompactChrome(this.connectTab);
  }

  unpinConnectSidebar() {
    if (this.connectToolbox?.getAttribute('zen-user-show') === 'true') {
      this.connectToolbox.removeAttribute('zen-user-show');
    }
    this.connectToolbox = null;
    this.app.panel.unpinCompactChrome();
  }

  positionConnectCallout(card, tab) {
    const win = this.window;
    const width = 244;
    const height = card.getBoundingClientRect().height || 90;
    const gap = 12;
    const isRightSide =
      win.document.documentElement.getAttribute('zen-right-side') === 'true' ||
      !!win.gZenVerticalTabsManager?._prefsRightSide;
    card.dataset.side = isRightSide ? 'right' : 'left';
    const anchor = tab?.querySelector?.('.tab-content, .tab-icon-stack') || tab;
    const rect = anchor?.getBoundingClientRect?.() || { left: 24, right: 24, top: 80, width: 0, height: 0 };
    const rawLeft = isRightSide ? rect.left - width - gap : (rect.right || 0) + gap;
    const left = Math.max(12, Math.min(rawLeft || 12, win.innerWidth - width - 12));
    const rawTop = (rect.top || 80) + (rect.height || 0) / 2 - height / 2;
    const top = Math.max(12, Math.min(rawTop || 80, win.innerHeight - height - 12));
    const tailY = Math.max(18, Math.min((rect.top || 80) + (rect.height || 0) / 2 - top, height - 18));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.setProperty('--zi-tail-y', `${Math.round(tailY)}px`);
    card.style.transformOrigin = `${isRightSide ? '100%' : '0%'} ${Math.round(tailY)}px`;
    return true;
  }

  openConnectCallout(item) {
    const win = this.window;
    const doc = win.document;
    const { tab, key, container, accountProvider } = item;
    this.hideConnectCallout();
    doc.getElementById('zi-connect')?.remove();
    this.connectTab = tab;
    this.pinConnectSidebar();

    const make = (tag, className, parent, text) => {
      const node = doc.createElementNS(HTML_NS, tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      parent?.append(node);
      return node;
    };

    const card = make('div', 'zi-connect');
    card.id = 'zi-connect';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Connect to preview on hover');
    const scheme = win.getComputedStyle?.(doc.documentElement)?.colorScheme;
    if (scheme) card.style.colorScheme = scheme;
    const arrow = make('div', 'zi-connect-arrow', card);
    arrow.setAttribute('aria-hidden', 'true');
    const close = make('button', 'zi-connect-close', card, '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    make('div', 'zi-connect-title', card, 'Connect to preview on hover');
    const button = make('button', 'zi-connect-button', card, 'Connect');
    button.type = 'button';

    (doc.getElementById('browser') || doc.documentElement).appendChild(card);
    this.positionConnectCallout(card, tab);
    card.offsetWidth;
    card.setAttribute('data-open', '');
    this.connectCallout = card;
    this.connectCalloutPending = false;
    debugLog('Connect callout shown', key, tab.label);

    const reposition = () => {
      if (chromeAnimating(win)) return;
      this.positionConnectCallout(card, tab);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      rememberConnectSeen(key);
      this.hideConnectCallout();
      win.setTimeout(() => this.maybeShowConnectCallout(), 0);
    };
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('resize', reposition);
    const positionTimer = win.setInterval(reposition, 400);

    this.connectCleanup = () => {
      win.clearInterval(positionTimer);
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('resize', reposition);
      card.remove();
      this.unpinConnectSidebar();
      if (this.connectCallout === card) this.connectCallout = null;
      this.connectTab = null;
    };

    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      rememberConnectSeen(key);
      this.hideConnectCallout();
      win.setTimeout(() => this.maybeShowConnectCallout(), 0);
    });

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      rememberConnectSeen(key);
      this.hideConnectCallout();
      try {
        const { connectDiscoveredAccount } = ChromeUtils.importESModule(
          'chrome://sine/content/zen-integrations/Settings.sys.mjs' + new URL(import.meta.url).search
        );
        connectDiscoveredAccount(win, accountProvider, container).catch((error) => {
          console.warn('[Zen Integrations] Connect from callout failed', error);
        });
      } catch (error) {
        console.warn('[Zen Integrations] Connect import failed', error);
      }
      win.setTimeout(() => this.maybeShowConnectCallout(), 0);
    });
  }
}
