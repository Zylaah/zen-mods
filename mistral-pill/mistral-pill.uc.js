// ==UserScript==
// @name           Mistral Pill
// @description    Adds a Mistral pill to the search bar when Mistral is used as Search engine
// @author         Bxth
// @version        1.0
// @namespace      https://github.com/zen-browser/desktop
// ==/UserScript==

/**
 * Highlights the Firefox urlbar search mode indicator when it shows
 * "Mistral AI" so it is easier to distinguish.
 */
(function () {
  const TARGET_ID = "urlbar-search-mode-indicator-title";
  const CONTAINER_ID = "urlbar-search-mode-indicator";
  const HIGHLIGHT_COLOR = "rgb(250, 80, 15)";
  const CHECK_INTERVAL_MS = 300;

  let observer;

  function getNodes() {
    const titleNode = document.getElementById(TARGET_ID);
    const containerNode = document.getElementById(CONTAINER_ID);
    if (!titleNode || !containerNode) {
      return null;
    }
    return { titleNode, containerNode };
  }

  function applyColor({ titleNode, containerNode }) {
    if (titleNode.textContent?.includes("Mistral AI")) {
      containerNode.style.setProperty(
        "background-color",
        HIGHLIGHT_COLOR,
        "important"
      );
      containerNode.style.setProperty(
        "box-shadow",
        `0 0 6px 1px ${HIGHLIGHT_COLOR}`,
        "important"
      );
    } else {
      containerNode.style.removeProperty("background-color");
      containerNode.style.removeProperty("box-shadow");
    }
  }

  function observeIndicator(nodes) {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(() => applyColor(nodes));
    observer.observe(nodes.titleNode, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    applyColor(nodes);
  }

  function init() {
    const nodes = getNodes();
    if (!nodes) {
      window.setTimeout(init, CHECK_INTERVAL_MS);
      return;
    }
    observeIndicator(nodes);
  }

  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init, { once: true });
  }
})();

