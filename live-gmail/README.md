<h1 align="center">Live Gmail Panel</h1>
<div align="center">
    <a href="https://zen-browser.app/">
        <img width="240" alt="zen-badge-dark" src="https://raw.githubusercontent.com/heyitszenithyt/zen-browser-badges/fb14dcd72694b7176d141c774629df76af87514e/light/zen-badge-light.png" />
    </a>
</div>

A Zen Browser mod for Sine that shows your unread Gmail in a quick hover panel on your Gmail essential tab.

## Features

- Hover your Gmail essential tab to open an unread mail panel
- See sender, subject, snippet, and date at a glance
- Click an item to open the conversation in Gmail
- Floating **+** button to start a new message in Gmail
- Keeps working even when the Gmail tab was unloaded (loads briefly to refresh, then unloads again)
- Native Zen-style popup look with transparent/mica panel behavior

## Installation (Sine)

1. Install [Sine](https://github.com/CosmoCreeper/Sine) on Zen Browser.
2. In Sine, add this mod (`live-gmail`) from your local mods folder/repository.
3. Restart Zen when prompted.

## Usage

1. Pin Gmail as an **essential** tab.
2. Hover the Gmail essential tab.
3. Read unread previews in the panel.
4. Click an email to open it in Gmail.

## Preferences (`about:config`)

| Preference | Default | Description |
| ---------- | ------- | ----------- |
| `live-gmail.url` | `mail.google.com` | Gmail domain to detect |
| `live-gmail.background-scan` | `true` | Enable periodic refresh when Gmail is already loaded |
| `live-gmail.scan-interval-sec` | `90` | Refresh interval in seconds (`0` disables it) |
| `live-gmail.debug` | `false` | Enable debug logs in Browser Console |

## Notes

- Works best with a signed-in Gmail session in the same profile/container.
- This mod reads Gmail inbox content shown in your browser to build previews.
