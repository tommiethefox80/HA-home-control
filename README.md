# Home Control

A Home Assistant app for the heating and lighting of the whole house, in one panel.

- **Heating**: room-by-room schedules for Hive and Zigbee radiator valves, with the boiler fired whenever a room needs heat. Boost, snooze, open-window detection, warming early to be ready on time, phone alerts, Insights and gas cost.
- **Lighting**: lights and smart sockets in groups, with on/off, dimming and warmth schedules (including sunrise and sunset times and slow fades), scenes, movement and light-level sensors, seasons, and a lived-in Away pattern.
- **One Away** for both, switched by hand or by people's phones.
- **Dashboard card and sensors**: the Home Control card shows every room and light group at a glance, and switches and dims lights. The app installs and updates the card itself.

## Install

[![Add this repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Ftommiethefox80%2Fha-home-control)

Or in Home Assistant: Settings → Apps → App store → ⋮ → Repositories, and add `https://github.com/tommiethefox80/ha-home-control`. Then install **Home Control**, start it and open it.

New versions then appear in Home Assistant as "Update available": press Update.

The documentation is on the app's Documentation tab in Home Assistant, and in [home_control/DOCS.md](home_control/DOCS.md). What changed in each version is in [home_control/CHANGELOG.md](home_control/CHANGELOG.md).

## For development

- `home_control/server`: the Node.js server (no dependencies) that runs the heating and lighting, talks to Home Assistant and serves the web app.
- `home_control/web`: the web app (React, built with Vite). The built copy in `web/dist` is committed, so Home Assistant only has to build a small image: rebuild it with `cd home_control/web && npm ci && npm run build`.
- `home_control/dashboard`: the dashboard card.
- `home_control/dev`: a stand-in Home Assistant and end-to-end checks (`sh dev/run.sh`, then the `*-test.js` scripts).
