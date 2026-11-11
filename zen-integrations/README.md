# Zen Integrations

A Zen Browser mod for Sine. Hover an essential or pinned Gmail or Outlook tab to see unread mail.

## Features

- Unread list for Gmail and Outlook in one panel
- Sender, subject, snippet, and date
- Click an item to open it in that tab
- Floating **+** button to start a new message
- Each Firefox container keeps its own mailbox

Gmail reads the Atom feed with that tab's cookies. Outlook reads Outlook on the web's own JSON. There is no OAuth and no Microsoft Graph.

Modern Outlook (`outlook.live.com` and the Microsoft 365 web app) no longer accepts a cookie-only request: it signs each call with a short-lived token the page holds. This mod does not mint that token. It watches the requests your loaded Outlook tab already makes and reuses their `Authorization` header and `X-OWA-CANARY`, scoped to that tab's Firefox container. So Outlook needs the tab loaded once per session, and the panel keeps working after the tab unloads until the token expires (about an hour), when you open Outlook again.

## Installation (Sine)

1. Remove the old **Live Gmail** mod if it is installed. Both mods register the same Gmail actor. Leave the old one enabled and this panel will not see read-state updates.
2. Install [Sine](https://github.com/CosmoCreeper/Sine) on Zen Browser.
3. In Sine, enable unsafe JS and paste `Zylaah/zen-mods/tree/main/zen-integrations`.
4. Restart Zen when prompted.

## Usage

1. Pin Gmail (`mail.google.com`) or Outlook (`outlook.office.com`, `outlook.office365.com`, `outlook.live.com`, or `outlook.cloud.microsoft`) as an essential or pinned tab.
2. Sign in once in that tab so the container has a session. For Outlook, let the mailbox finish loading once so the mod can capture its token.
3. Hover the tab.
4. Click a row to open it. **+** opens compose.

Work and personal Outlook are different hosts, so both can be pinned in the same container. They do not share a list.

## Preferences

| Preference | Default | Description |
| ---------- | ------- | ----------- |
| `zen-integrations.gmail.url` | `mail.google.com` | Gmail domain to detect. `live-gmail.url` is still read if the new pref is unset. |
| `zen-integrations.debug` | `false` | Log to the Browser Console. `live-gmail.debug` is still read if the new pref is unset. |

## Notes

- The list is the unread inbox. Outlook's Focused and Other views are both included.
- Opening a Gmail row selects the Gmail tab, waits until the inbox is ready, then opens that thread.
- Opening an Outlook row loads Outlook's read deeplink for that conversation.
- Cached rows are stored in `zen-integrations-cache.json` in the profile. An old `live-gmail-cache.json` is read once and treated as Gmail.
