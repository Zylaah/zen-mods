# Zen Workspace Collapse

Adds a chevron icon to workspace indicators that allows you to collapse and expand all pinned folders and tabs within a workspace. The chevron appears on hover when the workspace is expanded, and remains visible when collapsed.

## Features

- Per-workspace collapse state (session-only, resets on browser restart)
- Smooth animations when collapsing/expanding
- Chevron icon rotates to indicate state (right = collapsed, down = expanded)
- Automatically closes all folders on startup
- Handles nested collapsed items correctly
- Prevents animation conflicts during drag operations
- Shows original workspace icon when emoji picker is open

## How it works

- Adds a chevron SVG icon to each workspace indicator
- Tracks collapsed state per workspace ID in memory
- Animates pinned folders and direct tabs using CSS transitions
- Manages icon visibility (chevron vs. original icon) based on hover and collapse state

## Usage

1. Hover over a workspace indicator to see the chevron icon
2. Click the chevron to collapse/expand all pinned folders and tabs in that workspace
3. The chevron remains visible when the workspace is collapsed
4. When expanded, the chevron appears on hover

## Installation

Place `zen-pinned-area-collapse.uc.js` in your JS directory and ensure your script loader is configured to execute it.

## Requirements

- Zen Browser (Firefox-based)
- User script loader (fx-autoconfig)

## Notes

- Collapse state is session-only and resets when the browser restarts
- All folders are automatically closed on browser startup

