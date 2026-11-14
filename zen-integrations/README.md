# Zen Integrations

A Zen Browser mod for Sine. Hover an essential or pinned Gmail or Outlook tab to see unread mail. Hover a Google Calendar pin to see today.

## Features

- Unread list for Gmail and Outlook in one panel
- Sender, subject, snippet, and date
- Click an item to open it in that tab
- Floating **+** button to start a new message
- Each Firefox container keeps its own mailbox, so one container per account
- Provider sections in settings show the connected account count and per-account actions
- Today's Google Calendar, with a join pill when a meeting is close

Gmail reads the Atom feed with that tab's cookies. Outlook reads Microsoft Graph when `zen-integrations.outlook.clientId` is set to your own app id. Until then, Outlook reads the message list in the loaded tab, and an unloaded pin shows the last saved list.

## Installation (Sine)

1. Remove the old **Live Gmail** mod if it is installed. Both mods register the same Gmail actor. Leave the old one enabled and this panel will not see read-state updates. Also disable the separate **Live Calendar** mod. Calendar now lives in this mod, and leaving both enabled puts two hover listeners on the tab strip.
2. Install [Sine](https://github.com/CosmoCreeper/Sine) on Zen Browser.
3. In Sine, enable unsafe JS and paste `Zylaah/zen-mods/tree/main/zen-integrations`.
4. Restart Zen when prompted.

## Usage

1. Pin Gmail (`mail.google.com`) or Outlook (`outlook.office.com`, `outlook.office365.com`, `outlook.live.com`, or `outlook.cloud.microsoft`) as an essential or pinned tab.
2. Sign in once in that tab so Gmail or Outlook has its own session. For Graph, register a public Microsoft app with redirect `https://login.microsoftonline.com/common/oauth2/nativeclient` and delegated `Mail.Read`, then set `zen-integrations.outlook.clientId` to that app id and use **Connect**. Without that pref, Outlook has to be loaded for a new unread list.
3. Hover the tab.
4. Click a row to open it. **+** opens compose.
5. Open the settings button on the Zen Integrations card in Sine, or run **Zen Integrations accounts** from the command palette. Each provider section shows how many accounts are connected, an **Add account** button, and a **…** menu for that provider's app credentials.
6. **Add account** picks a Firefox container. **Connect** on Google starts the Calendar sign-in and enables Gmail for that same container. **Connect** on Outlook starts the mail sign-in. The **…** on an account row renames or removes that account. **Disconnect** hides that account's panels, stops fetching, and deletes its token.
7. A pinned Gmail, Outlook, or Calendar tab that has no account yet appears as a dashed **Detected** row. Connect it to adopt that container; a pinned tab alone never enables an account.

One account per provider per Firefox container. Gmail and Google Calendar share that container's Google account. Outlook's `live`, `office`, `office365`, and `cloud` hosts also share one account per container, so a host change does not create a second account or lose its token.

## Preferences

| Preference | Default | Description |
| ---------- | ------- | ----------- |
| `zen-integrations.gmail.url` | `mail.google.com` | Gmail domain to detect. `live-gmail.url` is still read if the new pref is unset. |
| `zen-integrations.debug` | `false` | Log to the Browser Console. `live-gmail.debug` is still read if the new pref is unset. |
| `zen-integrations.outlook.clientId` | empty | Your Microsoft app id. Empty keeps the Outlook tab scrape. |
| `live-calendar.google.clientId` | empty | Your Google Desktop client id for the day view. |
| `live-calendar.google.clientSecret` | empty | The secret for that Desktop client. |

## Notes

- The list is the unread inbox. Outlook's Focused and Other views are both included.
- Opening a Gmail row selects the Gmail tab, waits until the inbox is ready, then opens that thread.
- Opening an Outlook Graph row loads that message's web link. A scraped row still clicks the matching conversation.
- Cached rows are stored in `zen-integrations-cache.json` in the profile. An old `live-gmail-cache.json` is read once and treated as Gmail.
- Account records live in `zen-integrations-accounts.json`. Google tokens stay in `live-calendar-google-tokens.json`, and Outlook tokens stay in `zen-integrations-outlook-tokens.json`. Old container-only keys are migrated to account ids on first load.
- Removing an account deletes its record and token. Disconnecting keeps the record, label, and email so the account can reconnect later.
