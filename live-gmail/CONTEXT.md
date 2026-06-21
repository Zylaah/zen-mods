# Live Gmail Panel — LLM Context Document

> **Purpose:** Hand this file to a fresh LLM conversation when working on this mod. It describes what the mod does, how it is built, and how it integrates with Zen Browser / Firefox internals.
>
> **Current version:** `3.0.2` (see `theme.json` and `@version` in `live-gmail.uc.js`)
>
> **Last updated:** 2026-06-20

---

## What this mod does

**Live Gmail Panel** is a **Zen Browser mod** (loaded via **Sine**) that shows a floating preview of **unread Gmail** when the user hovers a **Gmail essential tab**.

User-facing behavior:

1. User pins Gmail as a **Zen essential** tab (`zen-essential` attribute).
2. Hovering that tab opens a native-style **XUL popup panel** beside the tab.
3. The panel lists unread emails (sender, subject, snippet, date).
4. Clicking an email selects the Gmail tab and opens that thread.
5. A floating **+** button opens Gmail compose.
6. If the Gmail essential is **unloaded/discarded**, the mod **briefly loads it in the background**, scans the inbox DOM, then **unloads it again** (transient scan).
7. Cached results persist across browser restarts via a profile JSON file.

**Important:** This mod does **not** use the Gmail API. It **scrapes the Gmail inbox DOM** inside a real Gmail tab via an injected frame script.

---

## Repository layout

```
live-gmail/
├── live-gmail.uc.js   # Main mod logic (~2000 lines) — runs in browser chrome
├── chrome.css         # Panel styling (native Zen look, compose button)
├── theme.json         # Sine manifest (version, include paths, metadata)
├── README.md          # User-facing install/usage docs
└── CONTEXT.md         # This file
```

Parent repo: `zen-mods` on GitHub. Git root is the parent `zen-mods/` folder, not `live-gmail/` alone.

---

## How the mod is loaded

### Sine + userChrome script

`theme.json` registers the mod with Sine:

```json
{
  "scripts": {
    "live-gmail.uc.js": {
      "include": ["chrome://browser/content/browser.xhtml"]
    }
  },
  "style": { "chrome": "chrome.css" }
}
```

The script is a **userChrome `.uc.js` file** injected into the main browser window. It runs in **privileged chrome context** with access to:

- `gBrowser`, `Services`, `Ci`, `Cu`, `IOUtils`, `PathUtils`
- XUL/HTML DOM for creating the panel
- `browser.messageManager` for talking to content processes

It is **not** a WebExtension. There is no `manifest.json`, no `browser.*` polyfill, no WXT build.

### Initialization

On `DOMContentLoaded` (or immediately if document is complete):

```js
UC_LIVE_GMAIL.init()
  → loadCacheFromPrefs()
  → cleanupScannerTabs()          // remove legacy scanner tabs
  → createPanel()                 // XUL <panel> element
  → setupTabMonitoring()          // hover listeners, tab observers
  → initDomMode()                 // message listeners + background scan timer
  → updatePanelContent()
```

If `gBrowser` is not ready yet, init retries every 200ms.

---

## Architecture overview

Two layers communicate via **frame script messages**:

```
┌─────────────────────────────────────────────────────────────┐
│  CHROME LAYER (live-gmail.uc.js in browser.xhtml)           │
│                                                             │
│  • Hover detection on essential tabs                        │
│  • XUL popup panel UI                                       │
│  • Tab load/unload orchestration                            │
│  • Cache read/write (live-gmail-cache.json)                 │
│  • Background periodic scan timer                           │
└──────────────────────┬──────────────────────────────────────┘
                       │ messageManager
                       │  LiveGmail:RequestScan  (chrome → content)
                       │  LiveGmail:UnreadData    (content → chrome)
                       │  LiveGmail:OpenThread    (chrome → content)
                       │  LiveGmail:SetDebug      (chrome → content)
┌──────────────────────▼──────────────────────────────────────┐
│  FRAME SCRIPT (GMAIL_FRAME_SCRIPT string, injected as       │
│  data: URL via loadFrameScript)                             │
│                                                             │
│  Runs inside each Gmail tab's content process               │
│  • Parses inbox DOM (table rows, Gmail CSS classes)         │
│  • MutationObserver for live updates                        │
│  • Sends thread list back to chrome                         │
└─────────────────────────────────────────────────────────────┘
```

### Why a frame script?

Gmail is cross-origin. Chrome cannot read `browser.contentDocument` reliably for scanning. The frame script runs **in the Gmail content process** and has full DOM access.

The frame script is embedded as a large template string (`GMAIL_FRAME_SCRIPT`) and loaded once per browser via:

