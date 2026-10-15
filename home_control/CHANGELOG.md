# Changelog

## 1.3.0
- **Updates in one press.** Home Control now comes from its own app repository on GitHub, so new versions show up in Home Assistant like any other app's: press Update (or turn on Auto update).
- **The dashboard card keeps itself up to date.** Every time the app starts it copies its card into Home Assistant's `www` folder and points your dashboards' resource at that version, adding the resource if there isn't one. No more copying the card or editing the resource after an update.
- **Moving in.** Installed next to the copy installed by hand, the new app offers to bring everything across in one press. It backs the old app up, copies rooms, schedules, boiler and settings, lighting groups, schedules and scenes, and Activity and history from that backup, stops the old app (and keeps it from starting again or showing in the sidebar), and takes over. Links on your dashboards that opened the old app now open this one. If anything goes wrong part-way, everything is put back as it was.
- The dashboard sensors now include `panel`, the app's address in Home Assistant, which the card uses to open the app.
- A new install with nothing set up yet doesn't write the dashboard sensors, so it can't cover up another copy of the app.
- Boiler run time on the dashboard: the heating card shows how long the boiler has run today and how many times it started ("Boiler resting · 1h 30m today, 2 runs"), the same figures as the app's Boiler today card.
- New `sensor.home_boiler_today`: minutes the boiler has run today, so Home Assistant keeps its history and daily statistics. `sensor.home_heating` also has `boiler_today_minutes`, `boiler_today` and `boiler_fires_today`.

## 1.2.0
- Switch and dim lights from your dashboard. On the Home Control card, each lighting group now has a power button and, where its lights dim, minus and plus (using the brightness step from Lighting settings). Switching on uses the level the group's schedule uses at that time of day, like the power button in the app. Tap a group's name, or the card's title, to open the app.
- `sensor.home_lighting` now lists each group's lights and sockets, and the level "on" means right now, so dashboards can switch them.

## 1.1.2
- Fixed a light that comes back on by itself after a scheduled off being taken for someone at the switch and left on until the next morning. Some Zigbee bulbs come back on at full brightness a good few seconds after being switched off, and Home Assistant only hears about it later. Now a light that comes back on within a minute of being switched off, with nobody behind it (no one in Home Assistant, no automation), is switched off again, and Activity says so and how long after. For Zigbee lights on ZHA, the app also checks the light again 20 and 50 seconds after switching it off.
- Fixed a slow fade being taken for someone at the switch: a report from part-way through a fade (say 30% on the way up to 40%) that arrives after the fade has finished is now recognised as the fade, not a person.
- The app's log (the Log tab) now has a line for every command sent to a light and for anything a light did by itself, to help work out what happened.

## 1.1.1
- The dashboard card always sizes itself to fit every room and group, so the last room can't be cut short on narrow or zoomed-out screens.

## 1.1.0
- Heating and lighting on your dashboards. The app now keeps three sensors up to date in Home Assistant: `sensor.home_heating` (the mode, the boiler, and every room's temperature, target and status), `binary_sensor.home_boiler` (on while the boiler is firing) and `sensor.home_lighting` (how many lights are on, and every group's level).
- The Home Control card draws them in the app's colours: rooms coloured by what they're aiming for, light groups in the colour of their light. Tap it to open the app. It's in the `dashboard` folder; see "Your dashboard" in the documentation.

## 1.0.0 — Home Control
Heating Control and Lighting Control are now one app, **Home**.

- A Heating / Lighting switch at the top of every page. Heating is unchanged and is still the first page, so dashboard links to `/local_heating_control` keep working. Open lighting directly with `/local_heating_control?section=lighting`.
- Lighting is everything from Lighting Control 0.2.4: groups of lights and sockets, dimming and warmth, schedules with sunrise/sunset times and fades, scenes (with Goodnight), movement and light-level sensors, seasons, the lived-in Away pattern and the 24-hour chart.
- **Bring them across**: one press copies groups, schedules, scenes and settings from the Lighting Control app. Lighting stays paused until you switch over, which stops the old app and changes nothing on your lights until each group's next scheduled change.
- **One Away for the house.** Away on either page sets both. "Away automatically" from phones (Heating → Settings) now switches the lights too, and still switches the lights while the heating is turned off for the summer.
- Home Assistant scripts using `lighting_control_scene` and `lighting_control_mode` keep working; the mode event now sets the heating's Away too.
- Fixed the heating not reconnecting after Home Assistant restarts if the first reconnection attempt failed (the same fix Lighting Control had in 0.2.1). Heating and lighting now share one connection that retries every few seconds and checks a quiet connection every 30 seconds.
- A small dot on the switch shows when the boiler is firing or lights are on in the other half.
- The Dashboard button on both pages uses the setting in Heating → Settings.

Earlier history: Heating Control 0.15.0 and Lighting Control 0.2.4.
