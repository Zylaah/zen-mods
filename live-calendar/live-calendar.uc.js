// ==UserScript==
// @name           Live Calendar
// @description    Today's Google Calendar when hovering a Calendar essential or pinned tab
// @author         Bxth
// @version        1.0.14
// @namespace      https://github.com/zen-browser/desktop
// ==/UserScript==

(function () {
  'use strict';

  const MOD_ROOT = 'chrome://sine/content/live-calendar';
  const MODULE_VERSION = `?v=${Date.now()}`;

  function start() {
    if (!window.gBrowser) {
      window.setTimeout(start, 200);
      return;
    }
    const { createLiveCalendar } = ChromeUtils.importESModule(
      `${MOD_ROOT}/LiveCalendar.sys.mjs${MODULE_VERSION}`
    );
    const app = createLiveCalendar(window);
    window.liveCalendar = app;
    app.init();
    if (typeof window.addUnloadListener === 'function') {
      window.addUnloadListener(() => {
        try { app.destroy(); } catch (e) {}
        if (window.liveCalendar === app) window.liveCalendar = null;
      });
    }
  }

  if (document.readyState === 'complete') start();
  else window.addEventListener('DOMContentLoaded', start, { once: true });
})();