```js
browser.messageManager.loadFrameScript(cachedFrameScriptUrl, true);
```

---

## Core user flow: hover → scan → display → unload

### 1. Hover opens panel

- `handleTabHover` / `setupEssentialsHoverDelegation` → `showPanel(tab)`
- Panel opens with `panelElement.openPopup(tab, 'end_before', ...)`
- Shows **cached emails immediately** if available (`cachedEmails` / `currentEmails`)
- After **80ms delay**, calls `requestScanFromGmailTabs(true, isEssentialHover)`

The 80ms delay prevents tab manipulation from dismissing a just-opened popup.

### 2. Scan request

```js
requestScanFromGmailTabs(force, allowCreate)
  → if allowCreate: wakeGmailForScan()
  → else: scanLoadedGmailTabs()   // background timer path
```

Throttled to once per 4 seconds unless `force=true`.

### 3. Wake unloaded Gmail (`wakeGmailForScan`)

If Gmail essential is not already loaded:

1. Set `transientScanTab`, `shouldUnloadAfterScan = true`
2. Start 45s watchdog (`startTransientScanWatchdog`)
3. If browser is not already loading → `loadGmailInTab(essential)`
4. `scheduleScanWhenTabReady(essential)` — waits for `load` event + 1500ms, then `scanBrowser`

If Gmail is already loaded → `scanLoadedGmailTabs()` only, no unload afterward.

### 4. Load Gmail silently (`loadGmailInTab`)

```js
browser.fixupAndLoadURIString(inboxUrl, {
  triggeringPrincipal: systemPrincipal,
  loadFlags: LOAD_FLAGS_BACKGROUND_LOAD
});
restoreTabSelection(previousTab);  // don't leave user on Gmail tab
```

Uses `LOAD_FLAGS_BACKGROUND_LOAD` so navigation doesn't steal focus.

### 5. Scan browser (`scanBrowser`)

```js
loadFrameScript(browser);
browser.messageManager.sendAsyncMessage('LiveGmail:RequestScan', {});
```

Frame script runs `scanInbox()`, sends `LiveGmail:UnreadData` with threads + meta.

### 6. Handle scan results (`handleFrameScriptData`)

- **Premature scan** (`rows=0` and not `inboxReady`): retry after 1500ms
- **Authoritative scan**: update `currentEmails`, `cachedEmails`, `saveCacheToPrefs()`
- If transient scan → `maybeUnloadTransientScanTab()` after 100ms

### 7. Unload after transient scan (`unloadGmailEssentialTab`)

Uses Zen/Firefox API:

```js
await gBrowser.explicitUnloadTabs([tab]);
```

Skipped if tab is selected or user opened Gmail (compose click, email click call `cancelTransientScanUnload()`).

### 8. Panel hide

- `scheduleHide()` — 200ms delay (350ms while `scanInProgress`)
- Hides only when cursor left **both** tab and panel
- During scan, re-shows panel if hover was briefly lost due to tab reload

---

## Zen Browser integration

### Essential tabs

Gmail must be a **Zen essential** tab:

- DOM attribute: `zen-essential="true"`
- Detected via `isGmailEssentialTab(tab)` which also checks URL pattern and active workspace container

Creating essentials uses Zen API when available:

```js
window.gZenPinnedTabManager.addToEssentials(tab);
```

### Workspaces & containers

If `gZenWorkspaces.containerSpecificEssentials` is enabled, only essentials in the **active workspace container** (`usercontextid`) are tracked.

Relevant globals:

- `window.gZenWorkspaces.getActiveWorkspaceFromCache()`
- `activeWorkspace.containerTabId`

### Tab states (critical for loading)

Zen/Firefox essential tabs can be in several states:

| State | Indicators | Meaning |
|-------|------------|---------|
| **Loaded** | has `linkedPanel`, real browser | Can scan immediately |
| **Pending (lazy)** | `pending` attribute, often no `linkedPanel` | Session restore stub; browser not materialized |
| **Discarded** | `discarded` attribute | Explicitly unloaded via `explicitUnloadTabs` |

**Lazy browser quirk:** On a pending tab, `browser.currentURI.spec` may already show the Gmail URL from SessionStore metadata — but there is **no live document**. The mod's `isLoadedGmailBrowser()` only checks URI, which can falsely report "loaded".

**Pending tab quirk:** `fixupAndLoadURIString` on a lazy/pending essential often does **nothing**. Firefox's intended wake path is `gBrowser._insertBrowser(tab)`, which materializes the browser and triggers SessionStore restore. Listen for `SSTabRestored` on the tab element.

**Zen blocks auto-select of pending pinned tabs** via `ZenSpaceManager._shouldChangeToTab()` — so flash-selecting a pending essential may not trigger restore.

