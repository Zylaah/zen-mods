# Better Media Toolbar

Rebuilds Zen’s sidebar media cards in the style of [Zia](https://github.com/z1n-k/zia)’s music player. Card corners stay Zen’s own radius and corner shape.

## Features

- **Artwork tile** — album art sits in the card, with the site icon or a letter when a track has none. A new picture flips into place.
- **Progress ring** — a thin ring around the art follows playback, tinted from the artwork.
- **Glow** — hovering a card washes it with two colours sampled from the art.
- **Sound bars** — the mute button is a set of bars. They move while audio is playing and collapse to dots when muted.
- **Collapsed card** — title, artist, artwork, and mute. Hover (or keyboard focus) opens the scrubber, elapsed time, time remaining, and previous / next / picture-in-picture / close.
- **Live** — streams without a duration show a LIVE mark instead of the scrubber.
- **Stack** — several sessions still peek behind the front card. The peek is a sliver until the toolbar is open.
- Cards can’t be dragged out of the sidebar.

## Requirements

- [Zen Browser](https://zen-browser.app/)
- [Sine](https://github.com/CosmoCreeper/Sine) mod loader
- **Enable installing JS from unofficial sources** in Sine settings

## Installation

1. Open `about:settings` → **Sine Mods**
2. Enable JS from unofficial sources if prompted
3. Install: `Zylaah/zen-mods/tree/main/media-volume-slider`  
   Or clone this repo and point Sine at the `media-volume-slider` folder.
4. Restart Zen

## Usage

1. Play media in a tab so a sidebar media card appears
2. The card shows the track. Hover it to scrub, skip, or close it
3. The mute button still toggles sound

## How it works

- **UI** runs in browser chrome via `media-volume-slider.uc.js` on `browser.xhtml`, with `chrome.css`
- Hooks the media card’s `updateIcon` and `updatePosition` so each card gets artwork, a progress ring, and the remaining time
- Samples artwork (and favicons) on a canvas for the glow, the ring, and the mute bars
- Tints the card from the sidebar background so it sits in the same paint as the rest of the sidebar

## Compatibility

- Targets Zen’s stacked media-card toolbar
- Picture-in-picture stays available even when Zen would hide it for pages with more than one video
- Does not change the card’s corner radius or corner shape

## License

MIT
