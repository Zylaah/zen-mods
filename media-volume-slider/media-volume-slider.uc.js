// ==UserScript==
// @name           Media Volume Slider
// @description    Hover volume slider on the sidebar media mute button
// @author         Zylaah
// @version        1.0.3
// @namespace      https://github.com/Zylaah/zen-mods
// ==/UserScript==

/* eslint-env es6, browser */
/* global Services, gBrowser, Ci */

(function () {
  "use strict";

  if (window.__zenMediaVolumeSliderLoaded) return;
  window.__zenMediaVolumeSliderLoaded = true;

  const LOG_PREFIX = "[MediaVolumeSlider]";
  const POPUP_ID = "zen-media-volume-slider-popup";
  const SLIDER_ID = "zen-media-volume-slider";
  const HIDE_DELAY_MS = 280;
  const POPUP_GAP_PX = 6;
  const TOOLBAR_OPEN_ATTR = "zen-volume-slider-open";
  const INIT_RETRY_MS = 100;
  const INIT_RETRY_MAX = 60;
  const PREF_LAST_VOLUME = "mod.media-volume-slider.last-volume";

  let frameScriptUrl = null;
  let messageListenersReady = false;
  let initRetryCount = 0;
  let initRetryTimer = null;
  let hideTimer = null;
  let popupOpen = false;
  let dragging = false;
  let muteButton = null;
  let anchorEl = null;
  let popupEl = null;
  let sliderEl = null;
  let toolbarObserver = null;
  let layoutObserver = null;

  /** @type {WeakSet<object>} */
  const bootstrappedBrowsers = new WeakSet();

  const log = (...args) => console.log(LOG_PREFIX, ...args);

  function safe(fn) {
    try {
      return fn();
    } catch (_) {
      return undefined;
    }
  }

  function ensureVolumePrefDefault() {
    safe(() => {
      if (Services.prefs.getPrefType(PREF_LAST_VOLUME) === Ci.nsIPrefBranch.PREF_INVALID) {
        Services.prefs.getDefaultBranch("").setIntPref(PREF_LAST_VOLUME, 100);
      }
    });
  }

  function getStoredVolume() {
    return (
      safe(() => {
        ensureVolumePrefDefault();
        return Math.max(0, Math.min(100, Services.prefs.getIntPref(PREF_LAST_VOLUME, 100)));
      }) ?? 100
    );
  }

  function saveStoredVolume(volume) {
    const value = Math.max(0, Math.min(100, Math.round(volume)));
    if (value <= 0) return;
    safe(() => {
      ensureVolumePrefDefault();
      Services.prefs.setIntPref(PREF_LAST_VOLUME, value);
    });
  }

  const VOLUME_FRAME_SCRIPT = `
(function () {
  if (content.__zenMediaVolumeSlider) return;
  content.__zenMediaVolumeSlider = true;

  function pickMedia() {
    const nodes = content.document.querySelectorAll("video, audio");
    let best = null;
    let bestScore = -1;
    for (const el of nodes) {
      if (el.readyState < 2) continue;
      const audible = !el.paused && !el.ended && !el.muted && el.volume > 0;
      const score = (audible ? 1000 : 0) + el.volume;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function readVolume() {
    const el = pickMedia();
    if (!el) return 100;
    if (el.muted || el.volume === 0) return 0;
    return Math.round(el.volume * 100);
  }

  function writeVolume(percent) {
    const el = pickMedia();
    if (!el) return readVolume();
    const v = Math.max(0, Math.min(100, percent)) / 100;
    if (v === 0) {
      el.muted = true;
      el.volume = 0;
    } else {
      el.muted = false;
      el.volume = v;
    }
    return Math.round(el.volume * 100);
  }

  addMessageListener("ZenMediaVolumeSlider:Get", () => {
    sendAsyncMessage("ZenMediaVolumeSlider:State", { volume: readVolume() });
  });

  addMessageListener("ZenMediaVolumeSlider:Set", (msg) => {
    const volume = writeVolume(msg.data?.volume ?? 100);
    sendAsyncMessage("ZenMediaVolumeSlider:State", { volume });
  });

  addMessageListener("ZenMediaVolumeSlider:Init", (msg) => {
    const target = Math.max(0, Math.min(100, msg.data?.volume ?? 100));
    if (target <= 0) return;
    const el = pickMedia();
    if (!el) return;
    el.muted = false;
    el.volume = target / 100;
    sendAsyncMessage("ZenMediaVolumeSlider:State", {
      volume: Math.round(el.volume * 100),
    });
  });
})();
`;

  function getTabForMessageManager(mm) {
    if (!window.gBrowser?.tabContainer?.allTabs) return null;
    for (const tab of gBrowser.tabContainer.allTabs) {
      if (tab.linkedBrowser?.messageManager === mm) return tab;
    }
    return null;
  }

  function getMediaBrowser() {
    const mc = window.gZenMediaController;
    if (mc?._currentBrowser) return mc._currentBrowser;
    return gBrowser?.selectedBrowser || null;
  }

  function getMediaTab() {
    const browser = getMediaBrowser();
    if (!browser || !gBrowser) return null;
    return gBrowser.getTabForBrowser(browser);
  }

  function ensureFrameScript(browser) {
    if (!browser?.messageManager) return false;
    try {
      if (!frameScriptUrl) {
        frameScriptUrl =
          "data:application/javascript;charset=utf-8," +
          encodeURIComponent(VOLUME_FRAME_SCRIPT);
      }
      browser.messageManager.loadFrameScript(frameScriptUrl, true);
      return true;
    } catch (e) {
      console.warn(LOG_PREFIX, "frame script load failed", e);
      return false;
    }
  }

  function setupMessageListeners() {
    if (messageListenersReady || !Services.mm) return;
    Services.mm.addMessageListener("ZenMediaVolumeSlider:State", (message) => {
      const tab = getTabForMessageManager(message.target);
      const current = getMediaBrowser();
      if (!tab || !current || tab.linkedBrowser !== current) return;
      if (!sliderEl) return;
      const volume = Math.max(0, Math.min(100, message.data?.volume ?? 0));
      if (volume > 0) saveStoredVolume(volume);
      sliderEl.value = String(volume);
    });
    messageListenersReady = true;
  }

  function requestContentVolume(browser) {
    if (!browser?.messageManager) return;
    ensureFrameScript(browser);
    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Get", {});
  }

  function bootstrapContentVolume(browser) {
    if (!browser?.messageManager || browser.audioMuted) return;
    if (bootstrappedBrowsers.has(browser)) return;
    bootstrappedBrowsers.add(browser);
    ensureFrameScript(browser);
    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Init", {
      volume: getStoredVolume(),
    });
  }

  function applyVolume(percent) {
    const browser = getMediaBrowser();
    const tab = getMediaTab();
    if (!browser || !tab) return;

    const value = Math.max(0, Math.min(100, Math.round(percent)));
    ensureFrameScript(browser);

    if (value > 0) saveStoredVolume(value);

    if (value === 0) {
      if (!browser.audioMuted) tab.toggleMuteAudio();
    } else if (browser.audioMuted) {
      tab.toggleMuteAudio();
    }

    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Set", {
      volume: value,
    });
    safe(() => window.gZenMediaController?.updateMuteState());
  }

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function getMediaToolbar() {
    return document.getElementById("zen-media-controls-toolbar");
  }

  function setToolbarExpanded(expanded) {
    const toolbar = getMediaToolbar();
    const toolbox = document.getElementById("navigator-toolbox");
    if (expanded) {
      toolbar?.setAttribute(TOOLBAR_OPEN_ATTR, "true");
      toolbox?.setAttribute(TOOLBAR_OPEN_ATTR, "true");
    } else {
      toolbar?.removeAttribute(TOOLBAR_OPEN_ATTR);
      toolbox?.removeAttribute(TOOLBAR_OPEN_ATTR);
    }
  }

  function syncPopupPosition() {
    if (!popupEl || !muteButton) return;
    const rect = muteButton.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const s = popupEl.style;
    s.left = `${rect.left + rect.width / 2}px`;
    s.top = `${rect.top - POPUP_GAP_PX}px`;
  }

  function closePopup() {
    clearHideTimer();
    popupOpen = false;
    dragging = false;
    popupEl?.removeAttribute("open");
    setToolbarExpanded(false);
  }

  function openPopup() {
    const toolbar = getMediaToolbar();
    if (
      !toolbar ||
      toolbar.hasAttribute("hidden") ||
      toolbar.hasAttribute("media-sharing")
    ) {
      return;
    }

    clearHideTimer();
    syncPopupPosition();
    popupOpen = true;
    popupEl?.setAttribute("open", "true");
    setToolbarExpanded(true);

    const browser = getMediaBrowser();
    if (!browser) return;

    if (browser.audioMuted) {
      sliderEl.value = "0";
      return;
    }

    requestContentVolume(browser);
  }

  function scheduleHide() {
    if (dragging) return;
    clearHideTimer();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!dragging) closePopup();
    }, HIDE_DELAY_MS);
  }

  function bindPopupEvents() {
    if (!muteButton || !anchorEl || !popupEl || !sliderEl) return;

    const hoverZone = anchorEl;

    hoverZone.addEventListener("mouseenter", () => {
      openPopup();
    });

    hoverZone.addEventListener("mouseleave", scheduleHide);

    popupEl.addEventListener("mouseenter", () => {
      clearHideTimer();
      syncPopupPosition();
      popupOpen = true;
      popupEl.setAttribute("open", "true");
      setToolbarExpanded(true);
    });

    popupEl.addEventListener("mouseleave", scheduleHide);

    sliderEl.addEventListener("pointerdown", () => {
      dragging = true;
      clearHideTimer();
    });

    sliderEl.addEventListener("pointerup", () => {
      dragging = false;
      scheduleHide();
    });

    sliderEl.addEventListener("input", () => {
      applyVolume(Number(sliderEl.value));
    });

    sliderEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closePopup();
        muteButton.focus();
      }
    });
  }

  function syncSliderFromToolbarMute() {
    if (!sliderEl || dragging) return;
    const browser = getMediaBrowser();
    if (!browser) return;
    if (browser.audioMuted) {
      sliderEl.value = "0";
      return;
    }
    if (popupOpen) requestContentVolume(browser);
  }

  function buildUi() {
    muteButton = document.getElementById("zen-media-mute-button");
    if (!muteButton || document.getElementById(POPUP_ID)) {
      return !!muteButton;
    }

    ensureVolumePrefDefault();

    anchorEl = document.createElement("div");
    anchorEl.setAttribute("zen-volume-anchor", "true");

    const parent = muteButton.parentNode;
    if (!parent) return false;
    parent.insertBefore(anchorEl, muteButton);
    anchorEl.appendChild(muteButton);

    popupEl = document.createElement("div");
    popupEl.id = POPUP_ID;
    popupEl.setAttribute("role", "group");
    popupEl.setAttribute("aria-label", "Volume");

    sliderEl = document.createElement("input");
    sliderEl.type = "range";
    sliderEl.id = SLIDER_ID;
    sliderEl.min = "0";
    sliderEl.max = "100";
    sliderEl.step = "1";
    sliderEl.value = String(getStoredVolume());
    sliderEl.setAttribute("aria-label", "Volume");

    popupEl.appendChild(sliderEl);
    document.documentElement.appendChild(popupEl);

    bindPopupEvents();

    const toolbar = getMediaToolbar();
    if (toolbar && !toolbarObserver) {
      toolbarObserver = new MutationObserver(() => {
        if (toolbar.hasAttribute("hidden") || toolbar.hasAttribute("media-sharing")) {
          closePopup();
        } else {
          const browser = getMediaBrowser();
          if (browser) bootstrapContentVolume(browser);
        }
        syncSliderFromToolbarMute();
      });
      toolbarObserver.observe(toolbar, {
        attributes: true,
        attributeFilter: ["hidden", "media-sharing", "muted"],
      });
    }

    const browser = getMediaBrowser();
    if (browser && toolbar && !toolbar.hasAttribute("hidden")) {
      bootstrapContentVolume(browser);
    }

    const bumpLayout = () => {
      if (popupOpen) syncPopupPosition();
    };
    window.addEventListener("resize", bumpLayout);
    if (toolbar) {
      safe(() => {
        layoutObserver = new ResizeObserver(bumpLayout);
        layoutObserver.observe(toolbar);
        layoutObserver.observe(muteButton);
      });
    }

    log("UI attached to #zen-media-mute-button");
    return true;
  }

  function requestInit() {
    setupMessageListeners();
    if (buildUi()) {
      if (initRetryTimer) {
        clearTimeout(initRetryTimer);
        initRetryTimer = null;
      }
      initRetryCount = 0;
      return;
    }
    if (initRetryCount >= INIT_RETRY_MAX) return;
    initRetryCount++;
    initRetryTimer = setTimeout(requestInit, INIT_RETRY_MS);
  }

  function bootstrap() {
    requestInit();
  }

  bootstrap();
  if (document.readyState !== "complete") {
    window.addEventListener("load", bootstrap, { once: true });
  }
})();
