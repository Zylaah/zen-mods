// ==UserScript==
// @name           Live Gmail Panel
// @description    Displays Gmail inbox emails in a floating panel when hovering over Gmail essential or pinned tabs
// @author         Bxth
// @version        4.1.3
// @namespace      https://github.com/zen-browser/desktop
// ==/UserScript==

(function () {
  'use strict';

  const MOD_ROOT = 'chrome://sine/content/live-gmail';
  const MODULE_VERSION = `?v=${Date.now()}`;

  function registerReadStateActor() {
    try {
      ChromeUtils.registerWindowActor('LiveGmail', {
        parent: {
          esModuleURI: `${MOD_ROOT}/actors/LiveGmailParent.sys.mjs${MODULE_VERSION}`
        },
        child: {
          esModuleURI: `${MOD_ROOT}/actors/LiveGmailChild.sys.mjs${MODULE_VERSION}`,
          events: {
            DOMContentLoaded: {},
            pageshow: {}
          }
        },
        matches: ['*://mail.google.com/*'],
        allFrames: true,
        messageManagerGroups: ['browsers'],
        safeForUntrustedWebProcess: true
      });
    } catch (err) {
      if (err?.name !== 'NotSupportedError') {
        console.error('[Live Gmail] Could not register read-state actor:', err);
      }
    }
  }

  function start() {
    if (!window.gBrowser) {
      window.setTimeout(start, 200);
      return;
    }

    registerReadStateActor();

    const { createLiveGmail } = ChromeUtils.importESModule(
      `${MOD_ROOT}/LiveGmail.sys.mjs${MODULE_VERSION}`
    );
    const app = createLiveGmail(window);
    window.liveGmail = app;
    app.init();

    window.liveGmailDebug = {
      showPanel: () => {
        if (app.panelElement) {
          app.panel.pinCompactChrome(app.hoveredTab);
          app.panelElement.openPopup(document.documentElement, 'overlap', 100, 100);
        }
      },
      hidePanel: () => app.panel.hide(),
      scan: () => {
        const tab = app.tabs.findAnchor();
        if (tab) app.atom.requestScan(tab, { force: true });
      },
      authorize: (clientId, clientSecret) => app.oauth.authorize(clientId, clientSecret).catch((error) => {
        console.error('[Live Gmail] OAuth', error && error.message ? error.message : error);
        throw error;
      }),
      disconnect: () => app.oauth.disconnect(),
      oauth: () => app.oauth.status(),
      rescan: () => app.tabs.scanLoadedAnchors(),
      emails: () => app.currentEmails,
      context: () => app.activePanelContextKey,
      contexts: () => [...app.panelContexts.keys()],
      reInit: () => app.init()
    };

    if (typeof window.addUnloadListener === 'function') {
      window.addUnloadListener(() => {
        try {
          app.destroy();
        } catch (e) {}
        if (window.liveGmail === app) window.liveGmail = null;
      });
    }
  }

  if (document.readyState === 'complete') {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
