# Better Media Toolbar

Enhances Zen’s sidebar media controls with a hover volume slider and an artwork background on the media toolbar.

## Features

- **Volume slider** — hover the mute button to reveal a horizontal volume slider (0–100%)
- **Artwork background** — hover the media toolbar to show the current track’s album art as a background
- Artwork is hidden while hovering the mute button (so the volume slider stays readable)
- At 0%, mutes the tab (same as the mute button)
- Above 0%, unmutes if needed and sets media element volume in the playing tab
- Hidden during WebRTC / screenshare mode (`[media-sharing]`)
- Styled to match Zen’s existing media progress bar

## Requirements

- [Zen Browser](https://zen-browser.app/)
- [Sine](https://github.com/CosmoCreeper/Sine) mod loader
- **Enable installing JS from unofficial sources** in Sine settings (this mod uses a content frame script for volume)

## Installation

1. Open `about:settings` → **Sine Mods**
2. Enable JS from unofficial sources if prompted
3. Install: `Zylaah/zen-mods/tree/main/media-volume-slider`  
   Or clone this repo and point Sine at the `media-volume-slider` folder.
4. Restart Zen

## Usage

1. Play media in a tab so the sidebar media bar appears
2. Hover the **media toolbar** to see album artwork in the background
3. Hover the **speaker / mute** icon to use the volume slider (artwork hides automatically)
4. Move away to dismiss the popup

The native mute button still works as a toggle; the slider stays in sync when muting via the button.

## How it works

- **UI** runs in browser chrome via `media-volume-slider.uc.js` on `browser.xhtml`
- **Volume** is applied in the content process with a small frame script that adjusts the active `video` / `audio` element
- **Artwork** reads metadata from `gZenMediaController` and applies it via a CSS custom property on toolbar hover
- Tab mute state uses Zen’s existing `toggleMuteAudio()` so the toolbar `[muted]` attribute stays correct

## Compatibility

- Works alongside other sidebar media mods (e.g. Zenslop)
- Volume control targets HTML media elements; sites with custom players may behave differently
- Does not amplify above 100% (no Web Audio gain boost)

## License

MIT
