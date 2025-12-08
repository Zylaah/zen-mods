# Mistral Pill

Highlights the Firefox address bar search mode indicator with a distinctive orange color and glow effect when it displays "Mistral AI", making it easier to identify when Mistral AI search mode is active.

## Features

- Automatically detects when the search mode indicator shows "Mistral AI"
- Applies a bright orange background color (`rgb(250, 80, 15)`)
- Adds a subtle glow effect around the indicator
- Removes the highlight when switching to other search modes
- Uses MutationObserver to react to text changes in real-time

## How it works

- Monitors the `urlbar-search-mode-indicator-title` element for text changes
- Applies inline styles with `!important` to ensure visibility
- Automatically removes styling when the text no longer contains "Mistral AI"

## Installation

Place `mistral-pill.uc.js` in your JS directory and ensure your script loader is configured to execute it.

## Requirements

- Zen Browser (Firefox-based) or Firefox
- User script loader (fx-autoconfig)

