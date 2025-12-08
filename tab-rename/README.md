# Tab Rename

Enhances Zen Browser's tab renaming functionality to allow renaming of non-pinned tabs (except essential tabs) and persists custom tab titles across browser sessions.

## Features

- Allows renaming of both pinned and unpinned tabs (double-click to rename)
- Blocks renaming only for essential tabs (system tabs)
- Persists custom tab titles using Firefox's SessionStore
- Restores renamed titles when tabs are restored after browser restart
- Handles edge cases like tabs restored individually or late

## How it works

- Overrides `gZenVerticalTabsManager.renameTabStart` to allow pinned tab renaming
- Intercepts `renameTabKeydown` to save custom titles to SessionStore
- Listens for `SSTabRestored` events to restore titles on session restore
- Stores custom titles in SessionStore with the key `zen-renamed-title`

## Usage

1. Double-click on any tab (pinned or unpinned, except essential tabs) to rename it
2. Type the new name and press Enter to save
3. Custom titles are automatically saved and restored across browser sessions

## Installation

Place `tab-rename.uc.js` in your JS directory and ensure your script loader is configured to execute it.

## Requirements

- Zen Browser (Firefox-based)
- User script loader (fx-autoconfig)
- Requires `SessionStore` API access
- Requires `gZenVerticalTabsManager` to be available

## Notes

- Essential tabs (system tabs) cannot be renamed
- Custom titles are stored in SessionStore and persist across browser restarts
- If a tab's custom title is cleared, it will revert to showing the page title

