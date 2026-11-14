# Zen Integrations — LLM Context

> Version `1.3.0` (`theme.json` and `@version` in `zen-integrations.uc.js`).
> One Sine mod. Gmail and Outlook unread panels, plus a Google Calendar day view. Gmail has no OAuth. Outlook Graph uses this mod's own Microsoft app id. Calendar uses this install's own Google desktop client.

## What it does

Hover an essential or pinned Gmail or Outlook tab. A XUL panel lists unread mail for that tab's Firefox container. Click opens the message in that tab. **+** opens compose. Hover a Google Calendar pin for today's events and the join pill.

Gmail source: `https://mail.google.com/mail/u/N/feed/atom` with that container's cookies. XML is parsed in chrome. Do not navigate a tab to `/feed/atom` (HTTP Basic auth).

Outlook source: Microsoft Graph when `zen-integrations.outlook.clientId` is this install's own app id. The scope is `Mail.Read` plus `offline_access`. Sign-in is an auth-code tab with PKCE. The redirect is `https://login.microsoftonline.com/common/oauth2/nativeclient`. Tokens sit in `<profile>/zen-integrations-outlook-tokens.json`, one entry per context key. Unread mail is `GET /v1.0/me/mailFolders/Inbox/messages` twice: `isRead eq false and inferenceClassification eq 'focused'`, and the same filter with `'other'`. One `isRead eq false` page omits the Focused tab. A click loads the message `webLink`. Arc's client id `74d1363b-cbb0-4149-9619-f1594fefa6f4` is refused. With no client id, the `ZenOutlook` actor still reads the loaded tab's message list, and a click still selects that conversation. An unloaded tab keeps the saved rows.

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
├── providers/OutlookGraph.sys.mjs
├── providers/OutlookAuth.sys.mjs
├── calendar/                  # day view, pill, Google sign-in
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

Clicking Gmail does not only load the permalink. `Tabs.sys.mjs` waits for the inbox actor (`LiveGmail:InboxReady`), then `LiveGmail:OpenThread`. The frame script `GmailFrame.js` reports rows the user opened so they drop off the list. An Outlook Graph row loads its `webLink`. A scraped row still asks the `ZenOutlook` actor to click that conversation.

## Prefs

- `zen-integrations.debug`
- `zen-integrations.gmail.url` (falls back to `live-gmail.url`)
- `zen-integrations.outlook.clientId` (empty keeps the tab scrape)

Poll interval is `CONFIG.POLL_MS` (60 seconds), not a pref.

## Calendar

The day view is not a mailbox provider. `App.sys.mjs` owns a `LiveCalendar` next to the mail panel. Hovering a Calendar pin opens `#live-calendar-panel`. Hovering a mail pin still opens `#zi-panel`. Modules live in `calendar/`. The join pill is `data-zi-calendar` plus `.live-calendar-pill`.

Google prefs stay `live-calendar.google.clientId` and `live-calendar.google.clientSecret`. Tokens stay in `<profile>/live-calendar-google-tokens.json`. The day cache stays `<profile>/live-calendar-cache.json`. Arc's Google client id is refused. Disable the separate Live Calendar mod so the tab strip does not get a second hover listener.

Account state is `<profile>/zen-integrations-accounts.json`. `preferences.json` is what puts the settings button on the mod card. That button, and the command palette entry **Zen Integrations accounts**, open the same page. Connect and disconnect happen there. A disabled account does not open a panel, does not fetch, and does not read cookies. An expired Outlook or calendar token keeps the account enabled and the panel shows Reconnect. Gmail stays on Atom. A signed-out Gmail container shows Open Gmail, which focuses that tab.
