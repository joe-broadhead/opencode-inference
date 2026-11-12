---
name: utilities-weather
description: Current weather and forecasts for a place from Open-Meteo through Utilities' weather tools, with the attribution Open-Meteo requires. Use it for "what's the weather in Lisbon", "will it rain this weekend", "forecast for Tuesday", "how windy will it be tomorrow", hourly or 16-day outlooks, and whether the free tier allows business use, instead of a web search or a weather website.
---

# Weather

Weather comes from Open-Meteo over the network. By default the call runs. A user rule can still deny it.

Call shapes (`?` is optional): `weather_geocode({query, country?, count?})`, `weather_current({location, country?})`, `weather_daily({location, country?, days?})`, `weather_hourly({location, country?, hours?})`, `weather_demand_signal({location, country?, days?})`, `weather_summary({location, country?, days?})`.

## When the user declines

If the permission is declined, say that no weather was fetched, and stop. Don't get the weather another way (a web search, another site, or `api.open-meteo.com` through a fetch tool), because that goes around the user's choice. They can allow the call next time, or allow `utilities_weather_*` in their permissions.

## Pick the place

- A clear name, such as "Lisbon", or coordinates such as `"38.72,-9.14"`, goes straight into `location`. Add `country` (for example `PT`) when it helps.
- **For a name several places share,** such as "Springfield" or "Portland", call `utilities_weather_geocode` first. Show the matches and let the user choose (or say which one you chose and why), then pass its coordinates as `"lat,lon"`. Don't guess and retry.

## Choose the tool

- **Now:** `utilities_weather_current`.
- **Named days** ("this weekend", "Friday"): `utilities_weather_daily`, with `days` large enough to reach the last day asked (today is day 1). Get today's date and weekday from `utilities_time_now` or `utilities_time_calendar` first; don't assume them.
- **The next hours:** `utilities_weather_hourly` with `hours` (48 by default). Use it only for today or tomorrow, not for days ahead.
- **A quick outlook:** `utilities_weather_summary` gives a headline and counts of wet, hot or windy days.
- **Planning** (staffing, events): `utilities_weather_demand_signal` gives daily values with flags such as `rain_likely` and `hot_day`. The flags are fixed thresholds, not predictions.

## Read the result

- Every `time` and date is local to the result's `timezone`, the place's own zone, not UTC.
- Units are in `units`. For rain, give `precipitation_probability_max` (%) and `precipitation_sum` (mm) per day.
- `null` means the reading is unavailable. Say so; don't treat it as zero.
- Credit every answer that uses the data: "Weather data by Open-Meteo.com (CC BY 4.0)".

## Free tier and business use

Without a key, Open-Meteo's free tier is for non-commercial use only and is rate-limited. Business use, such as a shop's staffing sheet, needs an Open-Meteo API key: the user runs `/connect` and chooses Open-Meteo. The key goes nowhere else: not in an environment variable, and not in the plugin options. `utilities_status` shows the tier in use and whether the key works. Answer such questions from it, with no weather call.

## Errors

- `BACKEND_FAILED`, "found no place with that name": check the spelling, add `country`, use `utilities_weather_geocode`, or pass coordinates.
- `BACKEND_FAILED`, "rate limit was reached": tell the user and wait. Don't loop.
- `WEATHER_KEY_REJECTED`: the user runs `/connect` again with a valid key, or `opencode auth logout open-meteo` for the free tier.

A script can call the weather tools with no model, through the RPC `utilities.local.tools`. It uses a session created for it (`opencode api post /api/session …`, keep `data.id`), and so does a test of a script. Never borrow a session found through history or a session list: the script would run as that session's agent, under its rules. A script can't answer a prompt, so it needs an allow rule, such as `{"action": "utilities_weather_daily", "resource": "*", "effect": "allow"}`, in its session's agent or in the session. Details: https://raw.githubusercontent.com/joe-broadhead/opencode-utilities/HEAD/docs/scripting.md.
