const {
  CONFIG,
  debugLog,
  fnv1a,
  getGmailUrlPattern,
  getTabUserContextId,
  gmailAccountSlotFromHints,
  normalizeGmailOpenUrl
} = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailUtil.sys.mjs' + new URL(import.meta.url).search
);

const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
const Cr = globalThis.Cr || Components.results;

function cancelAuthPrompt() {
  return {
    QueryInterface: ChromeUtils.generateQI([
      Ci.nsIInterfaceRequestor,
      Ci.nsIAuthPrompt,
      Ci.nsIAuthPrompt2
    ]),
    getInterface(iid) {
      return this.QueryInterface(iid);
    },
    prompt() {
      return false;
    },
    promptUsernameAndPassword() {
      return false;
    },
    promptPassword() {
      return false;
    },
    promptAuth() {
      return false;
    },
    asyncPromptAuth(_channel, callback) {
      try {
        callback.onAuthCancelled(null, false);
      } catch (e) {}
    }
  };
}

export class LiveGmailAtom {
  constructor(app) {
    this.app = app;
  }

  getFeedUrl(tab) {
    const slot = gmailAccountSlotFromHints(this.app.tabs.getUrlHints(tab));
    return `https://${getGmailUrlPattern()}/mail/u/${slot}/feed/atom`;
  }

  parse(xml, feedUrl) {
    const feed = new this.app.window.DOMParser().parseFromString(xml, 'application/xml');
    if (feed.documentElement?.localName !== 'feed' || feed.querySelector('parsererror')) {
      throw new Error('Not an Atom feed');
    }

    const value = (node, name) =>
      (node.getElementsByTagNameNS('*', name)[0]?.textContent || '').trim();

    const items = Array.from(feed.getElementsByTagNameNS('*', 'entry')).map((entry, sourceRank) => {
      const atomId = value(entry, 'id');
      const subject = value(entry, 'title') || '(No subject)';
      const sender = value(entry, 'name') || value(entry, 'email') || 'Unknown';
      const snippet = value(entry, 'summary').slice(0, 200);
      const link = Array.from(entry.getElementsByTagNameNS('*', 'link')).find(
        (node) => !node.getAttribute('rel') || node.getAttribute('rel') === 'alternate'
      );
      let url = '';
      try {
        url = new URL(link?.getAttribute('href') || '', feedUrl).href;
      } catch (e) {}
      url = normalizeGmailOpenUrl(url);
      const date =
        value(entry, 'issued') ||
        value(entry, 'published') ||
        value(entry, 'modified') ||
        value(entry, 'updated');
      const ts = Date.parse(date);
      const id = 'gmail:atom:' + fnv1a(atomId || url + '|' + subject);
      return {
        id,
        threadId: id,
        from: sender,
        subject,
        snippet,
        date: Number.isFinite(ts) ? new Date(ts).toISOString() : date,
        ts: Number.isFinite(ts) ? ts : 0,
        isUnread: true,
        url,
        rowIndex: sourceRank
      };
    });

    items.sort((a, b) => (b.ts || 0) - (a.ts || 0) || a.rowIndex - b.rowIndex);
    return items.slice(0, CONFIG.MAX_EMAILS);
  }

  fetchXml(feedUrl, userContextId) {
    const uri = Services.io.newURI(feedUrl);
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {
      userContextId: userContextId || 0
    });
    const channel = NetUtil.newChannel({
      uri,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
      loadingPrincipal: principal,
      triggeringPrincipal: principal,
      securityFlags:
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL |
        Ci.nsILoadInfo.SEC_COOKIES_INCLUDE
    }).QueryInterface(Ci.nsIHttpChannel);
    channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING;
    channel.notificationCallbacks = cancelAuthPrompt();

