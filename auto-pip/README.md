# Auto Picture-in-Picture Setting

Adds an Auto Picture-in-Picture toggle control to Zen Browser's unified site data panel. The setting only appears when media (audio/video) is detected on the current tab, allowing you to quickly enable or disable Firefox's automatic Picture-in-Picture feature when switching tabs.

## Features

- Automatically detects when media is playing on the current tab
- Adds a toggle in the site data panel (accessible via the address bar)
- Shows/hides the setting dynamically based on media playback state
- Updates when switching tabs or when media starts/stops
- Persists the preference setting across browser sessions

## How it works

- Monitors the `zen-unified-site-data-panel` for media presence
- Uses multiple detection methods to check for active media controllers
- Toggles the Firefox preference `media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled`

## Installation

Place `zen-auto-pip-setting.uc.js` in your JS directory and ensure your script loader is configured to execute it.

## Requirements

- Zen Browser (Firefox-based)
- User script loader (fx-autoconfig)
- Access to `Services` API

