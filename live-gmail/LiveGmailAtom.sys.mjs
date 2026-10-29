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
    if (!browser?.browsingContext || this.app.tabs.isPendingOrDiscarded(tab)) return null;
    let actor;
    try {
      actor = browser.browsingContext.currentWindowGlobal?.getActor('LiveGmail');
    } catch (e) {
      return null;
    }
    if (!actor?.sendQuery) return null;
    return actor.sendQuery('LiveGmail:FetchAtom', { feedUrl });
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
      let via = 'tab';
      let fetched = null;
      try {
        fetched = await this.fetchViaTab(tab, feedUrl);
      } catch (e) {
        debugLog('Tab Atom fetch failed', e && e.message ? e.message : e);
      }
      if (!fetched) {
        via = 'chrome';
        fetched = await this.fetchXml(feedUrl, getTabUserContextId(tab));
      }
      debugLog('Atom via', via);
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
