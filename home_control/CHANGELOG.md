# Changelog

## 1.10.0
- **Stop early before a drop** (Settings → Heating → Starting and stopping, off to start with). When a room's temperature is about to go down, it stops heating early and lets the radiators' leftover heat carry it to the drop: as early as it can while falling no more than half a degree (from how fast it loses heat and how cold it is outside), up to an hour. "Easing off early for 16° at 22:30".
- **Fire rooms together** (same page, off to start with). While the boiler is on for one room, rooms expected to need heat within 30 minutes start too, so the boiler runs once instead of twice. Only rooms below their stop point join, so none is pushed past its target. "Heating with Bedroom so the boiler runs once".
- **How good the predictions are** (Insights). Each room's next-heat prediction, made an hour and 15 minutes ahead, is compared with when it really started heating: how close, which way out, and any that didn't happen. Rooms that keep cooling faster or slower than measured are corrected for it.
- **Losing heat faster than usual.** Each room's daily heat loss is kept; if the last two days are 40% or more faster than its usual, it's shown under Needs attention and in Insights, with an optional phone alert (Settings → Heating → Phone alerts). Usually a window or trickle vent left open, or a new draught.
- Settings → Heating: "Warm by the scheduled time" is now **Starting and stopping**, with the two new settings.

## 1.9.0
- **When each room heats next.** Every room predicts when it'll next need heat, so when the boiler will next fire: from how fast the room loses heat (the figures from 1.8.0), the weather forecast, its schedule, and the rules the app heats by (the start gap, warming early, leftover radiator heat).
  - Room cards: "Next heat about 22:05, once it's cooled to 20.7°", "Next heat about 04:30, to be 20° by 06:30", or while heating, "Heating until about 21:15" (or "when its target drops"). The mini graph carries on from now as a dashed line, with a dot where it should start heating.
  - **Next heat** beside the rooms: the boiler's next start and for which room (and the one after), or while it's on, **Boiler on until**. The boiler at the top says it too ("Boiler resting, next on about 22:05").
  - Each room's page says how it was worked out ("It's losing about 0.6° an hour now, with 7.8° outside").
  - Dashboard card: a "Next heat about 22:05" line under each room, and the boiler's next start in the heading (`next: false` leaves the room lines out).
  - New `sensor.home_boiler_next` (a timestamp) for dashboards and automations, and `boiler_next`, `boiler_until` and each room's `next_heat` on `sensor.home_heating`.

## 1.8.1
- **Settings is one menu for the whole app.** **General** is at the top (what it looks after, Away automatically, the Dashboard button), then a group for each part that's on: Heating, Lighting, Cameras and Wi-Fi, each split into short pages (Heating: Rooms, Boiler, Temperatures, Warm by the scheduled time, Open windows, How it behaves, Phone alerts, Room cards, Gas cost and outside, History).
  - On a computer or tablet the menu is on the left with the page beside it; the other parts' groups fold away until opened. On a phone the menu is a list and each page opens on its own, with **All settings** to go back.
  - It's the same from every part's Settings tab, and a page in another part opens that part.
  - Links around the app now go straight to the right page ("Choose your boiler in Settings" opens Boiler, and so on).
  - Heating's settings are saved for you if you leave them without pressing **Save settings**.
  - Turning a part off from Settings keeps you in Settings.

## 1.8.0
- **How each room holds its heat**, a new part of Heating → Insights. From the last week of history in Home Assistant, for each room:
  - how fast it warms up on a milder day and on a colder one, so you can see how much the weather slows it;
  - how fast it cools once the heating's off when it's 10° colder outside, and on a 0° day;
  - how long it takes to fall from 20° to 17° on a 5° night;
  - minutes of heating it needs for each cold degree;
  - and whether it holds its heat well, about average or loses it quickly compared with the other rooms.
- Cooling is only measured when a room has had no heat at all (not calling, the boiler off and its radiator cooled), and stops counting when something else warms it, so the sun or cooking don't flatter a room.
- Callouts name the room that holds its heat best, the one that loses it fastest (with what to check) and the one cold days slow most.

## 1.7.3
- **Always-open radiators.** A room whose radiator has no TRV (usually the one with the boiler thermostat) gets heat whenever the boiler runs, for any room. Home Control now spots these (a room with no TRV of its own, only the boiler thermostat) and you can set it per room (Heating → Settings → Edit a room → Radiator valves).
  - Its card counts that heat separately: "Not fired itself · heated twice with other rooms (45m)", or "Fired once · 20m, and twice with other rooms (45m)".
  - Insights shows the extra heat under "Heating, 7 days" ("+ 3.2 h with other rooms") and explains it, as it's why such a room often sits above its target.
  - Its learning ignores heat-ups where another room kept the boiler running after it stopped, so that warmth isn't mistaken for overshoot and doesn't make it stop ever earlier.

## 1.7.2
- **"Heats again below…"** A room that's below its target but isn't heating now says when it will, on its card, on its own page (with the reason: it stops early to let the radiators' leftover heat finish, and starts again a little below that so the boiler doesn't flick on and off), and on the dashboard card ("Heats again below 17.9° · 15° from 22:00"). Before, it just said "On schedule", which looked like a fault.

