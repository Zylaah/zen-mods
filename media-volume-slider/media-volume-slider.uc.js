// ==UserScript==
// @name           Better Media Toolbar
// @description    Artwork, progress ring, and hover controls on Zen's media cards
// @author         Zylaah
// @version        2.1.0
// @namespace      https://github.com/Zylaah/zen-mods
// ==/UserScript==

/* eslint-env es6, browser */
/* global gBrowser, Services */

(function () {
  "use strict";

  if (window.__bmtLoaded) return;
  window.__bmtLoaded = true;

  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ARTWORK_WAIT_MS = 1500;
  const FLIP_OUT_MS = 200;
  const FLIP_IN_MS = 380;
  const LONG_MEDIA_SECONDS = 900_000;

  const noted = new Set();
  const mediaColorCache = new Map();
  const soundBarCache = new Map();
  const faviconTints = new Map();

  let soundBarToken = 0;
  let ringCount = 0;
  let started = false;

  const BAR_X = [1.6, 5.2, 8.8, 12.4];
  const BAR_W = 2;
  const BAR_REST = [
    [4.5, 7],
    [2.5, 11],
    [3.5, 9],
    [5.25, 5.5],
  ];

  function noteError(where, err) {
    if (noted.has(where)) return;
    noted.add(where);
    console.debug("[BetterMediaToolbar]", where, err);
  }

  function toolbar() {
    return document.getElementById("zen-media-controls-toolbar");
  }

  function parseColor(text) {
    const parts = String(text).match(/[\d.]+/g)?.map(Number) || [];
    if (parts.length < 3) return [0, 0, 0, 0];
    return [parts[0], parts[1], parts[2], Math.round((parts[3] ?? 1) * 255)];
  }

  function colorOver(top, bottom) {
    const topAlpha = top[3] / 255;
    const bottomAlpha = (bottom[3] / 255) * (1 - topAlpha);
    const alpha = topAlpha + bottomAlpha;
    if (!alpha) return [0, 0, 0, 0];
    return [0, 1, 2]
      .map((i) => Math.round((top[i] * topAlpha + bottom[i] * bottomAlpha) / alpha))
      .concat(Math.round(alpha * 255));
  }

  function cssColor([r, g, b, a = 255]) {
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  }

  function brightnessOf([r, g, b, a = 255]) {
    const behind = matchMedia("(prefers-color-scheme: dark)").matches ? 0 : 255;
    return ((r * 299 + g * 587 + b * 114) / 1000) * (a / 255) + behind * (1 - a / 255);
  }

  function resolveColor(text) {
    if (!text || !text.trim()) return null;
    let probe = document.getElementById("bmt-color-probe");
    if (!probe) {
      probe = document.createElementNS(XHTML_NS, "div");
      probe.id = "bmt-color-probe";
      probe.hidden = true;
      document.documentElement.appendChild(probe);
    }
    probe.style.color = "";
    probe.style.color = text.trim();
    if (!probe.style.color) return null;
    return parseColor(getComputedStyle(probe).color);
  }

  const COLOR_TOKEN = /(?:rgba?|hsla?|color-mix|light-dark|oklch|oklab|lab|lch|color)\((?:[^()]|\([^()]*\))*\)|#[0-9a-fA-F]{3,8}\b|\btransparent\b/g;

  function paintColor(value) {
    if (!value) return null;
    if (!/gradient\(/.test(value)) return resolveColor(value);
    const stops = (value.match(COLOR_TOKEN) || []).map(resolveColor).filter(Boolean);
    if (!stops.length) return null;
    return [0, 1, 2, 3].map((i) => Math.round(stops.reduce((sum, color) => sum + color[i], 0) / stops.length));
  }

  function neutralBars() {
    if (!document.documentElement.hasAttribute("bmt-light")) return null;
    return ["rgb(48, 48, 52)", "rgb(72, 72, 78)"];
  }

  function applyForeground(color) {
    const root = document.documentElement;
    const bright = color ? brightnessOf(color) > 160 : !matchMedia("(prefers-color-scheme: dark)").matches;
    const wasLight = root.hasAttribute("bmt-light");
    root.style.setProperty("--bmt-fg", bright ? "rgb(20, 20, 22)" : "rgb(255, 255, 255)");
    root.style.setProperty("--bmt-fg-dim", bright ? "rgba(20, 20, 22, 0.62)" : "rgba(255, 255, 255, 0.65)");
    root.style.setProperty("--bmt-track", bright ? "rgba(0, 0, 0, 0.16)" : "rgba(255, 255, 255, 0.2)");
    root.style.setProperty("--bmt-ring-track", bright ? "rgba(0, 0, 0, 0.14)" : "rgba(255, 255, 255, 0.14)");
    root.style.setProperty("--bmt-hairline", bright ? "rgba(0, 0, 0, 0.08)" : "rgba(255, 255, 255, 0.07)");
    root.style.setProperty("--bmt-button-hover", bright ? "rgba(0, 0, 0, 0.08)" : "rgba(255, 255, 255, 0.12)");
    root.toggleAttribute("bmt-light", bright);
    if (wasLight !== bright) {
      installSoundDefaults();
      for (const card of toolbar()?.querySelectorAll(".zen-media-card") || []) {
        paintSoundBars(card, card.__bmtColors ?? null);
      }
    }
  }

  function syncSidebarPaint() {
    const root = document.documentElement;
    const compact = root.getAttribute("zen-compact-mode") === "true";
    const layer = document.getElementById(compact ? "zen-toolbar-background" : "zen-browser-background");
    const name = compact ? "--zen-main-browser-background-toolbar" : "--zen-main-browser-background";
    const paint = layer ? paintColor(getComputedStyle(layer).getPropertyValue(name)) : null;
    const rootStyle = getComputedStyle(root);
    const tint = resolveColor(rootStyle.getPropertyValue("--bmt-media-bg"));
    const base = resolveColor(rootStyle.getPropertyValue("--bmt-card-base"));
    if (!paint || !tint || !base) {
      root.style.removeProperty("--bmt-rest");
      root.style.removeProperty("--bmt-solid");
      applyForeground(null);
      return;
    }
    const rest = colorOver(tint, paint);
    root.style.setProperty("--bmt-rest", cssColor(rest));
    root.style.setProperty("--bmt-solid", cssColor(colorOver(tint, colorOver(paint, base))));
    applyForeground(rest);
  }

  function watchSidebarPaint() {
    try {
      syncSidebarPaint();
    } catch (err) {
      noteError("sidebar paint", err);
    }
    const watcher = new MutationObserver(() => {
      try {
        syncSidebarPaint();
      } catch (err) {
        noteError("sidebar paint", err);
      }
    });
    for (const id of ["zen-browser-background", "zen-toolbar-background"]) {
      const layer = document.getElementById(id);
      if (layer) watcher.observe(layer, { attributes: true, attributeFilter: ["style"] });
    }
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["zen-compact-mode"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      try {
        syncSidebarPaint();
      } catch (err) {
        noteError("sidebar paint", err);
      }
    });
  }

  function artUrlOf(card) {
    const artwork = card.querySelector(".zen-media-focus-button[bmt-art]")?.getAttribute("bmt-art");
    if (artwork) return artwork;
    const favicon = card.querySelector(".zen-media-focus-button[bmt-favicon]")?.getAttribute("bmt-favicon");
    if (favicon) return favicon;
    const img = card.querySelector(".zen-media-focus-button image, .zen-media-focus-button .toolbarbutton-icon");
    if (!img) return "";
    const src = img.getAttribute("src") || img.src || "";
    if (src) return src;
    const listStyle = getComputedStyle(img).listStyleImage || "";
    const match = listStyle.match(/url\(["']?(.*?)["']?\)/);
    return match ? match[1] : "";
  }

  function boost([r, g, b]) {
    const avg = (r + g + b) / 3;
    return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(avg + (v - avg) * 1.6))));
  }

  function readArtColors(url) {
    return new Promise((resolve) => {
      if (!url) {
        resolve(null);
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          const size = 24;
          const canvas = document.createElementNS(XHTML_NS, "canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, size, size);
          const { data } = ctx.getImageData(0, 0, size, size);
          const halves = [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ];
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              const i = (y * size + x) * 4;
              if (data[i + 3] < 128) continue;
              const half = halves[x < size / 2 ? 0 : 1];
              half[0] += data[i];
              half[1] += data[i + 1];
              half[2] += data[i + 2];
              half[3]++;
            }
          }
          const colors = halves.map((half) => (half[3] ? boost([half[0] / half[3], half[1] / half[3], half[2] / half[3]]) : null));
          if (!colors[0] && !colors[1]) {
            resolve(null);
            return;
          }
          const left = colors[0] || colors[1];
          const right = colors[1] || colors[0];
          resolve([`rgb(${left.join(", ")})`, `rgb(${right.join(", ")})`]);
        } catch (err) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function updateCardGlow(card) {
    const url = artUrlOf(card);
    if (card.__bmtArtUrl === url) return;
    card.__bmtArtUrl = url;

    const isArtwork = !!card.querySelector(".zen-media-focus-button[bmt-art]");
    if (!isArtwork) {
      if (!card.hasAttribute("bmt-glow-ready")) card.setAttribute("bmt-glow-pending", "true");
      await new Promise((resolve) => setTimeout(resolve, ARTWORK_WAIT_MS));
      if (card.__bmtArtUrl !== url) return;
    }

    let colors = mediaColorCache.get(url);
    if (colors === undefined) {
      colors = await readArtColors(url);
      mediaColorCache.set(url, colors);
    }
    if (card.__bmtArtUrl !== url) return;

    if (colors) {
      card.style.setProperty("--bmt-glow-a", colors[0]);
      card.style.setProperty("--bmt-glow-b", colors[1]);
    } else {
      card.style.removeProperty("--bmt-glow-a");
      card.style.removeProperty("--bmt-glow-b");
    }
    card.removeAttribute("bmt-glow-pending");
    card.setAttribute("bmt-glow-ready", "true");
    paintSoundBars(card, colors);
  }

  function mixTowardWhite(color, amount) {
    const parts = String(color).match(/\d+(\.\d+)?/g);
    if (!parts || parts.length < 3) return "rgb(255, 255, 255)";
    const [r, g, b] = parts.slice(0, 3).map(Number).map((v) => Math.round(v + (255 - v) * amount));
    return `rgb(${r}, ${g}, ${b})`;
  }

  function soundBarImages(colors, lightenBy) {
    const key = `${colors ? colors.join("|") : "white"}|${lightenBy}`;
    const cached = soundBarCache.get(key);
    if (cached) return cached;

    const a = colors ? mixTowardWhite(colors[0], lightenBy) : "rgb(255, 255, 255)";
    const b = colors ? mixTowardWhite(colors[1] || colors[0], lightenBy) : "rgb(255, 255, 255)";
    const gradient =
      `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="1.6" y1="0" x2="14.4" y2="0">` +
      `<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>`;
    const moving = [0.55, 0.68, 0.5, 0.74];
    const wave =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${gradient}` +
      `<style>rect{transform-box:fill-box;transform-origin:center;animation:grow .26s cubic-bezier(.2,.9,.3,1) both,z .6s .26s ease-in-out infinite alternate}` +
      moving.map((duration, i) => `.b${i}{animation-duration:.26s,${duration}s;animation-delay:0s,${(0.26 + i * 0.05).toFixed(2)}s}`).join("") +
      `@keyframes grow{from{height:2px;y:7px}to{height:11px;y:2.5px}}` +
      `@keyframes z{from{transform:scaleY(.22)}to{transform:scaleY(1)}}` +
      `@media (prefers-reduced-motion:reduce){rect{animation:none;transform:scaleY(.6)}}</style>` +
      `<g fill="url(#g)">` +
      BAR_X.map((x, i) => `<rect class="b${i}" x="${x}" y="2.5" width="${BAR_W}" height="11" rx="1"/>`).join("") +
      `</g></svg>`;
    const dots =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${gradient}` +
      `<style>rect{animation:shrink .28s cubic-bezier(.4,0,.2,1) forwards}@keyframes shrink{to{height:${BAR_W}px;y:${8 - BAR_W / 2}px}}` +
      `@media (prefers-reduced-motion:reduce){rect{animation-duration:1ms}}</style>` +
      `<g fill="url(#g)">` +
      BAR_X.map((x, i) => `<rect x="${x}" y="${BAR_REST[i][0]}" width="${BAR_W}" height="${BAR_REST[i][1]}" rx="1"/>`).join("") +
      `</g></svg>`;
    const still =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${gradient}<g fill="url(#g)">` +
      BAR_X.map((x, i) => `<rect x="${x}" y="${BAR_REST[i][0]}" width="${BAR_W}" height="${BAR_REST[i][1]}" rx="1"/>`).join("") +
      `</g></svg>`;
    const encoded = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const images = { wave: encoded(wave), dots: encoded(dots), still: encoded(still) };
    soundBarCache.set(key, images);
    return images;
  }

  function freshSoundBars(colors, lightenBy) {
    const images = soundBarImages(colors, lightenBy);
    const token = ++soundBarToken;
    return {
      wave: `url("${images.wave}#${token}")`,
      dots: `url("${images.dots}#${token}")`,
      still: `url("${images.still}")`,
    };
  }

  function barSpec(colors) {
    if (colors) return { colors, lightenBy: 0.35 };
    const neutral = neutralBars();
    if (neutral) return { colors: neutral, lightenBy: 0 };
    return { colors: null, lightenBy: 0 };
  }

  function applySoundBars(element, colors) {
    const spec = barSpec(colors);
    const fresh = freshSoundBars(spec.colors, spec.lightenBy);
    element.style.setProperty("--bmt-sound-wave", fresh.wave);
    element.style.setProperty("--bmt-sound-still", fresh.still);
    element.style.setProperty("--bmt-sound-muted", fresh.dots);
  }

  function installSoundDefaults() {
    applySoundBars(document.documentElement, null);
  }

  function watchCardSoundState(card) {
    if (card.__bmtSoundWatch) return;
    card.__bmtSoundWatch = true;
    let last = "";
    new MutationObserver(() => {
      const state = `${card.classList.contains("playing")}|${card.hasAttribute("muted")}`;
      if (state === last) return;
      last = state;
      applySoundBars(card, card.__bmtColors ?? null);
    }).observe(card, { attributes: true, attributeFilter: ["class", "muted"] });
  }

  function paintSoundBars(card, colors) {
    card.__bmtColors = colors;
    applySoundBars(card, colors);
    watchCardSoundState(card);
  }

  function ensureRing(button) {
    if (!button || button.querySelector(":scope > .bmt-ring")) return;
    const id = `bmt-ring-gradient-${++ringCount}`;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "bmt-ring");
    svg.setAttribute("viewBox", "0 0 46 46");
    svg.setAttribute("aria-hidden", "true");

    const make = (tag, attrs, parent) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
      parent.appendChild(el);
      return el;
    };

    const gradient = make("linearGradient", { id, x1: "0", y1: "0", x2: "1", y2: "1" }, make("defs", {}, svg));
    make("stop", { offset: "0", style: "stop-color: var(--bmt-glow-a)" }, gradient);
    make("stop", { offset: "1", style: "stop-color: var(--bmt-glow-b)" }, gradient);
    // Starts at the top and runs clockwise. Round, to match the artwork tile.
    const shape = {
      d: "M23 1 L35 1 A10 10 0 0 1 45 11 L45 35 A10 10 0 0 1 35 45 L11 45 A10 10 0 0 1 1 35 L1 11 A10 10 0 0 1 11 1 Z",
      fill: "none",
      "stroke-width": "2",
      pathLength: "100",
    };
    make("path", { ...shape, class: "bmt-ring-track" }, svg);
    make("path", {
      ...shape,
      class: "bmt-ring-fill",
      stroke: `url(#${id})`,
      "stroke-linecap": "round",
      "stroke-dasharray": "0 100",
      "stroke-opacity": "0",
    }, svg);
    button.appendChild(svg);
  }

  function setRing(card, fraction) {
    const fill = card.focusButton?.querySelector(".bmt-ring-fill");
    if (!fill) return;
    const pct = Math.max(0, Math.min(1, fraction || 0)) * 100;
    fill.style.strokeDasharray = pct > 0.2 ? `${pct.toFixed(2)} 100` : "0 100";
    fill.style.strokeOpacity = pct > 0.2 ? "1" : "0";
  }

  function formatRemaining(card, seconds) {
    const safe = Math.max(0, seconds || 0);
    if (typeof card.formatSecondsToTime === "function") {
      return `-${card.formatSecondsToTime(safe)}`;
    }
    const whole = Math.floor(safe);
    const pad = (n) => String(n).padStart(2, "0");
    const minutes = Math.floor(whole / 60);
    const hours = Math.floor(minutes / 60);
    if (hours) return `-${hours}:${pad(minutes % 60)}:${pad(whole % 60)}`;
    return `-${minutes}:${pad(whole % 60)}`;
  }

  function showTimeLeft(card) {
    const bar = card.progressBar;
    if (!bar || !card.duration || card.duration >= LONG_MEDIA_SECONDS) {
      setRing(card, 0);
      return;
    }
    const fraction = Number(bar.value) / 100;
    setRing(card, fraction);
    if (card.durationEl) {
      const played = fraction * card.duration;
      card.durationEl.textContent = formatRemaining(card, card.duration - played);
    }
  }

  function watchTimeLeft(card) {
    const label = card.currentTimeEl;
    if (label && !label.__bmtTimeLeft) {
      label.__bmtTimeLeft = true;
      new MutationObserver(() => showTimeLeft(card)).observe(label, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    const bar = card.progressBar;
    if (bar && !bar.__bmtScrub) {
      bar.__bmtScrub = true;
      bar.addEventListener("input", () => showTimeLeft(card));
    }
  }

  function tintFromColors(colors) {
    const parts = String(colors?.[0] || "").match(/\d+(\.\d+)?/g);
    if (!parts) return "rgb(44, 44, 46)";
    const [r, g, b] = parts.slice(0, 3).map(Number).map((v) => Math.round(v * 0.32 + 26));
    return `rgb(${r}, ${g}, ${b})`;
  }

  async function showFaviconTile(card, button, art) {
    if (art) {
      button.removeAttribute("bmt-favicon");
      button.removeAttribute("bmt-initial");
      return;
    }
    const tab = card.browser && gBrowser.getTabForBrowser(card.browser);
    let icon =
      tab?.getAttribute("image") ||
      (tab && gBrowser.getIcon?.(tab)) ||
      card.browser?.mIconURL ||
      (card.browser?.currentURI?.spec ? `page-icon:${card.browser.currentURI.spec}` : "");
    if (/defaultFavicon|globe/i.test(icon)) icon = "";

    if (!icon) {
      let host = "";
      try {
        host = card.browser?.currentURI?.displayHost?.replace(/^www\./, "") || "";
      } catch (err) {
        host = "";
      }
      button.setAttribute("bmt-favicon", "");
      button.setAttribute("bmt-initial", (host[0] || "♪").toUpperCase());
      button.style.removeProperty("--bmt-media-favicon");
      button.style.setProperty("--bmt-favicon-tint", "rgb(52, 52, 56)");
      return;
    }

    button.removeAttribute("bmt-initial");
    button.setAttribute("bmt-favicon", icon);
    button.style.setProperty("--bmt-media-favicon", `url("${icon.replace(/"/g, "%22")}")`);
    let tint = faviconTints.get(icon);
    if (!tint) {
      let colors = mediaColorCache.get(icon);
      if (colors === undefined) {
        colors = await readArtColors(icon);
        mediaColorCache.set(icon, colors);
      }
      tint = tintFromColors(colors);
      faviconTints.set(icon, tint);
    }
    if (button.getAttribute("bmt-favicon") === icon) {
      button.style.setProperty("--bmt-favicon-tint", tint);
    }
  }

  function flipArtwork(button, swap) {
    const icon = button.querySelector(":scope > .toolbarbutton-icon") || button.querySelector("image");
    if (!icon || typeof icon.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      swap();
      return;
    }
    // One animation, picture swapped on a timer. Waiting on the first half's
    // finished promise can leave the picture edge-on if Firefox never resolves it.
    button.__bmtFlip?.cancel();
    clearTimeout(button.__bmtFlipSwap);
    const half = FLIP_OUT_MS / (FLIP_OUT_MS + FLIP_IN_MS);
    button.__bmtFlip = icon.animate(
      [
        { offset: 0, transform: "perspective(240px) rotateY(0deg)", easing: "cubic-bezier(0.55, 0, 1, 0.45)" },
        { offset: half, transform: "perspective(240px) rotateY(90deg)" },
        { offset: half, transform: "perspective(240px) rotateY(-90deg)", easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
        { offset: half + 0.75 * (1 - half), transform: "perspective(240px) rotateY(8deg)", easing: "ease-in-out" },
        { offset: 1, transform: "perspective(240px) rotateY(0deg)" },
      ],
      { duration: FLIP_OUT_MS + FLIP_IN_MS }
    );
    button.__bmtFlipSwap = setTimeout(swap, FLIP_OUT_MS);
  }

  function isStandInArtwork(src) {
    return !src || /^(jar|chrome|resource|moz-src):/i.test(src) || /defaultFavicon|globe/i.test(src);
  }

  function bestArtwork(artwork) {
    if (!Array.isArray(artwork)) return "";
    const usable = artwork.filter((item) => !isStandInArtwork(item?.src));
    if (!usable.length) return "";
    const area = (item) => {
      let best = 0;
      for (const size of String(item.sizes || "").split(/\s+/)) {
        const [w, h] = size.split("x");
        const value = (parseInt(w, 10) || 0) * (parseInt(h, 10) || 0);
        if (value > best) best = value;
      }
      return best;
    };
    return [...usable].sort((a, b) => area(b) - area(a))[0]?.src || "";
  }

  const EMOJI =
    /(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{Emoji_Modifier}?[\u{E0020}-\u{E007F}]*(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)/gu;

  function withoutEmoji(text) {
    const bare = String(text || "").replace(EMOJI, " ").replace(/\s{2,}/g, " ").trim();
    return bare || text;
  }

  function dropCardEmoji(card) {
    for (const label of [card.titleEl, card.artistEl]) {
      if (!label) continue;
      const next = withoutEmoji(label.textContent);
      if (next !== label.textContent) label.textContent = next;
    }
  }

  function markLiveStream(card) {
    const element = card.element;
    const browser = card.browser;
    if (!element || !browser) return;
    let host = "";
    let path = "";
    try {
      host = browser.currentURI?.host || "";
      path = browser.currentURI?.filePath || "";
    } catch (err) {
      host = "";
    }
    const kickChannel = /^(www\.)?kick\.com$/.test(host) && /^\/[\w-]+\/?$/.test(path);
    element.toggleAttribute("bmt-live", kickChannel);
  }

  function dressCardIcon(card) {
    dropCardEmoji(card);
    if (card.element) card.element.__bmtCard = card;
    const button = card.focusButton;
    if (!button) return;

    let art = "";
    try {
      art = bestArtwork(card.controller?.getMetadata?.()?.artwork);
    } catch (err) {
      noteError("artwork", err);
    }

    ensureRing(button);
    if (art) {
      const previous = button.getAttribute("bmt-art");
      button.setAttribute("bmt-art", art);
      const showArt = () => button.style.setProperty("--bmt-media-art", `url("${art.replace(/"/g, "%22")}")`);
      if (previous && previous !== art) flipArtwork(button, showArt);
      else showArt();
    } else {
      button.removeAttribute("bmt-art");
      button.style.removeProperty("--bmt-media-art");
    }
    showFaviconTile(card, button, art);
  }

  function keepCardsWithPip() {
    const front = window.gZenMediaController?.frontCard;
    const proto = front && Object.getPrototypeOf(front);
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "shouldBeVisible");
    if (!desc?.get || desc.get.__bmt) return;
    const original = desc.get;
    const patched = function () {
      try {
        if (
          !this.isSharing &&
          this.controller?.isBeingUsedInPIPModeOrFullscreen &&
          !document.fullscreenElement &&
          !window.fullScreen
        ) {
          return gBrowser.selectedBrowser.browserId !== this.browser.browserId;
        }
      } catch (err) {
        noteError("pip", err);
      }
      return original.call(this);
    };
    patched.__bmt = true;
    Object.defineProperty(proto, "shouldBeVisible", { ...desc, get: patched });
  }

  function useMediaArtwork() {
    const front = window.gZenMediaController?.frontCard;
    const proto = front && Object.getPrototypeOf(front);
    if (!proto || typeof proto.updateIcon !== "function" || proto.updateIcon.__bmt) {
      return !!proto?.updateIcon?.__bmt;
    }

    const originalPosition = proto.updatePosition;
    if (typeof originalPosition === "function") {
      proto.updatePosition = function (...args) {
        const result = originalPosition.apply(this, args);
        try {
          if (this.element) this.element.__bmtCard = this;
          watchTimeLeft(this);
          showTimeLeft(this);
          markLiveStream(this);
        } catch (err) {
          noteError("updatePosition", err);
        }
        return result;
      };
    }

    const originalIcon = proto.updateIcon;
    const patched = function () {
      originalIcon.call(this);
      try {
        dressCardIcon(this);
      } catch (err) {
        noteError("artwork", err);
      }
    };
    patched.__bmt = true;
    proto.updateIcon = patched;

    keepCardsWithPip();
    try {
      front.updateIcon();
      front.updatePosition?.();
    } catch (err) {
      noteError("show artwork", err);
    }
    return true;
  }

  function watchMedia(bar) {
    let frame = null;
    let artworkReady = false;
    const refresh = () => {
      frame = null;
      if (!artworkReady) artworkReady = useMediaArtwork();
      for (const card of bar.querySelectorAll(".zen-media-card")) updateCardGlow(card);
    };
    new MutationObserver((records) => {
      if (records.every((record) => record.target.closest?.(".bmt-ring, .bmt-glow"))) return;
      if (!frame) frame = requestAnimationFrame(refresh);
    }).observe(bar, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "style", "hidden", "bmt-art", "bmt-favicon"],
    });
    refresh();
  }

  function watchFaviconUpdates() {
    if (!gBrowser?.tabContainer) return;
    gBrowser.tabContainer.addEventListener("TabAttrModified", (event) => {
      if (!event.detail?.changed?.includes("image")) return;
      for (const element of toolbar()?.querySelectorAll(".zen-media-card") || []) {
        const card = element.__bmtCard;
        if (card?.browser !== event.target.linkedBrowser) continue;
        try {
          card.updateIcon();
        } catch (err) {
          noteError("favicon", err);
        }
      }
    });
  }

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hslToRgb(h, s, l) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t) => {
      t = (t + 1) % 1;
      const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
      return Math.round(v * 255);
    };
    return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
  }

  const artPalettes = new Map();

  function readArtPalette(url) {
    return new Promise((resolve) => {
      if (!url) {
        resolve(null);
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          const size = 32;
          const canvas = document.createElementNS(XHTML_NS, "canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, size, size);
          const { data } = ctx.getImageData(0, 0, size, size);
          const bins = Array.from({ length: 12 }, (_, hue) => ({ hue, n: 0, r: 0, g: 0, b: 0 }));
          let seen = 0;
          for (let i = 0; i < data.length; i += 4) {
            const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
            if (a < 128) continue;
            seen++;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const sat = max ? (max - min) / max : 0;
            if (sat < 0.25 || max < 50) continue;
            const bin = bins[Math.floor(rgbToHsl(r, g, b)[0] * 12) % 12];
            bin.n += sat;
            bin.r += r * sat;
            bin.g += g * sat;
            bin.b += b * sat;
          }
          const picked = [];
          for (const bin of bins.filter((b) => b.n > seen * 0.012).sort((x, y) => y.n - x.n)) {
            if (picked.length < 4 && picked.every((p) => Math.min((p.hue - bin.hue + 12) % 12, (bin.hue - p.hue + 12) % 12) > 1)) {
              picked.push(bin);
            }
          }
          if (!picked.length) {
            resolve(null);
            return;
          }
          const glowy = ([h, s, l]) => [h, Math.max(0.7, s), Math.min(0.62, Math.max(0.52, l))];
          const colors = picked.map((bin) => glowy(rgbToHsl(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n)));
          if (colors.length === 1) {
            const [h, s, l] = colors[0];
            colors.push([(h + 0.07) % 1, s, l], [(h + 0.93) % 1, s, l]);
          }
          resolve(colors.map(([h, s, l]) => `rgb(${hslToRgb(h, s, l).join(", ")})`));
        } catch (err) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function loadGlowEngine() {
    if (window.BmtGlow?.create) return true;
    try {
      Services.scriptloader.loadSubScript("chrome://sine/content/media-volume-slider/media-glow.js", window);
    } catch (err) {
      noteError("glow script", err);
    }
    return !!window.BmtGlow?.create;
  }

  function watchUltraGlow(bar) {
    if (!loadGlowEngine()) return;
    const glows = new Map();
    const dark = () => !document.documentElement.hasAttribute("bmt-light");

    const tint = async (card, glow) => {
      const url = artUrlOf(card);
      if (card.__bmtGlowArt === url) return;
      card.__bmtGlowArt = url;
      if (!artPalettes.has(url)) artPalettes.set(url, url ? await readArtPalette(url) : null);
      if (card.__bmtGlowArt === url && glows.get(card) === glow) glow.setColors(artPalettes.get(url));
    };

    const sync = () => {
      const seen = new Set();
      for (const card of bar.querySelectorAll(".zen-media-card")) {
        seen.add(card);
        let glow = glows.get(card);
        if (!glow) {
          glow = window.BmtGlow.create(card, { dark: dark() });
          glows.set(card, glow);
          card.__bmtGlowArt = undefined;
        }
        tint(card, glow).catch((err) => noteError("glow colours", err));
        glow.setDark(dark());
        glow.setPlaying(card.classList.contains("playing") && card.matches(":hover"));
      }
      for (const [card, glow] of glows) {
        if (seen.has(card)) continue;
        glow.destroy();
        glows.delete(card);
      }
    };

    new MutationObserver(sync).observe(bar, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "bmt-art", "bmt-favicon"],
    });
    let pending = 0;
    const later = () => {
      pending ||= requestAnimationFrame(() => {
        pending = 0;
        sync();
      });
    };
    bar.addEventListener("mouseover", later);
    bar.addEventListener("mouseout", later);
    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["bmt-light"],
    });
    sync();
  }

  // A card can be dragged out of the sidebar like a toolbar button, which
  // takes it away from Zen's player until restart. Nothing on the card is a drag.
  function keepMediaCardsInPlace() {
    window.addEventListener(
      "dragstart",
      (event) => {
        if (!event.target?.closest?.("#zen-media-controls-toolbar")) return;
        event.preventDefault();
        event.stopPropagation();
      },
      true
    );
  }

  function start() {
    const bar = toolbar();
    if (started || !window.gBrowser || !bar) return false;
    started = true;
    installSoundDefaults();
    watchSidebarPaint();
    watchMedia(bar);
    watchUltraGlow(bar);
    watchFaviconUpdates();
    keepMediaCardsInPlace();
    return true;
  }

  function waitForToolbar() {
    if (start()) return;
    const observer = new MutationObserver(() => {
      if (start()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("unload", () => observer.disconnect(), { once: true });
  }

  if (document.readyState === "complete") waitForToolbar();
  else {
    document.addEventListener("DOMContentLoaded", waitForToolbar, { once: true });
    window.addEventListener("load", waitForToolbar, { once: true });
  }
})();
