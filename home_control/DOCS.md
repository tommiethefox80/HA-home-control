# Home Control

Heating, lighting, cameras and Wi-Fi for the whole house in one panel. **Home** in the sidebar opens on Heating; the switch at the top (**Heating / Lighting**, and **Cameras** and **Wi-Fi** once they're turned on) flips between them. A small dot on another part of the switch means something's on over there (the boiler firing, or lights on).

- **Heating**: room-by-room schedules for Hive and Zigbee TRVs, with the boiler fired whenever a room needs heat. Works with Hive TRVs (through the Hive integration) and Zigbee TRVs (ZHA or Zigbee2MQTT), side by side. The boiler can be a Hive thermostat (`climate.*`) or a relay (`switch.*` / `input_boolean.*`).
- **Lighting**: lights and smart sockets in groups, with on/off, dimming and warmth schedules, scenes, and a lived-in Away pattern.
- **Cameras**: any camera Home Assistant knows about, with movement alerts and recording on schedules (off to start with; see Cameras below).
- **Wi-Fi**: UniFi access points, networks and who's connected, with the access points' lights off at night and networks on schedules (off to start with; see Wi-Fi below).
- **One Away** for everything, switched by hand or by people's phones.

The parts share one connection to Home Assistant and run independently, so a problem in one can't stop the others.

## Installing and updating

Home Control comes from its own app repository on GitHub, `https://github.com/tommiethefox80/ha-home-control`, so new versions show up in Home Assistant like any other app's.

1. Settings → Apps (or Add-ons) → **App store** → **⋮ → Repositories**, add `https://github.com/tommiethefox80/ha-home-control` and press **Add**.
2. Find **Home Control** in the store (under its own Home Control heading), press **Install**, then **Start**, then **Open web UI**. If you had the Home Control installed by hand, it offers to move everything across (below), and puts itself in the sidebar. Otherwise turn on **Show in sidebar** on the app's page.

**Updating:** when there's a new version, Home Assistant shows "Update available" under Settings and on the app's page. Press **Update**. Turn on **Auto update** on the app's page if you'd rather it updated by itself. The dashboard card updates with it (see "The Home Control card" below).

## Moving in from the Home Control installed by hand

Versions up to 1.2 were installed by copying a folder into `/addons` ("Local apps"). Home Assistant treats the copy from the repository as a different app, with its own data folder and its own address, so the first time you open it, it offers to bring everything across. One press of **Move everything here**:

1. Makes a backup of the old app (it stays in Settings → System → Backups).
2. Copies everything here from that backup: rooms, schedules, boiler and settings; lighting groups, schedules and scenes; and Activity and history.
3. Stops the old app, keeps it from starting with Home Assistant and takes it out of the sidebar.
4. Restarts this app with everything, and points the links on your dashboards that opened the old app (`/local_heating_control`) at this one. Dashboards kept in YAML files can't be changed by the app: it names them so you can change their links by hand.

It takes about a minute. Radiators go back to their own schedules for a moment while it switches over, as they do whenever the app restarts. If anything goes wrong part-way, it puts everything back as it was and says what happened. Once you're happy, uninstall the old Home Control from Settings → Apps.

This needs you to be signed in to Home Assistant as an administrator, and the backup to be kept on this device (if your backups go to a network drive by default, the move still keeps this one local).

## Bringing your lights across from Lighting Control

If the old Lighting Control app is installed, the Lighting page offers **Bring them across**. One press copies its groups, schedules, scenes and settings here. Then:

1. Lighting here starts **paused**: nothing is sent to your lights, so the two apps don't fight. Check the groups and schedules look right.
2. Press **Stop Lighting Control and start here**. That stops the old app, stops it starting again after a restart, and starts lighting here. Nothing changes on your lights at that moment: each group carries on as it is until its next scheduled change.
3. Once you're happy, uninstall Lighting Control from Home Assistant's settings.

This needs you to be signed in to Home Assistant as an administrator (it asks Home Assistant to read and stop the old app). If it can't, it says so: stop Lighting Control yourself in Home Assistant's settings and press **Start lighting here**, or add your groups again from Settings (starting from your Home Assistant areas is quick).

Lighting Control's own "Away automatically" setting isn't brought across, because Away is now shared (below). **Settings → Lighting → Getting started** lets you bring everything across again later, replacing what's here.

## Settings

**Settings** (the last tab in every part) is one menu for the whole app. **General**, at the top, has the settings for all of it; under that, each part that's on has its own group: **Heating**, **Lighting**, **Cameras** and **Wi-Fi**. On a computer or tablet the menu sits on the left with the page you picked beside it (the other parts' groups fold away until you open them); on a phone the menu is a list and each page opens on its own, with **All settings** to go back. Picking a page in another part opens that part.

Heating's settings are saved with **Save settings**; if you leave Heating's settings without pressing it, the changes are saved for you. Everywhere else, changes save as you make them.

### General

