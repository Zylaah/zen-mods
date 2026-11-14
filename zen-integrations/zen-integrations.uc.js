// ==UserScript==
// @name           Zen Integrations
// @description    Unread Gmail, Outlook, and today's Google Calendar on essential or pinned tabs
// @author         Bxth
// @version        1.3.0
// @namespace      https://github.com/zen-browser/desktop
// ==/UserScript==

(function () {
  'use strict';

  const MOD_ROOT = 'chrome://sine/content/zen-integrations';
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
            pageshow: {},
            hashchange: {}
          }
        },
        matches: ['*://mail.google.com/*'],
        allFrames: true,
        messageManagerGroups: ['browsers'],
        safeForUntrustedWebProcess: true
      });
    } catch (err) {
      if (err?.name !== 'NotSupportedError') {
        console.error('[Zen Integrations] Could not register read-state actor:', err);
      }
    }
  }

  function registerOutlookActor() {
    if (typeof ChromeUtils.unregisterWindowActor === 'function') {
      try { ChromeUtils.unregisterWindowActor('ZenOutlook'); } catch (e) {}
    }
    try {
      ChromeUtils.registerWindowActor('ZenOutlook', {
        parent: {
          esModuleURI: `${MOD_ROOT}/actors/ZenOutlookParent.sys.mjs${MODULE_VERSION}`
        },
        child: {
          esModuleURI: `${MOD_ROOT}/actors/ZenOutlookChild.sys.mjs${MODULE_VERSION}`,
          events: {
            DOMContentLoaded: {}
          }
        },
        matches: [
          '*://outlook.live.com/*',
          '*://outlook.office.com/*',
          '*://outlook.office365.com/*',
          '*://outlook.cloud.microsoft/*'
        ],
        allFrames: false,
        messageManagerGroups: ['browsers'],
        safeForUntrustedWebProcess: true
      });
    } catch (err) {
      if (err?.name !== 'NotSupportedError') {
        console.error('[Zen Integrations] Could not register Outlook actor:', err);
      }
    }
  }

  function setupAccountCommand() {
    const add = () => {
      if (!window.ZenCommandPalette?.addCommands) return false;
      window.ZenCommandPalette.addCommands([{
        key: 'zen-integrations:accounts',
        label: 'Zen Integrations accounts',
        command: () => {
          const { showAccountSettings } = ChromeUtils.importESModule(
            `${MOD_ROOT}/Settings.sys.mjs${MODULE_VERSION}`
          );
          showAccountSettings(window);
        },
        icon: 'chrome://global/skin/icons/settings.svg',
        tags: ['Zen', 'Integrations', 'Accounts']
      }]);
      return true;
    };
    if (add()) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (add() || tries > 10) window.clearInterval(timer);
    }, 1000);
  }

  function start() {
    if (!window.gBrowser) {
      window.setTimeout(start, 200);
      return;
    }

    registerReadStateActor();
    registerOutlookActor();

    const { createZenIntegrations } = ChromeUtils.importESModule(
      `${MOD_ROOT}/App.sys.mjs${MODULE_VERSION}`
    );
    const app = createZenIntegrations(window);
    window.zenIntegrations = app;
    app.init();
    setupAccountCommand();

    window.zenIntegrationsDebug = {
      showPanel: () => {
        if (app.panelElement) {
          app.panel.pinCompactChrome(app.hoveredTab);
          app.panelElement.openPopup(document.documentElement, 'overlap', 100, 100);
        }
      },
      hidePanel: () => app.panel.hide(),
      scan: () => {
        const tab = app.tabs.anchors()[0];
        if (tab) app.scan.requestScan(tab, { force: true });
      },
      rescan: () => app.tabs.scanLoadedAnchors(),
      emails: () => app.currentEmails,
      context: () => app.activePanelContextKey,
      contexts: () => [...app.panelContexts.keys()],
      reInit: () => app.init()
    };

    if (typeof window.addUnloadListener === 'function') {
      window.addUnloadListener(() => {
        try { app.destroy(); } catch (e) {}
        if (window.zenIntegrations === app) window.zenIntegrations = null;
      });
    }
  }

  if (document.readyState === 'complete') {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
