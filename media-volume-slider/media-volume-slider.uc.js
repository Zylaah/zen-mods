// ==UserScript==
// @name           Better Media Toolbar
// @description    Volume slider on mute hover and media artwork background on toolbar hover
// @author         Zylaah
// @version        1.1.0
// @namespace      https://github.com/Zylaah/zen-mods
// ==/UserScript==

/* eslint-env es6, browser */
/* global Services, gBrowser, Ci */

(function () {
  "use strict";

  if (window.__zenMediaVolumeSliderLoaded) return;
  window.__zenMediaVolumeSliderLoaded = true;

  const LOG_PREFIX = "[BetterMediaToolbar]";
  const POPUP_ID = "zen-media-volume-slider-popup";
  const SLIDER_ID = "zen-media-volume-slider";
  const ARTWORK_VAR = "--zen-media-artwork-bg";
  const ARTWORK_CLASS = "has-artwork";
  const HIDE_DELAY_MS = 280;
  const POPUP_GAP_PX = 6;
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
  let toolbarWasMuted = false;

  /** @type {WeakSet<object>} */
  const bootstrappedBrowsers = new WeakSet();

  /** @type {WeakMap<object, number>} */
  const browserPreMuteVolume = new WeakMap();

  const log = (...args) => console.log(LOG_PREFIX, ...args);

  function findBestArtwork(artwork = []) {
    if (!Array.isArray(artwork) || artwork.length === 0) return null;
    artwork.sort((a, b) => {
      const sizeA = parseInt(a.sizes?.split("x")[0] || "0", 10);
      const sizeB = parseInt(b.sizes?.split("x")[0] || "0", 10);
      return sizeB - sizeA;
    });
    return artwork[0]?.src || null;
  }

  function applyArtwork(toolbar) {
    const toolbarItem = toolbar.querySelector(":scope > toolbaritem");
    if (!toolbarItem) return;

    try {
      let artworkUrl = null;
      if (window.gZenMediaController?._currentMediaController) {
        const metadata =
          window.gZenMediaController._currentMediaController.getMetadata();
        artworkUrl = findBestArtwork(metadata?.artwork);
      }

      if (artworkUrl) {
        toolbarItem.style.setProperty(ARTWORK_VAR, `url("${artworkUrl}")`);
        toolbarItem.classList.add(ARTWORK_CLASS);
      } else {
        toolbarItem.style.removeProperty(ARTWORK_VAR);
        toolbarItem.classList.remove(ARTWORK_CLASS);
      }
    } catch (e) {
      console.error(LOG_PREFIX, "artwork apply failed", e);
      toolbarItem.style.removeProperty(ARTWORK_VAR);
      toolbarItem.classList.remove(ARTWORK_CLASS);
    }
  }

  function removeArtwork(toolbar) {
    const toolbarItem = toolbar.querySelector(":scope > toolbaritem");
    if (!toolbarItem) return;
    toolbarItem.style.removeProperty(ARTWORK_VAR);
    toolbarItem.classList.remove(ARTWORK_CLASS);
  }

  function addArtworkHoverListeners(toolbar) {
    if (toolbar.dataset.artworkListenersAdded === "true") return;

    toolbar.addEventListener("mouseenter", () => applyArtwork(toolbar));
    toolbar.addEventListener("mouseleave", () => removeArtwork(toolbar));
    toolbar.dataset.artworkListenersAdded = "true";
  }

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

  function rememberPreMuteVolume(browser, volume) {
    const value = Math.max(1, Math.min(100, Math.round(volume)));
    browserPreMuteVolume.set(browser, value);
    saveStoredVolume(value);
  }

  function getPreMuteVolume(browser) {
    return browserPreMuteVolume.get(browser) ?? getStoredVolume();
  }

  function capturePreMuteVolume(browser) {
    if (!browser || browser.audioMuted) return;
    const fromSlider = Number(sliderEl?.value);
    rememberPreMuteVolume(
      browser,
      fromSlider > 0 ? fromSlider : getStoredVolume()
    );
  }

  const VOLUME_FRAME_SCRIPT = `
(function () {
  const FRAME_SCRIPT_VERSION = 2;
  if (content.__zenMediaVolumeSlider === FRAME_SCRIPT_VERSION) return;
  content.__zenMediaVolumeSlider = FRAME_SCRIPT_VERSION;

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

  function writeVolume(percent) {
    const el = pickMedia();
    if (!el) return readVolume();
    const v = Math.max(0, Math.min(100, percent)) / 100;
    if (v === 0) {
      if (el.volume > 0 && !el.muted) {
        lastUnmutedVolume = Math.round(el.volume * 100);
      }
      el.muted = true;
      el.volume = 0;
    } else {
      el.muted = false;
      el.volume = v;
      lastUnmutedVolume = Math.round(el.volume * 100);
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
    lastUnmutedVolume = target;
    const el = pickMedia();
    if (!el) return;
    el.muted = false;
    el.volume = target / 100;
    sendAsyncMessage("ZenMediaVolumeSlider:State", {
      volume: Math.round(el.volume * 100),
    });
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
      const volume = Math.max(0, Math.min(100, message.data?.volume ?? 0));
      if (volume === 0 && !current.audioMuted) {
        restoreVolumeAfterUnmute();
        return;
      }
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
      const current =
        Number(sliderEl?.value) > 0 ? Number(sliderEl.value) : getPreMuteVolume(browser);
      rememberPreMuteVolume(browser, current);
      if (!browser.audioMuted) tab.toggleMuteAudio();
    } else if (browser.audioMuted) {
      tab.toggleMuteAudio();
    }

    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Set", {
      volume: value,
    });
    safe(() => window.gZenMediaController?.updateMuteState());
  }

  function restoreVolumeAfterUnmute() {
    const browser = getMediaBrowser();
    if (!browser || browser.audioMuted) return;

    const volume = getPreMuteVolume(browser);
    ensureFrameScript(browser);
    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Unmute", {
      volume,
    });
    if (sliderEl && !dragging) sliderEl.value = String(volume);
  }

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
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
  }

  function openPopup() {
    const toolbar = document.getElementById("zen-media-controls-toolbar");
    log("openPopup() called", {
      toolbarFound: !!toolbar,
      hidden: toolbar?.hasAttribute("hidden"),
      mediaSharing: toolbar?.hasAttribute("media-sharing"),
      popupElFound: !!popupEl,
      sliderElFound: !!sliderEl,
    });
    if (
      !toolbar ||
      toolbar.hasAttribute("hidden") ||
      toolbar.hasAttribute("media-sharing")
    ) {
      log("openPopup() aborted: toolbar missing/hidden/sharing");
      return;
    }

    clearHideTimer();
    syncPopupPosition();
    popupOpen = true;
    popupEl?.setAttribute("open", "true");
    log("openPopup() set [open] attribute", {
      rect: muteButton?.getBoundingClientRect(),
      popupStyleLeft: popupEl?.style.left,
      popupStyleTop: popupEl?.style.top,
    });
    safe(() => {
      const cs = window.getComputedStyle(popupEl);
      log("openPopup() computed style", {
        opacity: cs.opacity,
        visibility: cs.visibility,
        display: cs.display,
        zIndex: cs.zIndex,
        position: cs.position,
        transform: cs.transform,
        width: cs.width,
        height: cs.height,
        popupRect: popupEl.getBoundingClientRect(),
        hasOpenAttr: popupEl.hasAttribute("open"),
        parentNode: popupEl.parentNode?.nodeName,
        connected: popupEl.isConnected,
      });
    });

    const browser = getMediaBrowser();
    if (!browser) {
      log("openPopup(): no media browser found");
      return;
    }

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
    if (!muteButton || !anchorEl || !popupEl || !sliderEl) {
      log("bindPopupEvents() aborted, missing refs", {
        muteButton: !!muteButton,
        anchorEl: !!anchorEl,
        popupEl: !!popupEl,
        sliderEl: !!sliderEl,
      });
      return;
    }

    const hoverZone = anchorEl;

    hoverZone.addEventListener("mouseenter", () => {
      log("anchorEl mouseenter fired");
      openPopup();
    });

    hoverZone.addEventListener("mouseleave", scheduleHide);

    popupEl.addEventListener("mouseenter", () => {
      clearHideTimer();
      syncPopupPosition();
      popupOpen = true;
      popupEl.setAttribute("open", "true");
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
    restoreVolumeAfterUnmute();
  }

  function onToolbarMuteChanged(toolbar) {
    const isMuted = toolbar.hasAttribute("muted");

    if (!toolbarWasMuted && isMuted) {
      sliderEl.value = "0";
    } else if (toolbarWasMuted && !isMuted) {
      restoreVolumeAfterUnmute();
    }

    toolbarWasMuted = isMuted;
  }

  function initArtworkBackground() {
    const toolbar = document.getElementById("zen-media-controls-toolbar");
    if (!toolbar || typeof window.gZenMediaController === "undefined") {
      return false;
    }
    addArtworkHoverListeners(toolbar);
    return true;
  }

  function buildUi() {
    muteButton = document.getElementById("zen-media-mute-button");
    if (!muteButton || document.getElementById(POPUP_ID)) {
      log("buildUi() early return", {
        muteButtonFound: !!muteButton,
        popupAlreadyExists: !!document.getElementById(POPUP_ID),
      });
      return !!muteButton;
    }
    log("buildUi() building fresh popup UI");

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

    muteButton.addEventListener(
      "pointerdown",
      () => {
        capturePreMuteVolume(getMediaBrowser());
      },
      true
    );

    const toolbar = document.getElementById("zen-media-controls-toolbar");
    if (toolbar && !toolbarObserver) {
      toolbarWasMuted = toolbar.hasAttribute("muted");

      toolbarObserver = new MutationObserver(() => {
        if (toolbar.hasAttribute("hidden") || toolbar.hasAttribute("media-sharing")) {
          closePopup();
        } else {
          const browser = getMediaBrowser();
          if (browser) bootstrapContentVolume(browser);
        }
        onToolbarMuteChanged(toolbar);
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
    initArtworkBackground();
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