    const win = this.app.window;
    return new Promise((resolve, reject) => {
      const chunks = [];
      let totalLength = 0;
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        win.clearTimeout(timer);
        fn(value);
      };

      const timer = win.setTimeout(() => {
        try {
          channel.cancel(Cr.NS_BINDING_ABORTED);
        } catch (e) {}
        finish(reject, new Error('Timeout'));
      }, CONFIG.ATOM_TIMEOUT_MS);

      channel.asyncOpen({
        onStartRequest() {},
        onDataAvailable(request, stream, _offset, count) {
          totalLength += count;
          if (totalLength > CONFIG.ATOM_MAX_BYTES) {
            request.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
            return;
          }
          chunks.push(NetUtil.readInputStream(stream, count));
        },
        onStopRequest(_request, status) {
          if (!Components.isSuccessCode(status)) {
            finish(reject, new Error('Network error'));
            return;
          }
          const bytes = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
          }
          let httpStatus = 0;
          let finalUrl = feedUrl;
          try {
            httpStatus = channel.responseStatus;
          } catch (e) {}
          try {
            finalUrl = channel.URI.spec;
          } catch (e) {}
          finish(resolve, {
            status: httpStatus,
            finalUrl,
            text: new TextDecoder('utf-8').decode(bytes)
          });
        }
      });
    });
  }

  applyEmails(allEmails, targetKey) {
    const app = this.app;
    const viewKey = app.activePanelContextKey;
    const restoreView = targetKey && viewKey && targetKey !== viewKey;
    if (targetKey && restoreView) {
      app.cache.activate(targetKey);
    }

    const clickedIds = app.clickedEmailIds;
    const nextEmails = allEmails.filter((email) => !clickedIds.has(email.id));
    app.currentEmails = nextEmails;
    app.cachedEmails = nextEmails.slice();

    const ctx = app.cache.getOrCreateContext(targetKey);
    ctx.hasScanned = true;
    ctx.lastScanTs = Date.now();
    app.cache.persistActive(targetKey);
    app.cache.save();

    const currentIds = new Set(allEmails.map((email) => email.id));
    for (const clickedId of clickedIds) {
      if (!currentIds.has(clickedId)) clickedIds.delete(clickedId);
    }

    app.scanContextKey = null;
    app.loadScansInFlight.delete(targetKey);

    if (restoreView && viewKey) {
      app.cache.activate(viewKey);
    }

    app.scanInProgress = false;
    if (targetKey === viewKey) {
      app.panel.hideError();
      app.panel.updateDisplay();
    }
  }

  async fetchViaTab(tab, feedUrl) {
    const browser = tab?.linkedBrowser;
    const windowGlobal = browser?.browsingContext?.currentWindowGlobal;
    if (!windowGlobal) {
      debugLog('Tab Atom unavailable: no current window global');
      return null;
    }
    let actor;
    try {
      actor = windowGlobal.getActor('LiveGmail');
    } catch (e) {
      debugLog('Tab Atom unavailable: actor lookup failed', e?.message || e);
      return null;
    }
    if (!actor?.sendQuery) {
      debugLog('Tab Atom unavailable: actor has no query channel');
      return null;
    }
    return actor.sendQuery('LiveGmail:FetchAtom', { feedUrl });
  }

  onFeedDocument(browser, data) {
    const pending = this.pendingFeedBrowsers?.get(browser);
    if (!pending) return;
    debugLog(
      'Feed document',
      data?.root || '',
      data?.contentType || '',
      (data?.text || '').length,
      data?.href || ''
    );
    pending.resolve({
      status: data?.signin || !data?.text ? 401 : 200,
      finalUrl: data?.href || '',
      text: data?.text || ''
    });
  }

  fetchViaDocument(feedUrl, userContextId) {
    const win = this.app.window;
    const doc = win.document;
    const browser = doc.createXULElement('browser');
    browser.setAttribute('type', 'content');
    browser.setAttribute('remote', 'true');
    browser.setAttribute('maychangeremoteness', 'true');
    browser.setAttribute('disableglobalhistory', 'true');
    browser.setAttribute('nodefaultsrc', 'true');
    browser.setAttribute('usercontextid', String(userContextId || 0));
    browser.style.cssText = 'position:fixed;left:-10000px;width:16px;height:16px;opacity:0;pointer-events:none;';
    doc.documentElement.appendChild(browser);
    if (!this.pendingFeedBrowsers) this.pendingFeedBrowsers = new Map();

    return new Promise((resolve, reject) => {
      let settled = false;
      let listener = null;
      const timer = win.setTimeout(() => finish(reject, new Error('Timeout')), CONFIG.ATOM_TIMEOUT_MS);

      const cleanup = () => {
        win.clearTimeout(timer);
        this.pendingFeedBrowsers.delete(browser);
        if (listener) {
          try { browser.removeProgressListener(listener); } catch (e) {}
          listener = null;
        }
        try { browser.remove(); } catch (e) {}
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      this.pendingFeedBrowsers.set(browser, {
        resolve: (result) => finish(resolve, result)
      });

      listener = {
        QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
        onLocationChange(_progress, _request, location) {
          const spec = location?.spec || '';
          if (/accounts\.google\.com|ServiceLogin/i.test(spec)) {
            finish(resolve, { status: 401, finalUrl: spec, text: '' });
          }
        },
        onStateChange() {},
        onProgressChange() {},
        onStatusChange() {},
        onSecurityChange() {},
        onContentBlockingEvent() {}
      };

      const start = () => {
        try {
          browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION);
        } catch (e) {}
        try {
          const loadFlags = Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_HISTORY | Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE;
          const triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
          if (browser.fixupAndLoadURIString) {
            browser.fixupAndLoadURIString(feedUrl, { triggeringPrincipal, loadFlags });
          } else {
            browser.loadURI(Services.io.newURI(feedUrl), { triggeringPrincipal, loadFlags });
          }
        } catch (e) {
          finish(reject, e);
        }
      };

      if (browser.browsingContext) start();
      else browser.addEventListener('XULFrameLoaderCreated', start, { once: true });
    });
  }

  async requestScan(tab, { force = false } = {}) {
    if (!tab) return;
    const app = this.app;
    const contextKey = app.getPanelContextKey(tab);
    const feedUrl = this.getFeedUrl(tab);
    const cached = app.atomMemCache[contextKey];
    if (
      !force &&
      cached &&
      cached.feedUrl === feedUrl &&
      Date.now() - cached.ts < CONFIG.ATOM_CACHE_MS
    ) {
      if (
        app.activePanelContextKey !== contextKey ||
        (app.currentEmails.length === 0 && app.cachedEmails.length === 0)
      ) {
        this.applyEmails(cached.emails, contextKey);
      }
      return;
    }

    if (app.atomInFlight.has(contextKey)) return;
    app.atomInFlight.add(contextKey);
    app.scanContextKey = contextKey;
    app.loadScansInFlight.add(contextKey);

    if (app.panel.shouldShowLoadProgress(contextKey)) {
      app.scanInProgress = true;
      app.panel.updateDisplay();
    }

    try {
      debugLog('Atom via document');
      const fetched = await this.fetchViaDocument(feedUrl, getTabUserContextId(tab));
      const { status, finalUrl, text } = fetched;
      if (status === 401 || status === 403) {
        const err = new Error('Sign-in required');
        err.signin = true;
        throw err;
      }
      const head = (text || '').slice(0, 2000);
      if (
        /accounts\.google\.com|ServiceLogin/i.test(finalUrl || '') ||
        /accounts\.google\.com|ServiceLogin/i.test(head)
      ) {
        const err = new Error('Sign-in required');
        err.signin = true;
        throw err;
      }
      if (status < 200 || status >= 300) {
        throw new Error('HTTP ' + status);
      }
      if (
        finalUrl &&
        finalUrl !== feedUrl &&
        !finalUrl.startsWith('https://mail.google.com/mail/')
      ) {
        throw new Error('Feed URL changed');
      }

      const emails = this.parse(text, feedUrl);
      app.atomMemCache[contextKey] = { ts: Date.now(), feedUrl, emails };
      debugLog('Atom scan', emails.length, 'unread, context=', contextKey);
      this.applyEmails(emails, contextKey);
    } catch (e) {
      debugLog('Atom fetch failed', e && e.message ? e.message : e);
      app.scanInProgress = false;
      app.loadScansInFlight.delete(contextKey);
      if (app.scanContextKey === contextKey) app.scanContextKey = null;
      if (
        e?.signin &&
        app.activePanelContextKey === contextKey &&
        app.currentEmails.length === 0 &&
        app.cachedEmails.length === 0
      ) {
        app.panel.showError('Sign in to Gmail to see unread mail');
      }
      app.panel.updateDisplay();
    } finally {
      app.atomInFlight.delete(contextKey);
      app.tabs.finishLoadScan(tab);
    }
  }

  onReadStateChanged(tab) {
    if (!tab || !this.app.tabs.isGmailAnchor(tab)) return;
    const contextKey = this.app.getPanelContextKey(tab);
    const win = this.app.window;
    if (this.app.readStateTimers.has(contextKey)) {
      win.clearTimeout(this.app.readStateTimers.get(contextKey));
    }
    this.app.readStateTimers.set(
      contextKey,
      win.setTimeout(() => {
        this.app.readStateTimers.delete(contextKey);
        this.requestScan(tab, { force: true });
      }, 400)
    );
  }

  scanContext(contextKey = this.app.activePanelContextKey || this.app.getPanelContextKey()) {
    const anchor =
      this.app.tabs.findLoadedAnchor(contextKey) || this.app.tabs.findAnchor(contextKey);
    if (!anchor) return false;
    this.app.tabs.performLoadScan(anchor);
    return true;
  }
}
