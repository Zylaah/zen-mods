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
  const HOVER_LAYER_ID = "zen-media-volume-slider-hover-layer";
  const SLIDER_ID = "zen-media-volume-slider";
  const HIDE_DELAY_MS = 320;
  const POPUP_GAP_PX = 2;
  const TOOLBAR_OPEN_ATTR = "zen-volume-slider-open";
  const PREF_LAST_VOLUME = "mod.media-volume-slider.last-volume";
  const INIT_RETRY_MS = 100;
  const INIT_RETRY_MAX = 60;

  let frameScriptUrl = null;
  let messageListenersReady = false;
  let initRetryCount = 0;
  let initRetryTimer = null;
  let hideTimer = null;
  let popupOpen = false;
  let dragging = false;
  let toolboxPopupMenuLocked = false;
  let toolbarWasMuted = false;
  let muteButton = null;
  let anchorEl = null;
  let popupEl = null;
  let hoverLayerEl = null;
  let sliderEl = null;
  let toolbarObserver = null;
  let layoutObserver = null;

  /** @type {WeakMap<object, number>} */
  const browserLastVolume = new WeakMap();
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
    return safe(() => {
      ensureVolumePrefDefault();
      return Math.max(0, Math.min(100, Services.prefs.getIntPref(PREF_LAST_VOLUME, 100)));
    }) ?? 100;
  }

  function saveStoredVolume(volume) {
    const value = Math.max(0, Math.min(100, Math.round(volume)));
    if (value <= 0) return;
    safe(() => {
      ensureVolumePrefDefault();
      Services.prefs.setIntPref(PREF_LAST_VOLUME, value);
    });
  }

  function rememberBrowserVolume(browser, volume) {
    const value = Math.max(0, Math.min(100, Math.round(volume)));
    if (value > 0) {
      browserLastVolume.set(browser, value);
      saveStoredVolume(value);
    }
  }

  function getRememberedVolume(browser) {
    return browserLastVolume.get(browser) ?? getStoredVolume();
  }

  const VOLUME_FRAME_SCRIPT = `
(function () {
  if (content.__zenMediaVolumeSlider) return;
  content.__zenMediaVolumeSlider = true;

  let lastUnmutedVolume = 100;

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
    if (!el) return lastUnmutedVolume;
    if (el.muted || el.volume === 0) return 0;
    lastUnmutedVolume = Math.round(el.volume * 100);
    return lastUnmutedVolume;
  }

  function writeVolume(percent, restoreFrom) {
    const el = pickMedia();
    if (!el) return readVolume();
    const v = Math.max(0, Math.min(100, percent)) / 100;
    if (v === 0) {
      if (el.volume > 0 && !el.muted) {
        lastUnmutedVolume = Math.round(el.volume * 100);
      } else if (restoreFrom > 0) {
        lastUnmutedVolume = restoreFrom;
      }
      el.muted = true;
      el.volume = 0;
      return 0;
    }
    el.muted = false;
    el.volume = v;
    lastUnmutedVolume = Math.round(el.volume * 100);
    return lastUnmutedVolume;
  }

  addMessageListener("ZenMediaVolumeSlider:Get", () => {
    sendAsyncMessage("ZenMediaVolumeSlider:State", { volume: readVolume() });
  });

  addMessageListener("ZenMediaVolumeSlider:Set", (msg) => {
    const restoreFrom = msg.data?.restoreFrom ?? 0;
    const volume = writeVolume(msg.data?.volume ?? 100, restoreFrom);
    sendAsyncMessage("ZenMediaVolumeSlider:State", { volume });
  });

  addMessageListener("ZenMediaVolumeSlider:Init", (msg) => {
    const target = Math.max(0, Math.min(100, msg.data?.volume ?? 100));
    if (target <= 0) return;
    lastUnmutedVolume = target;
    const el = pickMedia();
    if (!el) return;
    if (el.muted || el.volume === 0) {
      el.muted = false;
      el.volume = target / 100;
    }
    sendAsyncMessage("ZenMediaVolumeSlider:State", { volume: readVolume() });
  });

  addMessageListener("ZenMediaVolumeSlider:Unmute", (msg) => {
    const target = Math.max(1, Math.min(100, msg.data?.volume ?? lastUnmutedVolume));
    lastUnmutedVolume = target;
    const el = pickMedia();
    if (el) {
      el.muted = false;
      el.volume = target / 100;
    }
    sendAsyncMessage("ZenMediaVolumeSlider:State", { volume: target });
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

      let volume = Math.max(0, Math.min(100, message.data?.volume ?? 0));
      if (volume === 0 && !current.audioMuted) {
        const restored = getRememberedVolume(current);
        if (restored > 0) {
          applyVolume(restored, { skipRemember: true });
          return;
        }
      }

      if (volume > 0) rememberBrowserVolume(current, volume);
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

  function applyVolume(percent, options = {}) {
    const browser = getMediaBrowser();
    const tab = getMediaTab();
    if (!browser || !tab) return;

    const value = Math.max(0, Math.min(100, Math.round(percent)));
    ensureFrameScript(browser);

    if (!options.skipRemember && value > 0) {
      rememberBrowserVolume(browser, value);
    }

    if (value === 0) {
      const remembered =
        Number(sliderEl?.value) > 0
          ? Number(sliderEl.value)
          : getRememberedVolume(browser);
      if (remembered > 0) rememberBrowserVolume(browser, remembered);
      if (!browser.audioMuted) tab.toggleMuteAudio();
    } else if (browser.audioMuted) {
      tab.toggleMuteAudio();
    }

    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Set", {
      volume: value,
      restoreFrom: getRememberedVolume(browser),
    });
    safe(() => window.gZenMediaController?.updateMuteState());
  }

  function restoreVolumeAfterUnmute() {
    const browser = getMediaBrowser();
    if (!browser || browser.audioMuted) return;

    const volume = getRememberedVolume(browser);
    if (volume <= 0) return;

    ensureFrameScript(browser);
    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Unmute", {
      volume,
    });
    if (sliderEl && !dragging) sliderEl.value = String(volume);
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
      if (toolbox && !toolboxPopupMenuLocked) {
        toolbox.setAttribute("has-popup-menu", "true");
        toolboxPopupMenuLocked = true;
      }
    } else {
      toolbar?.removeAttribute(TOOLBAR_OPEN_ATTR);
      toolbox?.removeAttribute(TOOLBAR_OPEN_ATTR);
      if (toolbox && toolboxPopupMenuLocked) {
        toolbox.removeAttribute("has-popup-menu");
        toolboxPopupMenuLocked = false;
      }
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

  function syncHoverLayer() {
    if (!hoverLayerEl || !popupOpen || !muteButton || !popupEl) {
      hoverLayerEl?.setAttribute("hidden", "true");
      return;
    }

    syncPopupPosition();
    const muteRect = muteButton.getBoundingClientRect();
    const popupRect = popupEl.getBoundingClientRect();
    if (muteRect.width === 0 && popupRect.width === 0) return;

    const pad = 16;
    const top = Math.min(muteRect.top, popupRect.top) - pad;
    const left = Math.min(muteRect.left, popupRect.left) - pad;
    const right = Math.max(muteRect.right, popupRect.right) + pad;
    const bottom = Math.max(muteRect.bottom, popupRect.bottom) + pad;

    const layer = hoverLayerEl.style;
    layer.top = `${top}px`;
    layer.left = `${left}px`;
    layer.width = `${right - left}px`;
    layer.height = `${bottom - top}px`;
    hoverLayerEl.removeAttribute("hidden");
  }

  function closePopup() {
    clearHideTimer();
    popupOpen = false;
    dragging = false;
    popupEl?.removeAttribute("open");
    hoverLayerEl?.setAttribute("hidden", "true");
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
    popupOpen = true;
    popupEl?.setAttribute("open", "true");
    setToolbarExpanded(true);
    syncHoverLayer();

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
    if (!muteButton || !anchorEl || !popupEl || !sliderEl || !hoverLayerEl) return;

    anchorEl.addEventListener("mouseenter", () => {
      openPopup();
    });

    hoverLayerEl.addEventListener("mouseenter", () => {
      clearHideTimer();
      setToolbarExpanded(true);
    });

    hoverLayerEl.addEventListener("mouseleave", scheduleHide);

    sliderEl.addEventListener("pointerdown", () => {
      dragging = true;
      clearHideTimer();
      setToolbarExpanded(true);
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

    if (popupOpen) {
      requestContentVolume(browser);
    }
  }

  function onToolbarMuteChanged(toolbar) {
    const isMuted = toolbar.hasAttribute("muted");

    if (!toolbarWasMuted && isMuted) {
      const browser = getMediaBrowser();
      if (browser && Number(sliderEl?.value) > 0) {
        rememberBrowserVolume(browser, Number(sliderEl.value));
      } else if (browser) {
        requestContentVolume(browser);
      }
    }

    if (toolbarWasMuted && !isMuted) {
      restoreVolumeAfterUnmute();
    }

    toolbarWasMuted = isMuted;
    syncSliderFromToolbarMute();
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

    hoverLayerEl = document.createElement("div");
    hoverLayerEl.id = HOVER_LAYER_ID;
    hoverLayerEl.setAttribute("hidden", "true");

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
    document.documentElement.appendChild(hoverLayerEl);
    document.documentElement.appendChild(popupEl);

    bindPopupEvents();

    const toolbar = getMediaToolbar();
    if (toolbar) {
      toolbarWasMuted = toolbar.hasAttribute("muted");

      muteButton.addEventListener("pointerdown", () => {
        const browser = getMediaBrowser();
        if (!browser || browser.audioMuted) return;
        if (Number(sliderEl?.value) > 0) {
          rememberBrowserVolume(browser, Number(sliderEl.value));
          return;
        }
        requestContentVolume(browser);
      });

      if (!toolbarObserver) {
        toolbarObserver = new MutationObserver(() => {
          if (toolbar.hasAttribute("hidden") || toolbar.hasAttribute("media-sharing")) {
            closePopup();
            return;
          }

          const browser = getMediaBrowser();
          if (browser) bootstrapContentVolume(browser);

          onToolbarMuteChanged(toolbar);
        });
        toolbarObserver.observe(toolbar, {
          attributes: true,
          attributeFilter: ["hidden", "media-sharing", "muted"],
        });
      }

      if (!toolbar.hasAttribute("hidden")) {
        const browser = getMediaBrowser();
        if (browser) bootstrapContentVolume(browser);
      }
    }

    const bumpLayout = () => {
      if (popupOpen) syncHoverLayer();
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
