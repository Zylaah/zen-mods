# Better Media Toolbar

Enhances Zen’s sidebar media controls with a hover volume slider and an artwork background on media cards.

Compatible with Zen’s stacked media-card toolbar (multiple sessions / peek stack).

## Features

- **Volume slider** — hover a card’s mute button to reveal a slider to the **right** of the media toolbar (0–100%)
- **Per-card volume** — each media card/tab keeps its own volume; changing one never overwrites the others
- Toolbar stays expanded while the mute button or slider is hovered
- **Artwork background** — hover the media toolbar to show each card’s album art as a background
- Artwork is hidden while the volume UI is active
- At 0%, mutes the tab that owns that card
- Above 0%, unmutes if needed and sets media element volume in that tab
- Works with stacked cards; the slider targets the card you hover
- Hidden during WebRTC / screenshare cards (`[media-sharing]`)
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

1. Play media in a tab so a sidebar media card appears
2. Hover the **media toolbar** to see album artwork on cards
3. Hover a card’s **speaker / mute** icon to use the volume slider (artwork hides automatically)
4. Move away to dismiss the popup

The native mute button still works as a toggle; the slider stays in sync when muting via the button.

## How it works

- **UI** runs in browser chrome via `media-volume-slider.uc.js` on `browser.xhtml`
- Hooks `gZenMediaController.activateMediaControls` / `activateMediaDeviceControls` to map each `.zen-media-card` to its browser/controller
- Wires `.zen-media-mute-button` on every card (class-based; cards are created from `#zen-media-card-template`)
- **Volume** is applied in the content process with a small frame script that adjusts the active `video` / `audio` element
- **Artwork** reads metadata from the card’s media controller and applies it via a CSS custom property on toolbar hover
- Tab mute state uses Zen’s existing `toggleMuteAudio()`; the card’s `[muted]` attribute is kept in sync

## Compatibility

- Targets Zen’s stacked media-card UI (not the older single-`toolbaritem` bar)
- Volume control targets HTML media elements; sites with custom players may behave differently
- Does not amplify above 100% (no Web Audio gain boost)

## License

MIT
