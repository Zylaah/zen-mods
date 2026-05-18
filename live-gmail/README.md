# Live Gmail Panel

A Zen Browser mod (Sine / `.uc.js`) that shows unread Gmail in a floating panel when you hover a Gmail **essential** tab.

## How it stays up to date (B + D)

| Mode | What happens |
|------|----------------|
| **B — Background scanner** | If no Gmail tab is loaded, the mod keeps a hidden `data-live-gmail-scanner` tab on inbox and rescans on a timer (default every 90s). |
| **D — Wake on hover** | Hovering the Gmail essential always triggers a fresh scan: uses an open Gmail tab if one exists, otherwise wakes the scanner tab. |

The **essential** can stay closed/unloaded; scraping runs in the scanner (or any loaded Gmail tab). Clicking a message still opens the **essential** tab, not the scanner.

## Install

Install the `live-gmail` folder with **Sine** (needs `theme.json` + `live-gmail.uc.js` + `chrome.css`).

## Preferences (`about:config`)

| Preference | Default | Description |
|------------|---------|-------------|
| `live-gmail.url` | `mail.google.com` | Host fragment to match Gmail tabs |
| `live-gmail.background-scan` | `true` | **B** — periodic background rescans |
| `live-gmail.scan-interval-sec` | `90` | **B** — seconds between periodic scans (`0` = off) |
| `live-gmail.debug` | `false` | Verbose logging in Browser Console |

**D** (wake on hover) is always on; it does not use a separate pref.

## Debug (`Browser Console`)

```js
liveGmailDebug.wake()  // wake scanner / scan now
liveGmailDebug.scan()
liveGmailDebug.emails()
```

## License

Provided as-is for use with Zen Browser.
