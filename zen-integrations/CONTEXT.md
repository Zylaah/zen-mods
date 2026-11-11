# Zen Integrations — LLM Context

> Version `1.0.0` (`theme.json` and `@version` in `zen-integrations.uc.js`).
> One Sine mod. Gmail and Outlook unread panels. No OAuth. No Microsoft Graph.

## What it does

Hover an essential or pinned Gmail or Outlook tab. A XUL panel lists unread mail for that tab's Firefox container. Click opens the message in that tab. **+** opens compose.

Gmail source: `https://mail.google.com/mail/u/N/feed/atom` with that container's cookies. XML is parsed in chrome. Do not navigate a tab to `/feed/atom` (HTTP Basic auth).

Outlook source: the loaded tab's message list, read by the `ZenOutlook` actor. Unread rows are the list options marked unread. If the tab is unloaded, or the list is not in the page yet, the scan leaves the saved rows in place. Clicking a row selects that tab and clicks the matching conversation. No OWA JSON, no bearer token, no Graph.

## Layout

```
zen-integrations/
├── zen-integrations.uc.js     # bootstrap, registers the Gmail actor
├── App.sys.mjs                # per-window state, provider list
├── Util.sys.mjs               # prefs, cookies, HTTP
├── Scan.sys.mjs               # poll, cache, apply
├── Cache.sys.mjs              # profile JSON
├── Panel.sys.mjs              # XUL popup
├── Tabs.sys.mjs               # pin match, hover, Gmail open-thread
├── providers/Gmail.sys.mjs
├── providers/Outlook.sys.mjs
├── GmailFrame.js              # inbox read-state in the Gmail tab
├── actors/LiveGmailParent.sys.mjs
├── actors/LiveGmailChild.sys.mjs
├── chrome.css
└── theme.json
```

Modules load from `chrome://sine/content/zen-integrations/…`. Sine maps the mod id. Bootstrap adds `?v=Date.now()` so a reload does not keep a stale module. Actor registration is process-wide. A second window hits `NotSupportedError` and reuses the actor.

The actor name stays `LiveGmail`. The child class must stay `LiveGmailChild`. It only matches `mail.google.com`. The parent calls `window.zenIntegrations`. Do not leave the old Live Gmail mod enabled: it registers the same actor and points it at `window.liveGmail`.

## Adding a mailbox

Add a provider object with `id`, `label`, `signInMessage`, `matches`, `contextKey`, `cacheToken`, `homeUrl`, `composeUrl`, and `fetchUnread`. Put it in the `providers` array in `App.sys.mjs`. Add the id to `PROVIDER_IDS` in `Util.sys.mjs` so cache keys are not rewritten as Gmail. No other registry.

`fetchUnread(app, tab, hints)` returns the same row shape Gmail uses: `id`, `threadId`, `from`, `subject`, `snippet`, `date`, `ts`, `isUnread`, `url`. Throw an error with `signin: true` when the container has no session.

Context keys are `gmail:<container>` and `outlook:<family>:<container>`. Family is `office`, `office365`, `live`, or `cloud`, because those hosts are different accounts. Cache file: `<profile>/zen-integrations-cache.json`. On first run, `live-gmail-cache.json` is read and its keys become `gmail:<container>`.

## Gmail open path

Clicking Gmail does not only load the permalink. `Tabs.sys.mjs` waits for the inbox actor (`LiveGmail:InboxReady`), then `LiveGmail:OpenThread`. The frame script `GmailFrame.js` reports rows the user opened so they drop off the list. Outlook clicks load `email.url` (`/mail/deeplink/read/<id>`).

## Prefs

- `zen-integrations.debug`
- `zen-integrations.gmail.url` (falls back to `live-gmail.url`)

Poll interval is `CONFIG.POLL_MS` (60 seconds), not a pref.