- **What it looks after.** A switch for **Heating**, **Lighting**, **Cameras** and **Wi-Fi** (the last two start off). Turn one off if something else looks after it (another heating app, Hue's own schedules, automations). Turning it off asks first, then:
  - Heating: radiators and the boiler are handed back to their own schedules, as when the app stops. Nothing is sent to them after that, and knobs turned by hand are left alone.
  - Lighting: lights and sockets stay as they are, and scenes or modes asked for by Home Assistant scripts are ignored.
  - Its pages and settings are hidden, and its dashboard sensors are removed from Home Assistant.
  - Everything you set up is kept. Turning it back on carries on where it left off; lights are left as they are until each group's next scheduled change.

  At least one part has to stay on. With only one on, the Heating / Lighting switch at the top shows just that part's name.
- **Away automatically.** The people, wait and distance for switching the house to Away from phone locations (below).
- **Dashboard button.** Where the Dashboard button at the top of every page goes.

## Away for the whole house

Away is one switch for the heating and the lights:

- **Away on the Heating page** (by hand, until a date, or automatically from phones) puts the lights on Away too. Coming back to Schedules brings both back.
- **Away on the Lighting page** puts the heating on Away too, and Schedules brings it back. Home Assistant scripts using `lighting_control_mode` do the same.
- **Heating switched Off** (say for the summer) is left alone: Away on the Lighting page then only changes the lights. While the heating is off, the same people, wait and distance settings still switch the lights to Away when everyone's out and back when someone's on the way home.

The people, wait and distance are set once, in **Settings → General → Away automatically**. If the heating is turned off there, they still switch the lights.

In Away, every room drops to the away temperature, and lights stay off except groups set to look lived in.

## Your dashboard

The app keeps these sensors up to date in Home Assistant, for dashboards, automations and history:

| Sensor | State | Attributes |
|---|---|---|
| `sensor.home_heating` | Schedules, Away or Off | `boiler` ("Boiler resting, next on about 22:05"), `boiler_on`, `boiler_next` and `boiler_next_rooms` (when it should next fire, and for which rooms), `boiler_until` (while it's on, about when it'll be done), `boiler_today` ("1h 30m"), `boiler_today_minutes`, `boiler_fires_today`, `mode_text`, `boost`, `attention`, and `rooms`: each room's `name`, `temp`, `target`, `calling`, `status`, `next` ("Next heat about 22:05"), `next_why` ("as it cools to 20.7°"), `next_heat` and `heating_until` (times) |
| `binary_sensor.home_boiler` | on while the boiler is firing | |
| `sensor.home_boiler_today` | minutes the boiler has run today (resets at midnight; Home Assistant keeps daily statistics) | `fires`: how many times it started |
| `sensor.home_boiler_next` | when the boiler should next fire (a timestamp; unknown while it's on, or if nothing needs heat in the next 24 hours) | `rooms`, `reason` ("as it cools to 20.7°"), `on_until` (while it's on) |
| `sensor.home_lighting` | how many lights and sockets are on | `summary` ("3 lights on in Lounge and Kitchen"), `mode_text`, `paused`, `step`, and `groups`: each group's `name`, `on`, `level` ("45%"), `brightness`, `kelvin`, `status`, its `devices` and `turn_on` level for switching it from a dashboard, and `card` (show, season or hide) and `shown` (whether the card shows it today) |

Both `sensor.home_heating` and `sensor.home_lighting` also have `panel`: the app's address in Home Assistant, for buttons that open it.

Home Assistant forgets them when it restarts; the app writes them again as soon as it reconnects. A new install with nothing set up yet doesn't write them. Temperatures are written at most every 20 seconds; mode, boiler and light changes straight away.

### The Home Control card

A dashboard card that shows the heating or the lighting at a glance, in the app's colours.

- **Heating:** every room's temperature, what it's aiming for and why, when it next heats ("Next heat about 22:05", or "Heating until about 21:15"), and the boiler, with when it next fires and how long it has run today. Tap it to open the app. Add `next: false` to leave out the next-heat lines.
- **Lighting:** every group, with a power button and, where its lights dim, minus and plus (in the brightness step from Lighting settings). Switching on uses the level the group's schedule uses at that time of day. A change made here counts as a change in Home Assistant by whoever made it, so it lasts until the group's next scheduled change. Tap a group's name, or the title, to open the app.
- **Which groups it shows:** each group has a **Dashboard** setting (Lighting → Settings → Edit the group): **Show**, **Hide**, or, for a group with a season, show only between its dates (Christmas lights only in December, say). Hidden groups still follow their schedules and are all still in the app.

The app looks after the card itself. Every time it starts it copies the card into Home Assistant's `www` folder and points your dashboards' resource at that version (`/local/home-control-card.js?v=1.3.0`), adding the resource if there isn't one. So after an update, a refresh of the page brings the new card. (If the `www` folder didn't exist before, restart Home Assistant once so it serves it. If your dashboards' resources are set in YAML, add `/local/home-control-card.js?v=` plus the version there yourself.)

Add the cards:

```yaml
type: custom:home-control-card
show: heating
```

```yaml
type: custom:home-control-card
show: lighting
```

The card opens the app wherever it is: the app writes its own address into the sensors (the `panel` attribute). Add `panel: /some_path` to a card to send it somewhere else.

## Opening from a dashboard

The Dashboard button at the top of either page goes back to the dashboard set in **Settings → General → Dashboard button**.

To open Home from a dashboard, use the app's address. It's `/` followed by the app's name in Home Assistant, which is in the address bar when Home is open (for example `/bea84e52_home_control`), and it's shown in **Lighting → Settings → Getting started**:

```yaml
type: button
name: Heating
icon: mdi:radiator
tap_action:
  action: navigate
  navigation_path: /bea84e52_home_control
```

To open straight onto Lighting, add `?section=lighting`:

```yaml
type: button
name: Lighting
icon: mdi:lightbulb-group
tap_action:
  action: navigate
  navigation_path: /bea84e52_home_control?section=lighting
```

Moving in from the Home Control installed by hand points buttons that opened `/local_heating_control` here by itself.

# Heating

## How it works

Every 30 seconds, and whenever a valve or thermometer changes:

1. Each room's **target** is worked out, in this order of priority:
   - **Off** mode: frost protection temperature
   - a **boost**, **hold**, or a change someone made **on the radiator**
   - **Away** mode: away temperature
   - the room's **schedule**
2. Every TRV in the room is set to that target (only when it differs, and spaced out so Hive's cloud API isn't hammered).
3. A room **calls for heat** when it falls 0.3° (configurable) below target, and stops when it reaches target, or a set amount below it if you use **Stop heating this far below target** to let the radiators' leftover heat finish the job. A room that stops early (learned or set) only starts again 0.2° below its stop point, so the boiler doesn't flick on and off. A room below its target that isn't heating says when it will, on its card ("Heats again below 17.9°"), on its own page (with why), and on the dashboard card.

   A room whose radiator is **always open** (no TRV, usually the one with the boiler thermostat) gets heat whenever the boiler runs for any room. Home Control works this out for a room with no TRV of its own (or set it under the room's **Radiator valves**), counts that heat separately on its card ("heated twice with other rooms") and in Insights, and keeps it out of what the room learns.
4. If any room is calling, the **boiler fires**. With a Hive thermostat this means setting it to 30° in manual mode; when every room is satisfied it goes back to 7°. Minimum run and rest times stop short cycling.

The room temperature comes from the TRVs' own readings, or from a separate thermometer if you pick one (more accurate: a TRV sits next to a hot radiator).

### Stopping early, and learning each radiator

Radiators keep giving off heat after they shut off, so a room can carry on warming past its target. Each room has a **Stop heating early** setting (Settings → Rooms → Edit):

- **Learn automatically** (the default): after every heat-up the app watches how far the room keeps rising, then nudges that room's stop point. If it overshot, it stops earlier next time; if it fell short, it stops later. Changes are small (at most 0.3° per heat-up, never more than 1.5° early), so one odd day can't throw it out, and most rooms settle within a few heat-ups. The room's settings show what it has learned and the last few heat-ups, with **Forget and relearn** if you move furniture or change a radiator.
- **Fixed %**: always stop a set percentage below the target (2% of 21° is about 0.4°). After a heat-up it suggests a percentage based on how far the room actually rose.
- **House setting**: use the single value under Settings → Temperatures.

When a room stops calling early, its valves are turned down to the stop point too, so they close even if the boiler is still firing for another room. When the room needs heat again, they go back up to the target.

### When each room heats next

Every room card says when the room should next need heat, and so when the boiler should next fire for it: "Next heat about 22:05, once it's cooled to 20.7°", "Next heat about 05:50, to be 20° by 06:30", or while it's heating, "Heating until about 21:15". Its mini graph carries on from now as a dashed line, with a dot where it should start heating (or be warm). **Next heat**, beside the rooms, has the next time the boiler should fire and for which room (while it's on, **Boiler on until**). Tap a room for how it was worked out.

It's worked out from:
- how fast the room loses heat (measured from the last week, as in [Insights](#insights); a room still being measured goes by the house's other rooms), and the weather forecast from your weather entity (the outside reading now, easing into the forecast). A room cools faster the colder it is outside;
- the room's targets as they'll be: its schedule, a hold or boost running out, Away ending;
- the same rules the app heats by: a room starts heating once it's below its target by the start gap, earlier for a scheduled rise if it warms early, and the radiators' leftover heat holds a room up for a while after it stops;
- for a room heating now, how fast it's learned it warms.

It's a prediction: sun, cooking, people and doors move it, so it says "about". It looks a day ahead, and is worked out again every minute or so.

The predictions are checked: when a room's next heat is an hour away, and again at 15 minutes, the prediction is kept and later compared with when the room really started heating. **Insights → How good the predictions are** shows, for each room, how close they've been, which way they tend to be out, and any that didn't happen. If a room keeps starting earlier or later than predicted (it really cools faster or slower than measured), its predictions are corrected for it once it has three heat-ups to go on. Heat-ups someone asked for (a boost or a hold), and rooms started early with another room, aren't counted.

### Stop early before a drop

Off to start with: turn it on in **Settings → Heating → Starting and stopping**. When a room's temperature is about to go down (20° until 22:30, then 16°, say), it stops heating a little early and lets the radiators' leftover heat carry it to the drop. How early depends on how fast the room loses heat and how cold it is outside: as early as it can go while falling no more than half a degree by the drop (and at most an hour; both can be changed). A room that holds its heat well eases off earlier than one that doesn't. The room shows "Easing off early for 16° at 22:30", and Activity notes each time it stopped a room heating early. The settings page shows how early each room would stop at its next drop. A room has to have its heat loss measured first (it usually is from the first day).

### Fire rooms together

Off to start with: turn it on in **Settings → Heating → Starting and stopping**. While the boiler is on for one room, any room the app expects to need heat within the next 30 minutes (from [When each room heats next](#when-each-room-heats-next)) starts now as well, so the boiler runs once instead of starting again soon after. Fewer, longer runs use less gas and are easier on the boiler. A room joins in only if it's below the point it would stop at, so it's never pushed past its target; one that was going to warm early for a scheduled rise starts warming now. It then carries on until it reaches its stop point, like any other heat-up. Its card says "Heating with Bedroom so the boiler runs once", and Activity notes it.

### Warm by the scheduled time

Each room learns how quickly it warms (degrees per hour) from every heat-up of 20 minutes or more, and how cold it was outside at the time. Before a scheduled rise, the app works out how long the room needs, allowing for tonight's outside temperature, and starts that much early, so the room is at the new temperature by the scheduled time instead of only starting to warm then. The room shows "Warming early to reach 20.5° by 16:30" while it does. Turn it off or limit how early it can start (2 hours by default) in **Settings → Heating → Starting and stopping**. A room's learned speed is shown in its settings.

### Open windows

If a room drops sharply (1° within 10 minutes by default), it's probably a window or door. The room's valves go to frost protection for 20 minutes, the room shows "Window open? Heating paused", and an optional phone alert can tell you. Press **Window's closed, resume heating** in the room to carry on straight away. Adjust or turn off in **Settings → Heating → Open windows**. Hive valves report every few minutes, so very short draughts may be missed; Zigbee valves and room thermometers catch them sooner.

### Away automatically

With **Settings → General → Away automatically** on, the app watches the people you tick (Home Assistant "person" entities, which use the location from the Home Assistant app on each phone). When everyone has been out for 15 minutes, the house switches to Away: the heating and the lights. When anyone is home or within 2 miles, it switches back to Schedules so the house is warming as they arrive. A mode you pick by hand always wins: if you choose Schedules while everyone is out, it stays on Schedules until someone has been home. See [Away for the whole house](#away-for-the-whole-house).

### Needs attention

A card above the rooms appears only when something needs looking at:

- a room that has been calling for heat for over an hour without warming (a cold radiator, an airlock, or a stuck valve);
- a radiator valve that's offline, or whose battery is at 20% or less;
- the boiler control being offline, or the boiler not reporting that it's heating 10 minutes after being asked.

### Changes made on a radiator

If someone turns a TRV or changes it in the Hive app, the room holds that temperature until its next scheduled change, then goes back to the schedule. Turn this off in **Settings → Heating → How it behaves** if you'd rather the schedule always wins.

### Back to schedule

Whenever a room is boosted, held, or was changed on the radiator, its card shows **Back to schedule**. One tap drops the change and the room follows its schedule straight away, without waiting for the boost or hold to run out. The same button is at the top of the room's details, showing the temperature it will go back to. If the house is in Away, it says **Back to Away** and returns the room to the away temperature. A room taken out of a house boost this way leaves the boost; the other rooms carry on.

### When the add-on stops

On a clean stop (update, restart, uninstall) the add-on puts Hive devices back into Hive's own schedule mode, so the thermostat is never left stuck at 30°. Zigbee valves without a schedule mode keep their last temperature. If the whole machine loses power, devices keep their last setting until it's back. Lights and sockets are always left exactly as they are; if a scheduled change was missed while the app was stopped, it catches up on start.

## Snooze a room

To stop heating a room for a while, say a spare room nobody's using, tap the room's name and choose **Snooze**. Pick how long (2 hours, 6 hours, 1 day, 2 days, 1 week, or any number of hours or days up to 90 days), or **Until I turn it back on**. The room ignores its schedule and is kept at the frost protection temperature (7° unless you've changed it), or whatever you set under **Keep it at**.

The card shows "Snoozed at 7° until Wed 19:00" and a **Back to schedule** button that ends the snooze. Switching the house to Away, Off and back doesn't end a snooze. If someone boosts the room, holds it with − / +, or turns its radiator, that works as normal and the room goes back to its snooze afterwards ("…, then snoozed again"). **Boost** for the whole house leaves snoozed rooms unticked. Snoozed rooms don't send open-window alerts, since they're meant to cool down.

## Boost the house

The **Boost** button next to Schedules, Away and Off warms several rooms at once for a while. It opens with the temperature and length from **Settings → Heating → Temperatures** (22° and 30 minutes to start with) and every room ticked. Untick any rooms you want left alone, adjust the temperature or length, and press **Boost**.

While it runs, the button shows the time left. When it ends, or when you press **Stop boost**, each room goes back to exactly what it was doing before: its schedule, or a hold or boost it already had if that hasn't run out. Changing the whole-house mode cancels a boost, and you can't boost while the heating is Off. If someone turns a radiator by hand during a boost, that room keeps their setting instead.

## Today, gas and outside

Each room's card has a small graph of today: the room's temperature since midnight, with orange shading where that room was calling for heat, plus how many times it fired and for how long ("Fired 3 times · 2h 10m today") and the day's low and high. It sits right above the schedule strip on the same 00:00–24:00 scale, so you can see the room warming during each scheduled period. Tap or hover for the exact time and temperature. The Boiler card shows how many times the boiler itself fired today.

Turn the graph and the fired count on or off in **Settings → Heating → Room cards** (for everyone in the house). With only the count on, cards show just the "Fired…" line.

The heating shading and the fired count are recorded by the add-on, so on the day you first install it they only cover the time since then, and the card says so ("Fired twice since 18:10"). The total time and the temperatures are there straight away.

Under the rooms you get a 24-hour chart for each room: actual temperature, target, outside temperature, and shading where the boiler fired. Tap or hover for exact values, or switch to a table. Beside it are today's gas cost (with yesterday's), how long the boiler has run today, and the outside temperature.

**All rooms** (the first choice above the chart, and where it starts) puts every room on one chart, one coloured line each, so you can compare them. Pick what to show:

- **Temperature** (the default): how warm each room actually was.
- **Target**: what each room was aiming for. Rooms sharing a target are drawn just apart so none hide.
- **vs target**: how far above or below its target each room was. A room that sits well below 0° for long spells is struggling to warm.

Under the All rooms chart, **Calling for heat** has a lane per room, in the same colours, marking when each room asked for heat. The boiler shading runs down through the lanes, so you can see which room set it off. Tap or hover inside a firing period and the readout says what fired the boiler and why, for example "Fired by Lounge (schedule) · then Kitchen (boost)". Rooms that were calling at that moment are marked in the list. The reasons are schedule, warming early, boost, hold, changed on the radiator, away and snooze. The table view's Boiler column says the same. Reasons are recorded from this version on; earlier heat-ups show without one.

Tap a room's name under the chart to pick it out (tap again to show all). Tap or hover for every room's value at that time, listed warmest first. Your choice of room and measure is remembered on each device.

Room temperatures and boiler runs come from Home Assistant's history, so the chart fills in straight away. Targets are recorded by the add-on from when it's installed; before that the chart shows the schedule.

Pick the gas cost sensor and the outside temperature in **Settings → Heating → Gas cost and outside**, or leave them on **Find automatically**. Any sensor that counts today's cost and resets at midnight works, such as Octopus Energy's "Current Accumulative Cost Gas". For outside, use a weather entity or an outdoor thermometer.

## Insights

The **Insights** tab shows the last 30 days:

- **Gas, last 7 days**, compared with the 7 days before.
- **Gas cost per day** as a bar chart. Costs come from Home Assistant's long-term statistics, so the history is there from the day you install.
- **Cost per cold degree.** A day's cold degrees are how far its average outside temperature fell below 15.5°. Dividing the cost by them takes the weather out, so a cold week doesn't look like a bad week. Weather entities only keep about 10 days of history, so this fills in over time (an outdoor thermometer sensor gives the full 30 days).
- **Boiler hours**, compared week to week once both weeks are recorded.
- **Rooms compared**: how fast each room warms, how much it overshoots, how early it now stops, how long it spent heating over the last week, and its average temperature. Useful for spotting a radiator that needs bleeding.
- **How good the predictions are**: see [When each room heats next](#when-each-room-heats-next).
- **How each room holds its heat**, from the last week of room, outside and boiler history in Home Assistant (so it has figures from the first day):
  - **Warms up**: how fast the room heats on a milder day and on a colder one (e.g. "2.1°/h at 12°, 1.3°/h at 4° outside"). Needs a few heat-ups on days at least 3° apart.
  - **Cools, 10° colder outside**: how fast it loses heat when it's 10° colder outside than the room, and how fast a 20° room cools on a 0° day. Only stretches with no heat at all count: not calling, the boiler off, and at least 45 minutes after its last heat so the radiator has cooled. A stretch ends if something else warms the room (sun, cooking, people).
  - **20° → 17° on a 5° night**: how long the room keeps its warmth once the heating's off.
  - **Heating per cold degree**: minutes of heating a day for each cold degree, over whole days. Lower means the room needs less heat for the weather. An always-open radiator counts the boiler's time for other rooms too.
  - **Holds heat**: well, about average or loses heat quickly, against the house's other rooms.
  - Callouts name the room that holds its heat best, the one that loses it fastest (worth checking for draughts, a window or trickle vent left open, or a radiator too small for the room), and the one cold days slow most.

  Cooling follows Newton's law: each hour a room loses a fixed share of the gap between it and outside, so it cools faster on colder nights. That share is what's measured, and the figures above all come from it. It needs an outside temperature (Settings) and two or more stretches with the heating off; overnight is ideal.

Comparisons only appear when both weeks have enough recorded days; otherwise the card says what's missing.

## Losing heat faster than usual

Every half hour the app works out each room's heat loss for each day (from its stretches with no heat, as in Insights) and keeps it for 60 days. If a room's last two days are 40% or more faster than its usual over the month before, it's worth a look: usually a window or trickle vent left open, or a new draught. It shows under **Needs attention**, in Insights ("45% faster lately"), and, if you turn it on, as a phone alert (Settings → Heating → Phone alerts, where the 40% can be changed). It needs at least four earlier days to compare with, and tells you once, then not again for three days.

## Phone alerts

In **Settings → Heating → Phone alerts** you can have Home Assistant notify a device when the heating comes on, when it goes off, and when a window looks open. Each alert has its own switch and its own device, chosen from your `notify` services: a phone running the Home Assistant app (`notify.mobile_app_…`), or a notify group to reach several devices at once. **Send test** sends a sample straight away.

The "on" alert names the rooms that fired the boiler and their temperatures. The "off" alert says how long the boiler ran. Alerts replace each other on the phone rather than stacking up. They follow the boiler's minimum run and rest times, so a boiler that cycles a lot will send a lot of alerts.

## Child locks

If a TRV has a child lock entity in Home Assistant (ZHA and Zigbee2MQTT usually create one), a **Child lock** switch appears next to it in the room's details, and **Settings → Heating → Rooms** can lock or unlock them all at once. Locked valves ignore their own buttons and dial, but the add-on can still set them.

## Setup

1. Open **Home** in the sidebar (it opens on Heating), go to **Settings** (the Heating group).
2. Under **Boiler**, pick your Hive thermostat (usually `climate.heating`, or `climate.<zone>_heating`).
3. Under **Rooms**, add each room, tick its TRVs, and optionally pick a room thermometer.
4. Go to **Schedules** and set each room's week. New rooms start with a typical weekday and weekend pattern.

### Before you switch on: disable your old heating automations

Your existing automations that turn the Hive thermostat up when a TRV calls for heat will fight this add-on. Disable them (Settings → Automations, toggle off) once the add-on is set up. Keep them for a week or two rather than deleting, in case you want to roll back.

### Hive's own schedules

With "Switch radiators to manual mode" on (the default), the add-on moves the Hive thermostat and Hive TRVs into manual mode so their schedules in the Hive app stop applying. Your Hive app schedules are not deleted; they come back into play if the add-on stops.

## Where your data is kept

Two places (for heating; lighting keeps everything in `lighting.json`):

- **Home Assistant's own history** (its recorder database, `home-assistant_v2.db` in your config folder unless you've moved it to MariaDB or similar). The add-on reads from it but never writes to it: room and valve temperatures, the boiler's on/off, outside temperature and gas cost. Detailed history is kept for 10 days by default; the daily statistics behind Insights are kept indefinitely.
- **The app's own folder** (`/data` inside the app; on the Home Assistant machine it's the Supervisor's data folder for this app). It isn't visible in File editor or Samba, but it is included in Home Assistant backups.

| File | What's in it | Kept for (Settings → History) |
|---|---|---|
| `heating.json` | Settings, rooms, schedules, current holds, boosts and snoozes, and what each room has learned (stop early, warm-up speed) | Always |
| `activity.json` | The Activity log | Activity log: 30 days to start with (1–365) |
| `daily.json` | Each day's totals: boiler hours, average outside temperature, each room's heating time and average temperature, gas cost | Daily totals: 400 days (30–1100) |
| `targets.json` | What each room was aiming for, for the 24-hour chart | Room detail: 7 days (1–90) |
| `calls.json` | When each room called for heat, for the room cards | Room detail, as above |
| `lighting.json` | Lighting: groups, schedules, scenes, settings and the lighting Activity log (last 300 entries) | Always |

**Settings → Heating → History** shows how much each uses. Lowering a number deletes the older records when you save. The Activity tab shows the latest 60 entries; **Show older** pages back through the rest. Home Assistant's own history isn't changed by these settings: set `purge_keep_days` under `recorder:` in Home Assistant's configuration for that.

Uninstalling the add-on can remove this folder, so take a backup first if you might want it back.

## Who can use it

The panel is visible to every Home Assistant user, not just admins, so give each person in the house their own HA login and they can use it from the Home Assistant app on their phone, at home or away (over your existing remote access).

## Troubleshooting

- **A room shows "No temperature reading"**: its TRVs and thermometer are all unavailable. It won't call for heat until a reading comes back.
- **Hive changes take a minute to show**: Hive is polled through the cloud. The add-on waits 3 minutes (configurable) before re-sending a command.
- **The screen looks out of date**: it updates live. If that connection drops without saying so (common when the Home Assistant phone app has been in the background), the panel refreshes as soon as you come back to it and reconnects by itself within about a minute. Anything you press updates the screen straight away either way.
- **The Activity tab** records every boiler start and stop, every room starting and stopping heating and why, boosts, schedule changes and changes made on a radiator. A room's start says what set it off ("Bathroom: heating, warming early to be 19° by 06:30: 18° now, and it warms about 1.8° an hour, so it started 50 min before. The boiler was already on for Main Bedroom", or "17.8° fell below 18.5°, where it starts", or a boost or hold) and its stop says where it got to ("warm enough at 18.7°, stopping 0.3° early so the radiators' leftover heat takes it to 19°, after 12 min"). **Heating on and off** shows just those and the boiler; **Changes** everything else. Hovering over a room's mini graph where it was heating says why too ("heating, warming early for 19°").

Settings and schedules are stored in the add-on's `/data` folder and are included in Home Assistant backups.

# Lighting

## First steps with lighting

1. Open **Home**, switch to **Lighting**, then **Settings → Add a group**, or start from one of your Home Assistant areas. A group can be a room, the Christmas lights or the outside sockets, and can mix lights and sockets. Each light or socket belongs to one group.
2. Open **Schedules**, pick a group and tap a day to add changes: a clock time or around sunset/sunrise, on or off, brightness and warmth where the light supports them, and an optional slow fade for waking up and winding down. Use **Also use for** and **Also use in** to copy to other days and groups.
3. Turn off any Home Assistant automations that already switch these lights on a timer. Toggle them off rather than deleting them so you can go back.

## How it behaves

- Changes at a wall switch, in the Home Assistant app or by voice are left alone until the group's next scheduled change. The Activity tab says who changed what.
- Changes made in this app last until the next scheduled change, or for 30 min to 4 h if you pick that in the group's details.
- Saving a schedule doesn't change any lights there and then: the new schedule takes over from its next change. To apply it straight away, open the group and press **Back to schedule**.
- A few seconds after switching a Zigbee light (ZHA), the app asks Home Assistant to read the light's real state back, so a bulb that ignored the command is caught and switched again. After switching a light off it checks again at 20 and 50 seconds: a light that comes back on by itself within a minute, with nobody behind it, is switched off again and Activity says so. A person at a wall switch more than a minute after the off is respected as usual. The Log tab has a line for every command and anything a light did by itself.
- **Away** keeps everything off, except groups set to look lived in, which come on a little after sunset and go off around a set time, varying each day. Away is shared with the heating: see [Away for the whole house](#away-for-the-whole-house).
- **All off** (with the scene buttons) switches everything off until each group's next scheduled change. Schedules keep running.
- A movement sensor can turn a group on for a few minutes when it would otherwise be off. A light-level sensor stops a group switching on when it's already bright.
- When the app stops or updates, lights and sockets are left exactly as they are. If a scheduled change was missed while it was stopped, it catches up on start.

## Scenes

Scenes are buttons at the top of the Lights page that set several groups at once. Make and edit them in **Settings → Scenes**. For each group you can leave it alone, turn it on at a brightness and warmth, or turn it off, and optionally only for a few minutes before it goes back to its schedule. A scene lasts until each group's next scheduled change, or "until the morning" (the first scheduled change after 05:00, which you can change).

A **Goodnight** scene is included: everything off until the morning.

To run a scene from Home Assistant (a dashboard button, an automation, or Alexa via a script), make a script:

```yaml
alias: Goodnight
sequence:
  - event: lighting_control_scene
    event_data:
      scene: Goodnight
```

Use `scene: All off` to switch everything off. The mode can be changed the same way with the `lighting_control_mode` event and `mode: away` or `schedules`. Because Away is shared, that sets the heating too (unless the heating is switched off). These event names are unchanged from Lighting Control, so existing scripts keep working.

## Seasons and night-time movement

In a group's settings:
- **Season**: run the schedule only between two dates each year. Outside them the schedule sleeps and the group is left alone.
- **Use a lower level at night**: movement turns the group on at a lower brightness between two times.

# Cameras

Cameras start off. Turn them on in **Settings → General → What it looks after**, then add your cameras in **Cameras → Settings → Add a camera**.

Any camera Home Assistant knows about can be added: UniFi Protect, Reolink, Ring, Frigate, Tapo, Hikvision, Amcrest, Nest, Blink, ONVIF and generic RTSP cameras among them. Home Control uses what Home Assistant already has for each camera, so there's nothing to set up per make:

- **Pictures** come through Home Assistant, every 10 seconds while the Cameras page is open. Tap a picture for Home Assistant's own live view.
- **Movement** comes from the camera's own sensors in Home Assistant (motion, person, vehicle, animal, package, the doorbell). In a camera's settings, choose which of them count: untick plain motion to be told only about people, vehicles or the doorbell.
- **Camera settings** (the button on each camera) are the camera's own switches and choices in Home Assistant, grouped in plain words: privacy, recording, detection, night vision and picture, lights and sound, moving the camera, and the device itself. What's there depends on the make: UniFi Protect and Reolink offer a lot, Ring rather less, a plain RTSP camera nothing.

## Alerts

Movement alerts go to the phones chosen in **Cameras → Settings → Phones to alert**: phones with the Home Assistant app are listed first. With **Send a picture with each alert** on, the alert carries a picture from the camera at that moment (on iPhones, a long press shows the live view). Tapping it opens the Cameras page.

Each camera alerts on its own schedule:

- **Always**
- **When everyone's out**: whenever the house is on Away, set by hand or by Away automatically (Settings → General).
- **Between set times**, such as 23:00 to 06:30.
- **When everyone's out, or between set times**
- **Never**

New cameras start on "when everyone's out". The bell on each camera on the Cameras page turns its alerts off and on again without losing its schedule. **At most one alert every (minutes)** stops a busy scene (a cat in the garden) sending one alert after another; movement is still saved in between.

Alerts say what was seen, most specific first: "Someone at the door", "Person seen", "Vehicle seen", "Animal seen", "Package seen", or "Movement".

**Offline cameras**: a camera that's been offline for a while (5 minutes to start with) is reported to the same phones, and again when it's back. A camera can be left out of these in its own settings.

A camera counts as offline when Home Assistant shows it as unavailable, or when its own integration's "connected" sensor (Amcrest, Axis and Hikvision cameras have one) says it's disconnected, and its pictures have stopped coming. The Cameras page says which, under **Offline** on the camera and in its **Camera settings**. Sensors from other integrations that Home Assistant has put on the same device, such as a network tracker, don't count.

Some integrations (UniFi Protect among them) can show a camera as unavailable while it's working. When Home Assistant says a camera is down, Home Control looks at its pictures every minute: while they keep changing, the camera counts as online and its Camera settings say what Home Assistant shows. Home Assistant won't record from a camera it shows as unavailable, so until it shows it as working again only pictures are saved, and Activity says so. Reloading the camera's integration (Settings → Devices & services) usually puts it right.

Phones are told about an offline camera once, even if Home Control restarts in between. A camera that's already offline when you add it isn't reported.

## Recordings

On movement, a picture and a short clip (30 seconds to start with, starting 5 seconds before the movement) are saved in Home Assistant's media folder, under **Media → home_control**, and play from the **Activity** page. Each camera has its own schedule for this, with the same choices as alerts; new cameras save always.

- Clips need the camera to give Home Assistant a video stream. Cameras that don't (some cloud and battery cameras) save pictures only, and Activity says so once.
- Clips and pictures are deleted after 14 days (**Cameras → Settings → Recordings**).
- This is in addition to anything the camera or its own app records (a UniFi or Reolink recorder, an SD card, a cloud plan), which carry on as they are. The camera's own recording mode is usually under its **Camera settings → Recording**.

## Cameras on a dashboard

The Home Control card can show the cameras:

```yaml
type: custom:home-control-card
show: cameras
```

Each camera's picture (tap it for the live view), whether it's offline or seeing movement, and its last movement. Up to four of a camera's own settings can be put on the card to switch from there, such as a floodlight, a siren or privacy mode: choose them in the camera's settings under **On the dashboard card**.

`sensor.home_cameras` has how many cameras are online, a `summary` ("All 4 cameras online. Last movement: Driveway, 21:42"), `away`, and `cameras`: each camera's `name`, `entity`, `online`, `moving`, `last_movement`, `alerts_now`, `recording_now` and the `controls` chosen for the card.

# Wi-Fi

Wi-Fi starts off. Turn it on in **Settings → General → What it looks after**. It uses Home Assistant's **UniFi Network** integration (Settings → Devices & services → Add integration → UniFi Network, signed in with a local admin account on your UniFi console), so there's nothing else to set up: your access points, networks and the devices on them appear straight away.

## Access points

Each access point with its model, whether it's online, how many devices are on it (tap the number to see them), how long it's been up, and whether a firmware update is waiting. On each:

- **Light on / Light off** switches its status light. **All lights off** and **All lights on** do every access point and switch at once.
- **Restart** restarts it. Devices on it drop off for a minute or two and move to another access point if they can.
- **Switch off / Switch on**, once you've chosen the PoE port it's plugged into (below).

Under the count, each access point lists the devices on it, with the network and band each is using (the first six, and **Show all** for the rest). Its count comes from UniFi, so it can include devices Home Assistant isn't tracking; the list says how many (see **Track them all** under Devices).

Switches, the gateway and other UniFi devices are listed under **Other network devices**, with their lights and a restart button. Which is which is worked out from each device's model; change it in **Wi-Fi → Settings → What each device is**, or hide a device.

### Switching an access point off

Home Assistant's UniFi Network integration can't switch an access point itself off, but it can turn off the PoE port on the UniFi switch (or gateway) that powers it, which does the same. In **Wi-Fi → Settings → Access points**, choose the port each access point is plugged into: the ports on the switch it's connected to are listed first. Home Assistant keeps PoE ports turned off to start with; choosing one here turns it on in Home Assistant, which takes about a minute.

An access point can then be switched off from its card, and **off between two times** each day (a garden access point overnight, say). An access point powered by a PoE injector, or a switch that isn't UniFi, can't be switched off from here.

## Networks

Each Wi-Fi network with a switch to turn it off and on everywhere, how many devices are on it, and its schedule. Turning a network off asks first: devices on it drop off until it's back, and if this page reaches you over that network, you'll lose it.

Each network lists the devices on it, with the access point and band each is using, in the same way.

**QR code to join** shows a code a phone's camera can read to join the network: handy for guests. The code holds the network's password, so share it with people you'd give the password to. Home Assistant keeps these codes turned off to start with; the first time, Home Control asks it to turn the code on, which takes about a minute.

## Devices

Everything on the network: its name, which network and access point it's on, 2.4, 5 or 6 GHz, its address and maker, or when it was last seen. Filter by network or access point, show everything seen recently as well as what's connected now, or search by name, address or maker.

- **Track them all.** Home Assistant's UniFi Network integration only tracks devices it already knows about (from another integration), and keeps the rest turned off. Home Control says how many, and **Track them all** turns them on in Home Assistant, adding a device tracker for each. You can turn any of them off again in Home Assistant.
- **Block.** A device in the UniFi Network integration's list of devices to block (in Home Assistant: Settings → Devices & services → UniFi Network → Configure) gets a **Block** button here, and **Allow** to let it back on.

Devices seen by other router integrations in Home Assistant (a Fritz!Box, Netgear or nmap, say) are listed too.

## Schedules

In **Settings**:

- **Status lights at night**: the lights on the access points and switches go off at the first time and back on at the second, every day. Choose which devices, or leave them all ticked.
- **Network schedules**: each network can be **off between two times** (a children's network overnight) or **on only between two times** (a guest network in the day).
- **Access points**: off between two times, once its PoE port is chosen.
- **Connected devices**: list the devices on each access point, on each network, and on the dashboard card. The first two start on, the card off.

Each change is made once, at its time (or when the device is next online, if it isn't then). Switching something by hand in between is left alone until the next scheduled change. Saving a schedule puts things as it says right away. Everything the schedules do, and every change made here, is listed on **Activity**.

## Wi-Fi on a dashboard

```yaml
type: custom:home-control-card
show: wifi
```

Each access point with how many devices are on it and a button for its status light, and each network with a button to turn it off and on (turning one off takes a second tap, so it can't happen by accident). With **List them on the dashboard card too** on (Wi-Fi → Settings → Connected devices), the names of the devices on each are under it. Tap the title to open the Wi-Fi pages.

`sensor.home_wifi` has how many devices are connected, a `summary` ("3 access points online · 24 devices connected"), `leds_schedule`, `access_points` (each one's `name`, `model`, `online`, `switched_off`, `clients` and `led`) and `networks` (each one's `name`, `entity`, `on` and `clients`), and each one's `devices` (names) when they're listed on the card.
