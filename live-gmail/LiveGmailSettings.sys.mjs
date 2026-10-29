const SETTINGS_URL = 'chrome://sine/content/live-gmail/settings.html';

function openSettings(chromeWindow) {
  const browser = chromeWindow.gBrowser;
  const existing = browser.tabs.find((tab) => {
    const spec = tab.linkedBrowser?.currentURI?.spec || '';
    return spec.split('#')[0] === SETTINGS_URL;
  });
  browser.selectedTab = existing || browser.addTrustedTab(SETTINGS_URL);
}

function hookPreferences(win, chromeWindow) {
  if (!win || win.__liveGmailSettings) return;
  let href = '';
  try {
    href = String(win.location?.href || '');
  } catch (e) {
    return;
  }
  if (!/^about:(preferences|settings)/.test(href)) return;

  win.__liveGmailSettings = true;
  const onClick = (event) => {
    const button = event.target.closest?.('.sineItemConfigureButton');
    if (button?.closest('.sineItem')?.getAttribute('mod-id') !== 'live-gmail') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openSettings(chromeWindow);
  };
  win.addEventListener('click', onClick, true);
  win.addEventListener('pagehide', () => {
    win.removeEventListener('click', onClick, true);
    delete win.__liveGmailSettings;
  }, { once: true });
}

export function attachLiveGmailSettings(chromeWindow) {
  const progressListener = {
    onLocationChange(browser, webProgress) {
      if (!webProgress?.isTopLevel) return;
      try { hookPreferences(browser.contentWindow, chromeWindow); } catch (e) {}
    },
    onStateChange(browser, webProgress, _request, flags) {
      if (!webProgress?.isTopLevel || !(flags & Ci.nsIWebProgressListener.STATE_STOP)) return;
      try { hookPreferences(browser.contentWindow, chromeWindow); } catch (e) {}
    }
  };

  chromeWindow.gBrowser.addTabsProgressListener(progressListener);
  for (const browser of chromeWindow.gBrowser.browsers) {
    try { hookPreferences(browser.contentWindow, chromeWindow); } catch (e) {}
  }

  return () => {
    try { chromeWindow.gBrowser.removeTabsProgressListener(progressListener); } catch (e) {}
  };
}
