// ==UserScript==
// @name           Auto-pip
// @description    Adds auto-pip option in the unified panel
// @author         Bxth
// @version        1.4
// @namespace      https://github.com/zen-browser/desktop
// ==/UserScript==

/* eslint-env es6, browser */
/* global Services */

(function() {
  'use strict';

  // The preference for Auto Picture-in-Picture
  const PREF_PIP_AUTO = 'media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled';

  /** about:config — enable verbose Browser Console logging for this mod */
  const PREF_DEBUG = 'extensions.zen.mods.auto-pip.debug';

  /**
   * Logs to Browser Console only when {@link PREF_DEBUG} is true.
   */
  function debugLog(...args) {
    try {
      if (typeof Services === 'undefined' || !Services.prefs.getBoolPref(PREF_DEBUG, false)) {
        return;
      }
    } catch (_e) {
      return;
    }
    console.log('[zen-auto-pip]', ...args);
  }

  let addAutoPiPSettingTimeout = null;
  /** True once listeners are attached — avoids duplicates if bootstrap runs twice */
  let lifecycleHooksInstalled = false;
  let panelRetryTimer = null;
  let initRetryCount = 0;
  const INIT_RETRY_MAX = 50; // 5 seconds at 100ms intervals
  const INIT_RETRY_DELAY = 100;
  /** After fast retries fail (very late UI), keep trying slowly until the panel exists */
  const INIT_SLOW_RETRY_MS = 30000;

  /**
   * Zen may inject this script after `load` has already fired. In that case
   * `addEventListener('load', …)` never runs and init would never execute.
   * Always attempt soon; also subscribe to `load` if the document is not complete yet.
   */
  function bootstrapInit() {
    requestInitAttempt();
  }

  bootstrapInit();
  if (document.readyState !== 'complete') {
    window.addEventListener('load', bootstrapInit, { once: true });
  }

  /**
   * Find `zen-unified-site-data-panel` and attach listeners once.
   */
  function requestInitAttempt() {
    if (lifecycleHooksInstalled) {
      return;
    }

    const panel = document.getElementById('zen-unified-site-data-panel');
    if (panel) {
      if (panelRetryTimer !== null) {
        clearTimeout(panelRetryTimer);
        panelRetryTimer = null;
      }
      initRetryCount = 0;
      installLifecycleHooks(panel);
      debugLog('init OK, zen-unified-site-data-panel found');
      return;
    }

    if (panelRetryTimer !== null) {
      return;
    }

    if (initRetryCount < INIT_RETRY_MAX) {
      initRetryCount++;
      debugLog('panel not ready, retry', initRetryCount, '/', INIT_RETRY_MAX);
      panelRetryTimer = setTimeout(() => {
        panelRetryTimer = null;
        requestInitAttempt();
      }, INIT_RETRY_DELAY);
      return;
    }

    console.warn(
      'zen-auto-pip-setting: Panel not found after fast retries; retrying slowly every',
      INIT_SLOW_RETRY_MS / 1000,
      's (Zen may load UI late).'
    );
    debugLog('slow retry scheduled — panel still missing');
    initRetryCount = 0;
    panelRetryTimer = setTimeout(() => {
      panelRetryTimer = null;
      requestInitAttempt();
    }, INIT_SLOW_RETRY_MS);
  }

  function installLifecycleHooks(panel) {
    if (lifecycleHooksInstalled) {
      return;
    }
    lifecycleHooksInstalled = true;

    // Listen for when the panel is about to be shown
    // Use setTimeout to ensure it runs after the original panel preparation
    panel.addEventListener('popupshowing', () => {
      debugLog('popupshowing → addAutoPiPSetting');
      setTimeout(addAutoPiPSetting, 0);
    }, true);

    // Update the panel when tab changes (in case panel is open)
    window.addEventListener('TabSelect', () => {
      if (!panel.hasAttribute('hidden')) {
        debugLog('TabSelect while panel visible → schedule refresh');
        scheduleAddAutoPiPSetting(0);
      }
    });

    // Update the panel when media playback starts or stops (in case panel is open)
    // Debounce to avoid rapid recreate cycles that can race with click handling
    window.addEventListener('DOMAudioPlaybackStarted', () => {
      if (!panel.hasAttribute('hidden')) {
        debugLog('DOMAudioPlaybackStarted while panel visible → schedule refresh (150ms)');
        scheduleAddAutoPiPSetting(150);
      }
    });

    window.addEventListener('DOMAudioPlaybackStopped', () => {
      if (!panel.hasAttribute('hidden')) {
        debugLog('DOMAudioPlaybackStopped while panel visible → schedule refresh (150ms)');
        scheduleAddAutoPiPSetting(150);
      }
    });
  }

  function scheduleAddAutoPiPSetting(delay) {
    if (addAutoPiPSettingTimeout) {
      clearTimeout(addAutoPiPSettingTimeout);
    }
    debugLog('scheduleAddAutoPiPSetting delay=', delay);
    addAutoPiPSettingTimeout = setTimeout(() => {
      addAutoPiPSettingTimeout = null;
      addAutoPiPSetting();
    }, delay);
  }

  function hasMediaOnCurrentTab() {
    // Check if ZenMediaController is available
    if (!window.gZenMediaController) {
      debugLog('hasMediaOnCurrentTab: false (no gZenMediaController)');
      return false;
    }

    // Get the currently selected browser
    const selectedBrowser = window.gBrowser?.selectedBrowser;
    if (!selectedBrowser) {
      debugLog('hasMediaOnCurrentTab: false (no selectedBrowser)');
      return false;
    }

    const browserId = selectedBrowser.browserId;

    // Method 1: Check if the browser's browsing context has an active media controller
    // This is the most direct way to check for media on a specific browser
    try {
      const mediaController = selectedBrowser.browsingContext?.mediaController;
      if (mediaController?.isActive) {
        debugLog('hasMediaOnCurrentTab: true (browsingContext.mediaController)', { browserId });
        return true;
      }
    } catch (e) {
      debugLog('hasMediaOnCurrentTab: browsingContext check threw', e);
      // browsingContext might not be available (e.g., tab is loading)
    }

    // Method 2: Check if this browser is the one with active media in ZenMediaController
    if (
      window.gZenMediaController._currentBrowser?.browserId === selectedBrowser.browserId &&
      window.gZenMediaController._currentMediaController?.isActive
    ) {
      debugLog('hasMediaOnCurrentTab: true (gZenMediaController current)', { browserId });
      return true;
    }

    // Method 3: Check if there's a media controller in the map for this browser
    // This catches cases where media exists but isn't the "current" controller
    for (const entry of window.gZenMediaController.mediaControllersMap?.values() || []) {
      if (entry.browser?.browserId === selectedBrowser.browserId && entry.controller?.isActive) {
        debugLog('hasMediaOnCurrentTab: true (mediaControllersMap)', { browserId });
        return true;
      }
    }

    debugLog('hasMediaOnCurrentTab: false (no active controller for tab)', { browserId });
    return false;
  }

  function addAutoPiPSetting() {
    const list = document.getElementById('zen-site-data-settings-list');
    if (!list) {
      debugLog('addAutoPiPSetting: skip (no zen-site-data-settings-list)');
      return;
    }

    // Remove existing Auto PiP item if it exists
    const existing = list.querySelector('.permission-popup-permission-item-auto-pip');
    if (existing) {
      debugLog('addAutoPiPSetting: removing existing auto-pip row');
      existing.remove();
    }

    // Only show Auto PiP setting if media is detected on the current tab
    if (!hasMediaOnCurrentTab()) {
      debugLog('addAutoPiPSetting: hide row (no media on tab)');
      // Update section visibility in case we removed the item
      const section = list.closest('.zen-site-data-section');
      if (section) {
        section.hidden = list.childElementCount < 2;
      }
      return;
    }

    // Get current pref value (default to false if pref doesn't exist)
    let isEnabled = false;
    try {
      isEnabled = Services.prefs.getBoolPref(PREF_PIP_AUTO, false);
    } catch (e) {
      // Pref doesn't exist yet, default to false
    }

    // Create the setting item similar to other permissions
    const container = document.createXULElement('hbox');
    container.classList.add(
      'permission-popup-permission-item',
      'permission-popup-permission-item-auto-pip'
    );
    container.setAttribute('align', 'center');
    container.setAttribute('role', 'group');
    container.setAttribute('state', isEnabled ? 'allow' : 'block');

    const img = document.createXULElement('toolbarbutton');
    img.classList.add(
      'permission-popup-permission-icon',
      'zen-site-data-permission-icon'
    );
    img.setAttribute('closemenu', 'none');
    // Icon is list-style-image on the row (chrome.css), same as native permissions.

    // Create label container
    const labelContainer = document.createXULElement('vbox');
    labelContainer.setAttribute('flex', '1');
    labelContainer.setAttribute('align', 'start');
    labelContainer.classList.add('permission-popup-permission-label-container');

    // Create name label
    const nameLabel = document.createXULElement('label');
    nameLabel.setAttribute('flex', '1');
    nameLabel.setAttribute('class', 'permission-popup-permission-label');
    nameLabel.textContent = 'Picture-in-Picture';
    labelContainer.appendChild(nameLabel);

    // Create state label
    const stateLabel = document.createXULElement('label');
    stateLabel.setAttribute('class', 'zen-permission-popup-permission-state-label');
    stateLabel.textContent = isEnabled ? 'Automatic' : 'Off';
    labelContainer.appendChild(stateLabel);

    // Store the preference info on the label container for click handling
    labelContainer._isAutoPip = true;
    labelContainer._prefValue = isEnabled;

    // Attach click handler directly to container (like native permission items)
    // More reliable than document-level - avoids capture order / different-document issues
    container.addEventListener('click', handleAutoPiPClick, true);

    container.appendChild(img);
    container.appendChild(labelContainer);

    // Insert at the beginning of the list (before separator if it exists)
    const separator = list.querySelector('toolbarseparator');
    if (separator) {
      separator.before(container);
    } else {
      list.appendChild(container);
    }

    debugLog('addAutoPiPSetting: row added, pref enabled=', isEnabled);

    // Update section visibility
    const section = list.closest('.zen-site-data-section');
    if (section) {
      section.hidden = list.childElementCount < 2;
    }
  }

  function handleAutoPiPClick(event) {
    if (typeof Services === 'undefined') {
      debugLog('handleAutoPiPClick: no Services');
      return;
    }

    // Listener is on container, so currentTarget is our item
    const item = event.currentTarget;
    if (!item?.classList?.contains('permission-popup-permission-item-auto-pip')) {
      return;
    }

    const label = item.querySelector('.permission-popup-permission-label-container');
    if (!label || !label._isAutoPip) {
      return;
    }

    // Prevent default behavior and stop propagation (e.g. panel close, menu cycling)
    event.preventDefault();
    event.stopPropagation();

    // Always read from pref as source of truth - handles stale _prefValue when
    // addAutoPiPSetting recreates the element or when element was detached
    let currentValue;
    try {
      currentValue = Services.prefs.getBoolPref(PREF_PIP_AUTO, false);
      // Skip if pref is locked (e.g. enterprise policy) - prefIsLocked can throw for non-existent prefs
      if (Services.prefs.prefIsLocked(PREF_PIP_AUTO)) {
        debugLog('handleAutoPiPClick: skip, pref locked', PREF_PIP_AUTO);
        return;
      }
    } catch (e) {
      debugLog('handleAutoPiPClick: skip, could not read pref', e);
      return;
    }

    const newValue = !currentValue;
    debugLog('handleAutoPiPClick: toggle', { from: currentValue, to: newValue });

    // Update the preference
    try {
      Services.prefs.setBoolPref(PREF_PIP_AUTO, newValue);
    } catch (e) {
      console.error('zen-auto-pip-setting: Failed to set preference:', e);
      return;
    }

    // Update UI immediately (in case addAutoPiPSetting runs and recreates the element)
    item.setAttribute('state', newValue ? 'allow' : 'block');
    label._prefValue = newValue;

    const stateLabel = item.querySelector('.zen-permission-popup-permission-state-label');
    if (stateLabel) {
      stateLabel.textContent = newValue ? 'Automatic' : 'Off';
    }
  }
})();