## 1.7.1
- **Who's on each access point and network.** Each access point on the Access points page, and each network on the Networks page, lists the devices connected to it, with the network or access point and the band each is using. The first six show, with **Show all** for the rest; devices UniFi counts but Home Assistant isn't tracking are noted.
- **Wi-Fi → Settings → Connected devices** turns these lists on and off, for access points and networks separately, and can put the names on the dashboard card too (`show: wifi`). The `sensor.home_wifi` access points and networks then have `devices`.

## 1.7.0
- **Wi-Fi.** A new part of Home Control for UniFi networks, off until you turn it on in Settings → Home Control. It uses Home Assistant's UniFi Network integration, so there's nothing else to set up.
  - **Access points**: each one with who's on it, whether it's online, how long it's been up and whether a firmware update is waiting; switch its status light, restart it, and switch it off and on through the PoE port it's plugged into.
  - **Networks**: switch each Wi-Fi network off and on, see how many devices are on it, and show a QR code for guests to join.
  - **Devices**: everything on the network, with the network, access point and band it's on; filter and search. Devices Home Assistant isn't tracking can be tracked in one press, and devices in the integration's block list can be blocked and allowed.
  - **Schedules**: the status lights off at night, a network off between two times or on only between two times, and an access point off overnight. Each change is made once at its time; switching by hand in between is left alone.
  - Activity lists every change made here or by a schedule.
  - `sensor.home_wifi`, and `show: wifi` on the dashboard card, with status lights and networks switchable from there.

## 1.6.2
- A camera Home Assistant shows as unavailable, but whose pictures keep coming through, now counts as working. UniFi Protect can mark a working camera unavailable; Home Control now looks at the pictures before calling a camera offline (a picture that never changes, as some cloud cameras give while offline, doesn't count). Its Camera settings explain what Home Assistant shows and what to do.
- Home Assistant won't take pictures or clips from a camera it shows as unavailable, so in that case Home Control saves the picture itself, and Activity says why there's no clip.
- Phones are no longer told about an offline camera again after Home Control restarts or updates, or about a camera that was already offline when it was added.
- Offline alerts for a camera that's been down since before today give the day ("Offline since Sun 11 Oct, 07:16").
- The dashboard card shows pictures from a camera Home Control counts as working, even when Home Assistant calls it unavailable.

## 1.6.1
- Fixed a camera showing as offline while it was working, when another integration had added its own "connected" sensor to the camera's device in Home Assistant (UniFi Protect cameras could show this). Only the camera itself, or its own integration's connected sensor, now decides.
- An offline camera now says why: on its picture on the Cameras page, in its Camera settings and in the Settings list (for example "Home Assistant shows the camera as unavailable").

## 1.6.0
- **Cameras.** A new part of Home Control, off until you turn it on in Settings → Home Control. Works with any camera Home Assistant knows about (UniFi Protect, Reolink, Ring, Frigate, Tapo, Hikvision, ONVIF, generic RTSP and more), using its own sensors and settings, so there's nothing to set up per make.
  - A Cameras page with every camera's picture, what it last saw, and Home Assistant's live view a tap away.
  - Movement alerts to the phones you choose, with a picture, saying what was seen ("Person seen", "Someone at the door"). Each camera alerts on its own schedule: always, when everyone's out, between set times, either, or never. A bell on each camera turns its alerts off and on.
  - On movement, a picture and a short clip are saved in Home Assistant's media folder and play from Activity, again on each camera's own schedule.
  - Choose which movement counts per camera (just people, say).
  - Offline cameras are reported, and again when they're back.
  - Each camera's own settings (privacy, recording mode, detection, night vision, floodlight, siren…) in one place, grouped in plain words.
  - `sensor.home_cameras`, and `show: cameras` on the dashboard card, with chosen camera settings switchable from there.
- The app can now save to Home Assistant's media folder (for camera clips and pictures), which Home Assistant lists on the app's page.

## 1.5.0
- **Turn heating or lighting off.** A new **Home Control** section at the top of Settings has a switch for each part, for houses where something else looks after the heating or the lights. Turning a part off asks first, then hands its devices back (radiators and the boiler go back to their own schedules; lights and sockets stay as they are), stops it reacting to Home Assistant, removes its dashboard sensors, and hides its pages and settings. Everything set up is kept: turning it back on carries on where it left off, and lights are left as they are until each group's next scheduled change. At least one part stays on.
- With only one part on, the Heating / Lighting switch at the top gives way to the part's name.
- The **Dashboard button** and **Away automatically** settings have moved into Settings → Home Control, as they're for the whole house. With the heating turned off, Away automatically still looks after the lights.

## 1.4.0
- **Choose which light groups the dashboard card shows.** Each group (Lighting → Settings → Edit) has a new **Dashboard** setting: Show, Hide, or, for a group with a season, show only between its dates. Good for Christmas lights that should only appear in December, or lights you never switch from the dashboard. Hidden groups still follow their schedules and are all still in the app. The Settings list notes which groups are hidden.
- `sensor.home_lighting` lists each group's `card` setting and whether it's `shown`, so other dashboards can follow it too.

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