These are the main reasons hover-scan on a **cold-start unloaded essential** is fragile in the current codebase.

### Unload API

```js
gBrowser.explicitUnloadTabs([tab])  // Zen/Firefox — makes tab pending/lazy again
```

Essentials are excluded from workspace bulk-unload in Zen, but explicit unload still works for hover-triggered transient scans.

### UI integration

- Panel is a XUL `<panel type="arrow" nonnativepopover="true">` appended to `document.documentElement`
- Styled via `chrome.css` to match Zen native popovers (mica/transparency, `light-dark()`)
- Theme sync reads `zen-should-be-dark-mode`, `zen.view.window.scheme` pref

---

## Gmail detection (unloaded tabs)

`tabMatchesGmailPattern(tab)` collects hints from:

- Tab attributes: `data-url`, `pending`, `zen-origin-url`, `data-original-url`
- `linkedBrowser.currentURI.spec` (may be stale/lazy)
- Favicon URL (`image` attribute)
- Tab label (e.g. "Inbox (5) - user@gmail.com - Gmail")

Default URL pattern: `mail.google.com` (configurable via pref).

---

## Frame script: DOM scraping details

Runs only on `mail.google.com` pages.

### Finding rows

Tries selectors in order: `tr.zA`, `div[role="main"] tr`, `table.F tbody tr`, etc. Caches working selector.

### Unread detection (`isUnread`)

- Gmail classes: `zE` = unread, `yO` = read
- `data-is-read="false"`
- Bold elements, aria-label heuristics
- Does **not** use `getComputedStyle` (performance)

### Scan output

```js
{
  threads: [{ id, threadId, from, subject, snippet, date, isUnread, url, rowIndex }],
  meta: { rows, unread, inboxReady }
}
```

`inboxReady` = has rows OR main area exists without progress spinner.

### Observer

`MutationObserver` on inbox main area, debounced 500ms. Filters attribute mutations to row-level elements only (`TR`, `role=row`, `.zA`).

### Messages

| Message | Direction | Purpose |
|---------|-----------|---------|
| `LiveGmail:RequestScan` | chrome → content | Immediate scan |
| `LiveGmail:UnreadData` | content → chrome | Scan results |
| `LiveGmail:OpenThread` | chrome → content | Click row by index or navigate |
| `LiveGmail:CheckReady` | chrome → content | Readiness probe |
| `LiveGmail:SetDebug` | chrome → content | Enable frame logging |

Chrome listens globally:

```js
Services.mm.addMessageListener('LiveGmail:UnreadData', ...)
```

---

## State variables (chrome layer)

| Variable | Role |
|----------|------|
| `currentEmails` | Live list shown in panel |
| `cachedEmails` | Last authoritative scan; shown when tab unloaded |
| `hoveredTab` | Tab currently hovered |
| `panelElement` | XUL panel DOM node |
| `scanInProgress` | True while waiting for scan result |
| `transientScanTab` | Essential tab loaded by mod for hover scan |
| `shouldUnloadAfterScan` | If true, unload `transientScanTab` after scan |
| `clickedEmailIds` | Hide emails user clicked (until Gmail marks read) |
| `lastPanelHoverTs` | Used to slow background scans when panel unused |
| `cachedFrameScriptUrl` | Cached data: URL for frame script injection |

---

## Cache persistence

**File:** `<profile>/live-gmail-cache.json`

Written on every authoritative scan via `IOUtils.writeUTF8`. Loaded async on init.

Not stored in SessionStore or `browser.storage` — plain profile file.

---

## Background scanning

Timer interval from pref `live-gmail.scan-interval-sec` (default **90** seconds).

- Only calls `scanLoadedGmailTabs()` — **never wakes discarded tabs**
- If panel unused 10+ minutes, runs at 1/3 frequency (skips 2 of 3 ticks)

---

## Preferences (`about:config`)

| Pref | Default | Description |
|------|---------|-------------|
| `live-gmail.url` | `mail.google.com` | Gmail domain to match |
| `live-gmail.background-scan` | `true` | Periodic refresh on loaded tabs |
| `live-gmail.scan-interval-sec` | `90` | Background interval (`0` = off) |
| `live-gmail.debug` | `false` | Console logging |

---

## Debugging

Enable: `live-gmail.debug` = `true` in `about:config`.

Browser console shows `[Live Gmail]` logs.

Debug API on `window.liveGmailDebug`:

```js
liveGmailDebug.scan()      // force hover-style scan
liveGmailDebug.wake()      // wakeGmailForScan directly
liveGmailDebug.showPanel() // open panel manually
liveGmailDebug.hidePanel()
liveGmailDebug.emails()    // current email array
liveGmailDebug.reInit()    // re-run init
```

