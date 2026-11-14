# Live Calendar

A Zen Browser mod for Sine. Hover a Google Calendar essential or pinned tab to see today. A small pill on that tab counts a meeting that is about to start or just started.

## Features

- Hover the Calendar tab to open today's schedule
- **Join** when a meeting with a call link is within 10 minutes or already in progress
- A pill on the essential or pinned tab reads `in 2m`, `now`, or `2m ago`
- **+** at the bottom of the panel creates a new event on that Calendar tab
- Click an event to open it in Calendar
- The day is loaded with your own Google Calendar client, and stays available after the tab unloads

## Installation

1. Install [Sine](https://github.com/CosmoCreeper/Sine) on Zen Browser.
2. Enable unsafe JS and add `Zylaah/zen-mods/tree/main/live-calendar`.
3. Restart Zen.

## Usage

1. Create a Desktop app OAuth client and set `live-calendar.google.clientId` to that client id.
2. Pin Google Calendar as an essential or pinned tab.
3. Hover it and click **Sign in to Google Calendar**. The day and the join pill update from the Calendar API after that.
