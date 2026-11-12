---
name: utilities-time
description: Exact answers for times, time zones, dates, public holidays and working days, and polled project timers, from Utilities' offline tools. Use it for "what time is it in Tokyo", "3pm London in New York", "is Monday a bank holiday", "how many working days in March", "the next business day after a given date", "90 days from today", or a project timer to check, instead of counting yourself, the shell's date, or a web search. Not for weather or forecasts: use utilities-weather for those.
---

# Time, dates and timers

Use the Utilities time tools below whenever a date or time matters. Mental arithmetic and the shell's `date` get daylight saving, holidays and weekday counts wrong.

Call shapes (`?` is optional): `status({})`, `time_now({timezones?, format?})`, `time_zones({region?})`, `time_zone_info({timezone})`, `time_convert({datetime, from_timezone, to_timezone})`, `time_calendar({date})`, `time_add({date, operation, amount, unit})`, `time_between({from, to})`, `time_format({input, output_format})`, `time_holidays({mode: "check", date, country, region?} | {mode: "list", year, country, region?})`, `time_business_days({mode: "between", from, to, country?, region?} | {mode: "next" | "prev", date, country?, region?})`, `timer_set({name, deadline, description?, tags?, replace?})`, `timer_get({name})`, `timer_list({tag?, offset?, limit?})`, `timer_check({offset?, limit?})`, `timer_delete({name})`.

## Times and zones

- **Now:** `utilities_time_now` with `timezones: ["Asia/Tokyo"]`. It defaults to UTC, so pass the zones the user means. Its `machine_timezone` is this machine's zone: use it for "here" or "my time", unless the user is elsewhere. It also gives today's date, so don't assume the year.
- **Converting:** `utilities_time_convert` with the local `datetime` and both zones. At a daylight-saving change it never guesses, and neither should you:
  - `TIME_AMBIGUOUS`: the local time happens twice, and the error gives both offsets. Give the user both results, or ask which one they mean, then call again with that offset on the `datetime`, such as `2026-10-25T01:30:00+01:00`.
  - `TIME_NONEXISTENT`: the clocks skip that time. Say so, and suggest a time outside the change.
  - `TIME_OFFSET_MISMATCH`: the offset isn't the zone's at that moment. Drop it, or use the zone's own.
- **Zone names:** `utilities_time_zones` with a `region` such as `Europe`; `utilities_time_zone_info` for offsets and the next change.

## Dates

`utilities_time_calendar` (weekday, ISO week, quarter), `utilities_time_add` ("90 days from today"; month steps clamp to the month's end), `utilities_time_between`, `utilities_time_format` (`epoch` is a Unix timestamp).

A date-time without `Z` or an offset is read as UTC. For "3 pm my time", add the user's offset first (`utilities_time_convert` gives it), or the result is hours off.

## Holidays and working days

- `utilities_time_holidays`: `{mode: "check", date, country}` or `{mode: "list", year, country}`.
- `utilities_time_business_days`: `{mode: "between", from, to, country}` counts working days, both dates included. `{mode: "next" | "prev", date, country}` finds the nearest one. Weekends are Saturday and Sunday. With `country`, it also skips that country's nationwide holidays.
- **Coverage is 2000 to 2030.** Outside it, the call fails with `INPUT_INVALID` or `HOLIDAY_COVERAGE`. Say the data can't check that year. Don't shift to another year. Label anything you add from memory as general knowledge, not a checked result.

**The UK (`GB`) needs `region`.** Easter Monday and the August bank holiday are regional (England, Wales, Northern Ireland), as are Scotland's own days, so a count with only `country: "GB"` treats them as working days. That is wrong for every nation.
- Pass `region` (`England`, `Wales`, `Scotland` or `Northern Ireland`).
- If you don't know the nation, ask, or give one figure per nation (one call each) and name the holiday that differs.
- If a result's `regional_holidays_not_skipped` is not empty, say which days it holds.

Example: working days in April 2026 for a London team means `{mode: "between", from: "2026-04-01", to: "2026-04-30", country: "GB", region: "England"}`. Without `region`, Easter Monday (6 April) would count as a working day.

## Timers

Timers belong to the current project and never alert on their own: they are checked, not pushed.

1. `utilities_timer_set` with a `name` and a `deadline` that has `Z` or an offset, such as `2026-11-02T09:00:00+01:00`. For "9 tomorrow", take the date from `utilities_time_now` and the offset of the user's zone (`machine_timezone`, unless they said another) from `utilities_time_convert`. By default it runs. With `access: "ask-changes"` it asks, and `read-only` refuses it. A timer does not wake an agent: check it with `utilities_timer_check`.
2. `TIMER_EXISTS`: ask the user before you overwrite it with `replace: true`, or choose another name.
3. `utilities_timer_check` shows what is due or overdue. Call it when the user asks about reminders. `utilities_timer_get`, `utilities_timer_list` (optionally by `tag`) and `utilities_timer_delete` manage them.
4. If the timer state is unknown (`TIMER_STATE_UNKNOWN`), read the timer before you retry.

For an alert that fires by itself, suggest OpenCode's `schedule_*` tools, which need `"experimental": { "schedules": true }` in `opencode.json`.

A cron job can call the read tools (not timer writes) with no model, through the RPC `utilities.local.tools`. It uses a session created for it (`opencode api post /api/session …`, keep `data.id`), and so does a test of a script. Never borrow a session found through history or a session list: the script would run as that session's agent, under its rules. Details: https://raw.githubusercontent.com/joe-broadhead/opencode-utilities/HEAD/docs/scripting.md.
