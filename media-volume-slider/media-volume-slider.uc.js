// ==UserScript==
// @name           Better Media Toolbar
// @description    Volume slider on mute hover and media artwork background on toolbar hover
// @author         Zylaah
// @version        1.4.1
// @namespace      https://github.com/Zylaah/zen-mods
// ==/UserScript==

/* eslint-env es6, browser */
/* global Services, gBrowser */

(function () {
  "use strict";

  if (window.__zenMediaVolumeSliderLoaded) return;
  window.__zenMediaVolumeSliderLoaded = true;

  const LOG_PREFIX = "[BetterMediaToolbar]";
  const POPUP_ID = "zen-media-volume-slider-popup";
  const SLIDER_ID = "zen-media-volume-slider";
  const BRIDGE_ID = "zen-media-volume-hover-bridge";
  const ARTWORK_VAR = "--zen-media-artwork-bg";
  const ARTWORK_CLASS = "has-artwork";
  const CARD_SELECTOR = ".zen-media-card";
  const MUTE_SELECTOR = ".zen-media-mute-button";
  const TOOLBAR_VOLUME_ATTR = "zen-volume-open";
  const PREF_VOLUMES_BY_ORIGIN = "mod.media-volume-slider.volumes-by-origin";
  const MAX_STORED_ORIGINS = 100;
  const HIDE_DELAY_MS = 320;
  const POPUP_GAP_PX = 4;
  const INIT_RETRY_MS = 100;
  const INIT_RETRY_MAX = 80;

  let frameScriptUrl = null;
  let messageListenersReady = false;
  let hooksInstalled = false;
  let initRetryCount = 0;
  let initRetryTimer = null;
  let hideTimer = null;
  let popupOpen = false;
  let dragging = false;
  /** @type {Element | null} Active mute button the popup is anchored to */
  let muteButton = null;
  /** @type {HTMLElement | null} Card that owns the active mute button */
  let activeCardEl = null;
  let popupEl = null;
  let sliderEl = null;
  let bridgeEl = null;
  let toolbarObserver = null;
  let cardsObserver = null;
  let layoutObserver = null;

  /** Per-browser last unmuted volume for this session. */
  /** @type {WeakMap<object, number>} */
  const browserVolumes = new WeakMap();

  /** Browsers that already had persisted volume applied to content this session. */
  /** @type {WeakSet<object>} */
  const restoredBrowsers = new WeakSet();

  /** @type {WeakMap<Element, { browser: object, controller: object | null }>} */
  const cardBindings = new WeakMap();

  /** @type {WeakSet<Element>} */
  const wiredCards = new WeakSet();

  /** @type {WeakMap<Element, boolean>} */
  const cardWasMuted = new WeakMap();

  const log = (...args) => console.log(LOG_PREFIX, ...args);

  function safe(fn) {
    try {
      return fn();
    } catch (_) {
      return undefined;
    }
  }

  function getToolbar() {
    return document.getElementById("zen-media-controls-toolbar");
  }

  /**
   * Resolve browser/controller for a card element.
   * Uses bindings from activate* hooks, frontCard, or metadata matching.
   */
  function resolveCardBinding(cardEl) {
    if (!cardEl) return null;

    const cached = cardBindings.get(cardEl);
    if (cached?.browser) return cached;

    const front = window.gZenMediaController?.frontCard;
    if (front?.element === cardEl && front.browser) {
      const binding = { browser: front.browser, controller: front.controller ?? null };
      cardBindings.set(cardEl, binding);
      return binding;
    }

    const title = cardEl.querySelector(".zen-media-title")?.textContent ?? "";
    const artist = cardEl.querySelector(".zen-media-artist")?.textContent ?? "";
    const isSharing = cardEl.hasAttribute("media-sharing");

    if (!window.gBrowser?.tabContainer?.allTabs) return null;

    for (const tab of gBrowser.tabContainer.allTabs) {
      const browser = tab.linkedBrowser;
      if (!browser) continue;

      if (isSharing) {
        if (tab.label === title) {
          const binding = { browser, controller: null };
          cardBindings.set(cardEl, binding);
          return binding;
        }
        continue;
      }

      const controller = browser.browsingContext?.mediaController;
      if (!controller?.isActive) continue;
      const metadata = safe(() => controller.getMetadata()) ?? {};
      if ((metadata.title || "") === title && (metadata.artist || "") === artist) {
        const binding = { browser, controller };
        cardBindings.set(cardEl, binding);
        return binding;
      }
    }

    return null;
  }

  function bindCard(cardEl, browser, controller = null) {
    if (!cardEl || !browser) return;
    cardBindings.set(cardEl, { browser, controller });
  }

  function getActiveBrowser() {
    return resolveCardBinding(activeCardEl)?.browser ?? null;
  }

  function getActiveTab() {
    const browser = getActiveBrowser();
    if (!browser || !gBrowser) return null;
    return gBrowser.getTabForBrowser(browser);
  }

  function syncCardMuteAttribute(cardEl, browser) {
    if (!cardEl || !browser) return;
    cardEl.toggleAttribute("muted", !!browser.audioMuted);
    const zenCard = window.gZenMediaController?.frontCard;
    if (zenCard?.element === cardEl) {
      safe(() => zenCard.updateMuteState());
    }
  }

  function findBestArtwork(artwork = []) {
    if (!Array.isArray(artwork) || artwork.length === 0) return null;
    const sorted = [...artwork].sort((a, b) => {
      const sizeA = parseInt(a.sizes?.split("x")[0] || "0", 10);
      const sizeB = parseInt(b.sizes?.split("x")[0] || "0", 10);
      return sizeB - sizeA;
    });
    return sorted[0]?.src || null;
  }

  function applyArtworkToCard(cardEl) {
    if (!cardEl || cardEl.hasAttribute("media-sharing")) return;

    try {
      const binding = resolveCardBinding(cardEl);
      const artworkUrl = findBestArtwork(
        safe(() => binding?.controller?.getMetadata()?.artwork) ?? []
      );

      if (artworkUrl) {
        cardEl.style.setProperty(ARTWORK_VAR, `url("${artworkUrl}")`);
        cardEl.classList.add(ARTWORK_CLASS);
      } else {
        cardEl.style.removeProperty(ARTWORK_VAR);
        cardEl.classList.remove(ARTWORK_CLASS);
      }
    } catch (e) {
      console.error(LOG_PREFIX, "artwork apply failed", e);
      cardEl.style.removeProperty(ARTWORK_VAR);
      cardEl.classList.remove(ARTWORK_CLASS);
    }
  }

  function removeArtworkFromCard(cardEl) {
    if (!cardEl) return;
    cardEl.style.removeProperty(ARTWORK_VAR);
    cardEl.classList.remove(ARTWORK_CLASS);
  }

  function applyArtworkToVisibleCards(toolbar) {
    for (const cardEl of toolbar.querySelectorAll(CARD_SELECTOR)) {
      if (cardEl.hidden) continue;
      applyArtworkToCard(cardEl);
    }
  }

  function clearArtworkOnToolbar(toolbar) {
    for (const cardEl of toolbar.querySelectorAll(CARD_SELECTOR)) {
      removeArtworkFromCard(cardEl);
    }
  }

  function addArtworkHoverListeners(toolbar) {
    if (toolbar.dataset.artworkListenersAdded === "true") return;

    toolbar.addEventListener("mouseenter", () => applyArtworkToVisibleCards(toolbar));
    toolbar.addEventListener("mouseleave", () => {
      // Keep artwork while moving onto the volume slider / bridge.
      if (popupOpen || toolbar.hasAttribute(TOOLBAR_VOLUME_ATTR)) return;
      clearArtworkOnToolbar(toolbar);
    });
    toolbar.dataset.artworkListenersAdded = "true";
  }

  /**
   * Stable key for persistence: site origin (e.g. https://www.youtube.com).
   * Each origin keeps its own volume across sessions without sharing across cards.
   */
  function getVolumeKey(browser) {
    return (
      safe(() => {
        const uri = browser?.currentURI;
        if (!uri) return null;
        if (uri.schemeIs("about") || uri.schemeIs("chrome") || uri.schemeIs("resource")) {
          return null;
        }
        return uri.prePath || null;
      }) ?? null
    );
  }

  function readVolumeMap() {
    const raw =
      safe(() => Services.prefs.getStringPref(PREF_VOLUMES_BY_ORIGIN, "")) || "";
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeVolumeMap(map) {
    const keys = Object.keys(map);
    if (keys.length > MAX_STORED_ORIGINS) {
      for (const key of keys.slice(0, keys.length - MAX_STORED_ORIGINS)) {
        delete map[key];
      }
    }
    safe(() => Services.prefs.setStringPref(PREF_VOLUMES_BY_ORIGIN, JSON.stringify(map)));
  }

  function getPersistedVolumeForBrowser(browser) {
    const key = getVolumeKey(browser);
    if (!key) return null;
    const value = readVolumeMap()[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.max(1, Math.min(100, Math.round(value)));
  }

  /**
   * Remember volume for this browser; optionally persist by origin for next sessions.
   */
  function rememberBrowserVolume(browser, volume, { persist = true } = {}) {
    if (!browser) return;
    const value = Math.max(1, Math.min(100, Math.round(volume)));
    browserVolumes.set(browser, value);
    if (!persist) return;

    const key = getVolumeKey(browser);
    if (!key) return;
    const map = readVolumeMap();
    map[key] = value;
    writeVolumeMap(map);
  }

  function getBrowserVolume(browser) {
    if (!browser) return 100;
    if (browserVolumes.has(browser)) return browserVolumes.get(browser);
    const persisted = getPersistedVolumeForBrowser(browser);
    if (persisted != null) {
      browserVolumes.set(browser, persisted);
      return persisted;
    }
    return 100;
  }

  function capturePreMuteVolume(browser) {
    if (!browser || browser.audioMuted) return;
    const fromSlider = Number(sliderEl?.value);
    rememberBrowserVolume(
      browser,
      fromSlider > 0 ? fromSlider : getBrowserVolume(browser)
    );
  }

  /**
   * Apply this origin's saved volume to the tab's media once per browser/session.
   */
  function restorePersistedVolumeToContent(browser) {
    if (!browser?.messageManager || browser.audioMuted) return;
    if (restoredBrowsers.has(browser)) return;

    const persisted = getPersistedVolumeForBrowser(browser);
    if (persisted == null) return;

    restoredBrowsers.add(browser);
    browserVolumes.set(browser, persisted);
    ensureFrameScript(browser);
    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Init", {
      volume: persisted,
    });
  }

  function setToolbarVolumeOpen(open) {
    const toolbar = getToolbar();
    if (!toolbar) return;
    if (open) toolbar.setAttribute(TOOLBAR_VOLUME_ATTR, "true");
    else toolbar.removeAttribute(TOOLBAR_VOLUME_ATTR);
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

  function ensureFrameScript(browser) {
    if (!browser?.messageManager) return false;
    try {
      if (!frameScriptUrl) {
        frameScriptUrl =
          "data:application/javascript;charset=utf-8," +
          encodeURIComponent(VOLUME_FRAME_SCRIPT);
      }
      // Always (re)load for this browser; content script is version-gated.
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
      const current = getActiveBrowser();
      // Only update the slider from the browser that owns the active card.
      if (!tab || !current || tab.linkedBrowser !== current) return;
      if (!sliderEl) return;
      const volume = Math.max(0, Math.min(100, message.data?.volume ?? 0));
      if (volume === 0 && !current.audioMuted) {
        restoreVolumeAfterUnmute();
        return;
      }
      // Session cache only — never persist Get responses (would clobber saved
      // volumes with the site's default 100 before Init runs after restart).
      if (volume > 0) rememberBrowserVolume(current, volume, { persist: false });
      sliderEl.value = String(volume);
    });
    messageListenersReady = true;
  }

  function requestContentVolume(browser) {
    if (!browser?.messageManager) return;
    ensureFrameScript(browser);
    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Get", {});
  }

  function applyVolume(percent) {
    const browser = getActiveBrowser();
    const tab = getActiveTab();
    if (!browser || !tab) return;

    const value = Math.max(0, Math.min(100, Math.round(percent)));
    ensureFrameScript(browser);

    if (value > 0) rememberBrowserVolume(browser, value);

    if (value === 0) {
      const current =
        Number(sliderEl?.value) > 0 ? Number(sliderEl.value) : getBrowserVolume(browser);
      rememberBrowserVolume(browser, current);
      if (!browser.audioMuted) tab.toggleMuteAudio();
    } else if (browser.audioMuted) {
      tab.toggleMuteAudio();
    }

    // Set only goes to this card's browser message manager.
    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Set", {
      volume: value,
    });
    syncCardMuteAttribute(activeCardEl, browser);
  }

  function restoreVolumeAfterUnmute() {
    const browser = getActiveBrowser();
    if (!browser || browser.audioMuted) return;

    const volume = getBrowserVolume(browser);
    ensureFrameScript(browser);
    browser.messageManager.sendAsyncMessage("ZenMediaVolumeSlider:Unmute", {
      volume,
    });
    if (sliderEl && !dragging) sliderEl.value = String(volume);
    syncCardMuteAttribute(activeCardEl, browser);
  }

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function syncPopupPosition() {
    if (!popupEl) return;
    const toolbar = getToolbar();
    if (!toolbar) return;

    const toolbarRect = toolbar.getBoundingClientRect();
    if (toolbarRect.width === 0 || toolbarRect.height === 0) return;

    const muteRect = muteButton?.getBoundingClientRect();
    const anchorRect =
      muteRect && muteRect.width > 0 && muteRect.height > 0 ? muteRect : toolbarRect;

    const popupLeft = toolbarRect.right + POPUP_GAP_PX;
    const popupTop = anchorRect.top + anchorRect.height / 2;

    popupEl.style.left = `${popupLeft}px`;
    popupEl.style.top = `${popupTop}px`;

    // Gap-only bridge: from the toolbar's right edge to the popup (no overlap on controls).
    if (bridgeEl) {
      const bridgeLeft = toolbarRect.right;
      const bridgeWidth = Math.max(POPUP_GAP_PX + 2, popupLeft - bridgeLeft + 2);
      const bridgeTop = anchorRect.top - 4;
      const bridgeHeight = Math.max(anchorRect.height + 8, 32);
      bridgeEl.style.left = `${bridgeLeft}px`;
      bridgeEl.style.top = `${bridgeTop}px`;
      bridgeEl.style.width = `${bridgeWidth}px`;
      bridgeEl.style.height = `${bridgeHeight}px`;
    }
  }

  function closePopup() {
    clearHideTimer();
    popupOpen = false;
    dragging = false;
    popupEl?.removeAttribute("open");
    bridgeEl?.removeAttribute("open");
    setToolbarVolumeOpen(false);

    const toolbar = getToolbar();
    if (toolbar && !toolbar.matches(":hover")) {
      clearArtworkOnToolbar(toolbar);
    }
  }

  function setActiveMuteTarget(nextMuteButton, nextCardEl) {
    muteButton = nextMuteButton;
    activeCardEl = nextCardEl;
  }

  function openPopup() {
    const toolbar = getToolbar();
    if (!toolbar || toolbar.hasAttribute("hidden") || !muteButton || !activeCardEl) {
      return;
    }
    if (activeCardEl.hasAttribute("media-sharing") || activeCardEl.hidden) {
      return;
    }

    clearHideTimer();
    syncPopupPosition();
    popupOpen = true;
    popupEl?.setAttribute("open", "true");
    bridgeEl?.setAttribute("open", "true");
    setToolbarVolumeOpen(true);
    applyArtworkToVisibleCards(toolbar);

    const browser = getActiveBrowser();
    if (!browser) return;

    // Show this browser's remembered volume immediately, then sync from content.
    if (browser.audioMuted) {
      sliderEl.value = "0";
      return;
    }

    sliderEl.value = String(getBrowserVolume(browser));
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

  function keepVolumeUiOpen() {
    clearHideTimer();
    syncPopupPosition();
    popupOpen = true;
    popupEl?.setAttribute("open", "true");
    bridgeEl?.setAttribute("open", "true");
    setToolbarVolumeOpen(true);
  }

  /** Keep popup/bridge on documentElement so they never affect toolbar flex layout. */
  function mountVolumeUi() {
    const root = document.documentElement;
    if (popupEl && popupEl.parentNode !== root) {
      root.appendChild(popupEl);
    }
    if (bridgeEl && bridgeEl.parentNode !== root) {
      root.appendChild(bridgeEl);
    }
  }

  function ensurePopup() {
    const existing = document.getElementById(POPUP_ID);
    if (existing) {
      popupEl = existing;
      sliderEl = document.getElementById(SLIDER_ID);
      bridgeEl = document.getElementById(BRIDGE_ID);
      if (!bridgeEl) {
        bridgeEl = document.createElement("div");
        bridgeEl.id = BRIDGE_ID;
        bridgeEl.setAttribute("aria-hidden", "true");
        bridgeEl.addEventListener("mouseenter", () => keepVolumeUiOpen());
        bridgeEl.addEventListener("mouseleave", scheduleHide);
      }
      mountVolumeUi();
      return !!popupEl && !!sliderEl;
    }

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
    sliderEl.value = "100";
    sliderEl.setAttribute("aria-label", "Volume");

    bridgeEl = document.createElement("div");
    bridgeEl.id = BRIDGE_ID;
    bridgeEl.setAttribute("aria-hidden", "true");

    popupEl.appendChild(sliderEl);
    document.documentElement.appendChild(bridgeEl);
    document.documentElement.appendChild(popupEl);

    const onVolumeZoneEnter = () => keepVolumeUiOpen();

    bridgeEl.addEventListener("mouseenter", onVolumeZoneEnter);
    bridgeEl.addEventListener("mouseleave", scheduleHide);

    popupEl.addEventListener("mouseenter", onVolumeZoneEnter);
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
        muteButton?.focus();
      }
    });

    return true;
  }

  /** Undo older wraps that broke native toolbarbutton hover/layout. */
  function unwrapMuteButton(button) {
    const anchor = button?.parentElement;
    if (!anchor?.hasAttribute?.("zen-volume-anchor")) return;
    const parent = anchor.parentNode;
    if (!parent) return;
    parent.insertBefore(button, anchor);
    anchor.remove();
  }

  function onCardMuteChanged(cardEl) {
    if (!sliderEl || dragging || cardEl !== activeCardEl) return;

    const isMuted = cardEl.hasAttribute("muted");
    const wasMuted = cardWasMuted.get(cardEl) === true;

    if (!wasMuted && isMuted) {
      sliderEl.value = "0";
    } else if (wasMuted && !isMuted) {
      restoreVolumeAfterUnmute();
    }

    cardWasMuted.set(cardEl, isMuted);
  }

  /**
   * Wire mute button hover directly (no wrapper) so native hover styles stay intact.
   */
  function wireCard(cardEl) {
    if (!cardEl || wiredCards.has(cardEl)) return false;

    const button = cardEl.querySelector(MUTE_SELECTOR);
    if (!button) return false;

    // Sharing cards hide the mute button; skip wiring.
    if (cardEl.hasAttribute("media-sharing")) {
      wiredCards.add(cardEl);
      return true;
    }

    if (!ensurePopup()) return false;

    unwrapMuteButton(button);

    button.addEventListener("mouseenter", () => {
      setActiveMuteTarget(button, cardEl);
      openPopup();
    });
    button.addEventListener("mouseleave", scheduleHide);

    button.addEventListener(
      "pointerdown",
      () => {
        setActiveMuteTarget(button, cardEl);
        capturePreMuteVolume(getActiveBrowser());
      },
      true
    );

    cardWasMuted.set(cardEl, cardEl.hasAttribute("muted"));

    const muteObserver = new MutationObserver(() => onCardMuteChanged(cardEl));
    muteObserver.observe(cardEl, {
      attributes: true,
      attributeFilter: ["muted"],
    });

    const binding = resolveCardBinding(cardEl);
    if (binding?.browser) {
      ensureFrameScript(binding.browser);
      // Warm volume from prefs and push into content so restart restores level.
      getBrowserVolume(binding.browser);
      restorePersistedVolumeToContent(binding.browser);
    }

    wiredCards.add(cardEl);
    return true;
  }

  function scanAndWireCards(toolbar) {
    for (const cardEl of toolbar.querySelectorAll(CARD_SELECTOR)) {
      // Prefer official frontCard binding when available.
      const front = window.gZenMediaController?.frontCard;
      if (front?.element === cardEl) {
        bindCard(cardEl, front.browser, front.controller ?? null);
      }
      wireCard(cardEl);
    }
  }

  /**
   * Hook native activate methods so we can map each new card to its browser.
   */
  function installControllerHooks() {
    const mc = window.gZenMediaController;
    if (!mc || hooksInstalled) return !!mc;

    if (typeof mc.activateMediaControls === "function") {
      const original = mc.activateMediaControls.bind(mc);
      mc.activateMediaControls = (mediaController, browser) => {
        const toolbar = getToolbar();
        const before = new Set(toolbar?.querySelectorAll(CARD_SELECTOR) ?? []);
        const result = original(mediaController, browser);
        if (toolbar) {
          for (const cardEl of toolbar.querySelectorAll(CARD_SELECTOR)) {
            if (!before.has(cardEl)) {
              bindCard(cardEl, browser, mediaController);
              wireCard(cardEl);
            }
          }
        }
        return result;
      };
    }

    if (typeof mc.activateMediaDeviceControls === "function") {
      const originalDevice = mc.activateMediaDeviceControls.bind(mc);
      mc.activateMediaDeviceControls = (browser) => {
        const toolbar = getToolbar();
        const before = new Set(toolbar?.querySelectorAll(CARD_SELECTOR) ?? []);
        const result = originalDevice(browser);
        if (toolbar) {
          for (const cardEl of toolbar.querySelectorAll(CARD_SELECTOR)) {
            if (!before.has(cardEl)) {
              bindCard(cardEl, browser, null);
              wireCard(cardEl);
            }
          }
        }
        return result;
      };
    }

    hooksInstalled = true;
    return true;
  }

  function observeToolbar(toolbar) {
    if (toolbarObserver) return;

    toolbarObserver = new MutationObserver(() => {
      if (toolbar.hasAttribute("hidden")) {
        closePopup();
        clearArtworkOnToolbar(toolbar);
      }
    });
    toolbarObserver.observe(toolbar, {
      attributes: true,
      attributeFilter: ["hidden"],
    });

    cardsObserver = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) scanAndWireCards(toolbar);
    });
    cardsObserver.observe(toolbar, { childList: true });

    const bumpLayout = () => {
      if (popupOpen) syncPopupPosition();
    };
    window.addEventListener("resize", bumpLayout);
    safe(() => {
      layoutObserver = new ResizeObserver(bumpLayout);
      layoutObserver.observe(toolbar);
    });
  }

  function buildUi() {
    const toolbar = getToolbar();
    if (!toolbar || typeof window.gZenMediaController === "undefined") {
      return false;
    }

    installControllerHooks();
    setupMessageListeners();
    // Prebuild popup + frame-script URL so the first mute hover isn't cold.
    ensurePopup();
    if (!frameScriptUrl) {
      frameScriptUrl =
        "data:application/javascript;charset=utf-8," +
        encodeURIComponent(VOLUME_FRAME_SCRIPT);
    }
    addArtworkHoverListeners(toolbar);
    observeToolbar(toolbar);
    scanAndWireCards(toolbar);

    // Ready once controller + toolbar exist; cards may appear later via observer.
    log("UI ready for stacked media cards");
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
