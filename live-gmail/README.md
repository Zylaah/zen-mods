<h1 align="center">Live Gmail Panel</h1>
<div align="center">
    <a href="https://zen-browser.app/">
        <img width="240" alt="zen-badge-dark" src="https://raw.githubusercontent.com/heyitszenithyt/zen-browser-badges/fb14dcd72694b7176d141c774629df76af87514e/light/zen-badge-light.png" />
    </a>
</div>

A Zen Browser mod for Sine that shows your unread Gmail in a quick hover panel on your Gmail essential or pinned tab.

## Features

- Hover your Gmail essential or pinned tab to open an unread mail panel
- See sender, subject, snippet, and date at a glance
- Click an item to open the conversation in Gmail
- Floating **+** button to start a new message in Gmail
- Native Zen-style popup look with transparent/mica panel behavior

## Installation (Sine)

1. Install [Sine](https://github.com/CosmoCreeper/Sine) on Zen Browser.
2. In Sine, enable unsafe JS and paste `Zylaah/zen-mods/tree/main/live-gmail`.
3. Restart Zen when prompted.

## Usage

1. Pin Gmail as an **essential** or **pinned** tab.
2. Hover that tab.
3. Read unread previews in the panel.
4. Click an email to open it in Gmail.

## Preferences (`about:config`)

| Preference | Default | Description |
| ---------- | ------- | ----------- |
| `live-gmail.url` | `mail.google.com` | Gmail domain to detect |
| `live-gmail.debug` | `false` | Enable debug logs in Browser Console |

## Notes

- Works best with a signed-in Gmail session in the same profile. Each Firefox container has its own cookies, so a Gmail pin in Work and one in Personal show that container's inbox.
- Unread mail comes from Gmail's Atom feed (`/mail/u/N/feed/atom`) using that tab's container cookies. The inbox page is only watched to refresh after you mark mail read.
- Clicking an item opens Gmail's permalink for that conversation.