Frame script logs as `[Live Gmail Frame]` when debug is enabled.

---

## Key functions reference

| Function | Role |
|----------|------|
| `showPanel` / `hidePanel` / `scheduleHide` | Panel visibility + hide delay |
| `wakeGmailForScan` | Hover path: load if needed, scan, mark for unload |
| `loadGmailInTab` | Background navigation to inbox URL |
| `scheduleScanWhenTabReady` | Wait for load event, then scan |
| `scanBrowser` | Inject frame script + send RequestScan |
| `scanLoadedGmailTabs` | Scan already-loaded essential or any Gmail tab |
| `handleFrameScriptData` | Process scan results, cache, trigger unload |
| `unloadGmailEssentialTab` | `explicitUnloadTabs` wrapper |
| `updateEmailDisplay` | Render panel content from emails / loading state |
| `isGmailEssentialTab` | Essential + container + URL match |
| `findGmailEssentialTab` | Prefer loaded, else any matching essential |
| `resolveGmailTargetTab` | For compose/click: find or create essential |

---

## Panel UI states (`updateEmailDisplay`)

1. **Scanning, no cache** → "Loading unread emails..."
2. **Has emails** → list + compose button visible
3. **No emails** → "No unread emails"
4. **Has cache while scanning** → show cache (no loading spinner)

Compose button uses frosted-glass circular styling in `chrome.css`.

---

## What this mod does NOT do

- No Gmail OAuth / Google API
- No WebExtension background scripts
- No content scripts via manifest — only frame script injection
- No modification of Gmail page UI (only reads DOM)
- No cross-profile sync

---

## Known limitations & fragile areas

These are important when modifying the mod:

1. **Pending/lazy essential on startup** — `loadGmailInTab` + `fixupAndLoadURIString` may not wake the tab; scan times out, panel stays empty until user manually opens Gmail once.

2. **`isLoadedGmailBrowser` false positive** — URI-only check passes on lazy tabs with cached SessionStore URL.

3. **Premature scans** — Frame script may respond before inbox rows exist; mod retries but can loop if tab never actually loads.

4. **Hover re-entry** — Repeated `mouseenter` on same hover session can re-trigger `requestScanFromGmailTabs(true, true)` unless guarded (current code has limited session guards).

5. **Gmail DOM changes** — Selectors (`tr.zA`, etc.) break if Google redesigns inbox HTML.

6. **Scanner tabs** — Older mod versions created hidden scanner tabs (`data-live-gmail-scanner`); `cleanupScannerTabs()` removes them on init.

---

## Useful Firefox/Zen APIs for future work

When fixing pending-tab loading, these are the relevant internal APIs (see Zen/Firefox source):

```js
// Materialize lazy browser + start session restore
gBrowser._insertBrowser(tab);

// Tab lifecycle events (on tab element, not browser)
tab.addEventListener('SSTabRestoring', ...);
tab.addEventListener('SSTabRestored', ...);

// Unload
await gBrowser.explicitUnloadTabs([tab]);

// Lazy tab detection
tab.hasAttribute('pending');
!tab.linkedPanel;

// SessionStore (advanced)
SessionStore.getLazyTabValue(tab, 'url');
SessionStore.setTabState(tab, state);
```

Reference files (outside this repo, on maintainer's machine):

- `tabbrowserjs.txt` — `_insertBrowser`, lazy browser stubs, `_browserBindingProperties`
- `ZenSpaceManager.mjs` — workspace essentials, `_shouldChangeToTab`
- `ZenPinnedTabManager.mjs` — essentials management, `explicitUnloadTabs` usage

---

## Development notes

- **Target:** Firefox-based **Zen Browser only** (not Chrome WebExtension).
- **Mod manager:** [Sine](https://github.com/CosmoCreeper/Sine) for Zen.
- **Testing:** Load mod in Sine, restart Zen, hover Gmail essential, watch Browser Console with debug on.
- **Profile cache:** Delete `live-gmail-cache.json` in profile to reset cached emails.
- **Version bumps:** Update both `theme.json` `"version"` and `@version` in `live-gmail.uc.js`.

---

## Suggested reading order for a new LLM session

1. This file (overview + integration)
2. `README.md` (user prefs and install)
3. `live-gmail.uc.js` sections in order:
   - CONFIG + state (lines ~15–70)
   - Tab load/unload: `wakeGmailForScan`, `loadGmailInTab`, `unloadGmailEssentialTab` (~327–445)
   - Frame script string `GMAIL_FRAME_SCRIPT` (~610–1010)
   - Panel + hover: `showPanel`, `updateEmailDisplay` (~1530–1920)
   - Init (~1990–2035)
4. `chrome.css` for UI changes
