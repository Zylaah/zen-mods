// ==UserScript==
// @name           Better Media Toolbar
// @description    Volume slider on mute hover and media artwork background on toolbar hover
// @author         Zylaah
// @version        1.3.0
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
  const ARTWORK_VAR = "--zen-media-artwork-bg";
  const ARTWORK_CLASS = "has-artwork";
  const CARD_SELECTOR = ".zen-media-card";
  const MUTE_SELECTOR = ".zen-media-mute-button";
  const TOOLBAR_VOLUME_ATTR = "zen-volume-open";
  const HIDE_DELAY_MS = 280;
  const POPUP_GAP_PX = 8;
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
  /** @type {Element | null} Active volume anchor wrapping that mute button */
  let anchorEl = null;
  /** @type {HTMLElement | null} Card that owns the active mute button */
  let activeCardEl = null;
  let popupEl = null;
  let sliderEl = null;
  let toolbarObserver = null;
  let cardsObserver = null;
  let layoutObserver = null;

  /** Per-browser last unmuted volume (never shared across cards/tabs). */
  /** @type {WeakMap<object, number>} */
  const browserVolumes = new WeakMap();

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
    toolbar.addEventListener("mouseleave", () => clearArtworkOnToolbar(toolbar));
    toolbar.dataset.artworkListenersAdded = "true";
  }

  function rememberBrowserVolume(browser, volume) {
    if (!browser) return;
    const value = Math.max(1, Math.min(100, Math.round(volume)));
    browserVolumes.set(browser, value);
  }

  function getBrowserVolume(browser) {
    return browserVolumes.get(browser) ?? 100;
  }

  function capturePreMuteVolume(browser) {
    if (!browser || browser.audioMuted) return;
    const fromSlider = Number(sliderEl?.value);
    rememberBrowserVolume(
      browser,
      fromSlider > 0 ? fromSlider : getBrowserVolume(browser)
    );
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

    const s = popupEl.style;
    s.left = `${toolbarRect.right + POPUP_GAP_PX}px`;
    s.top = `${anchorRect.top + anchorRect.height / 2}px`;
  }

  function closePopup() {
    clearHideTimer();
    popupOpen = false;
    dragging = false;
    popupEl?.removeAttribute("open");
    setToolbarVolumeOpen(false);
  }

  function setActiveMuteTarget(nextMuteButton, nextAnchor, nextCardEl) {
    muteButton = nextMuteButton;
    anchorEl = nextAnchor;
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
    setToolbarVolumeOpen(true);

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

  function ensurePopup() {
    if (document.getElementById(POPUP_ID)) {
      popupEl = document.getElementById(POPUP_ID);
      sliderEl = document.getElementById(SLIDER_ID);
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

    popupEl.appendChild(sliderEl);
    document.documentElement.appendChild(popupEl);

    popupEl.addEventListener("mouseenter", () => {
      clearHideTimer();
      syncPopupPosition();
      popupOpen = true;
      popupEl.setAttribute("open", "true");
      setToolbarVolumeOpen(true);
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
        muteButton?.focus();
      }
    });

    return true;
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
   * Wrap a card's mute button with the volume hover anchor and wire events.
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

    let anchor = button.parentElement?.hasAttribute?.("zen-volume-anchor")
      ? button.parentElement
      : null;

    if (!anchor) {
      anchor = document.createElement("div");
      anchor.setAttribute("zen-volume-anchor", "true");
      const parent = button.parentNode;
      if (!parent) return false;
      parent.insertBefore(anchor, button);
      anchor.appendChild(button);
    }

    anchor.addEventListener("mouseenter", () => {
      setActiveMuteTarget(button, anchor, cardEl);
      openPopup();
    });
    anchor.addEventListener("mouseleave", scheduleHide);

    button.addEventListener(
      "pointerdown",
      () => {
        setActiveMuteTarget(button, anchor, cardEl);
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
    if (binding?.browser) ensureFrameScript(binding.browser);

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
    ensurePopup();
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
