# File: `backend/src/utils/fetchData/hockeyData.ts`

## Purpose

Provides NHL and PWHL team, schedule, standings, and score data adapters.

## PWHL Historical Seasons

HockeyTech gives **pre-season, regular season and playoffs their own `season_id`**, and several of
them overlap the same calendar year — 2025 is covered by the 2024-25 regular season, the 2025
playoffs, the 2025-26 pre-season _and_ the 2025-26 regular season. Two different resolution rules
follow from that.

- **Whole-season history** (`fetchGamesData`, oldies): a calendar year is resolved to **all**
  overlapping `season_id`s and their schedules are merged, then games are filtered to the requested
  year. Merging is safe here — every game belongs to exactly one feed, so nothing is double counted.
- **One day's scores** (`getPWHLScores`): the seasons are resolved from the **exact date**.
  `getPWHLSeasonsCovering()` returns **every** entry whose span covers it — a date can sit inside two
  groups at once, 2024-11-25 → 29 is both pre-season and regular season — and each entry is fetched
  and replayed **on its own**, so a pre-season, a regular season and a playoff run are never totalled
  together. The default season is only used as a fallback, when nothing covers the date or the
  seasons feed fails.

Without an explicit `season_id` the feed silently answers with its **default** season (currently the
2026-27 pre-season, 12 games all in the future), which is why a past date used to yield neither games
nor records.

## Score Mapping

Completed games use HockeyTech's official final markers (`final`, status `4`, or a `Final`
status string). Scores are preserved even when one team has zero goals.

## Records on a Game (`homeTeamRecord` / `awayTeamRecord`)

HockeyTech exposes no per-game cumulative record, so `applyPWHLHistoricalRecords(group, asOf?)`
replays a **single group**: the pre-season, the regular season or the playoffs the game belongs to.
Finished games are walked chronologically and each team's W/L/OTL is incremented (OT/SO loss when
`overtime`/`shootout` is set or the status mentions OT/SO).

- the group is **finished** → its final tally, copied onto every one of its games, matching what the
  ESPN leagues do;
- the group is **still running** → the tally of everything played **before** the game (`asOf`), so a
  mid-season game carries the record it actually took the ice with rather than an empty string.

The three groups have their own numbers by construction: a playoff run shows a playoff record (e.g.
`6-1-1`), never the regular-season one that preceded it. `seasonOver` is always computed over the
whole group, never over the `asOf` slice — the two answer different questions.

**Current group exception:** when the requested date falls inside the season covering today
(pre-season, regular season **or** playoffs), the replay is skipped and records come from the
official standings feed (`getPWHLStandings()`), called with the covering season's `season_id`
explicitly — passing nothing would fall back to the regular-season resolution, which finds no
regular season during a pre-season and would leave every record empty. This preserves the
behaviour from before the historical replay was introduced: the current group always shows the
live tally, the replay only fills in past groups.

The `isPlayoff` guard in the replay never fires (`game_type` is an empty string in every feed):
it is the **group selection**, not that guard, that keeps the tallies apart.

## Team Records (`teamRecords`)

`getHockeySchedule(activeTeams, leagueLogos, league, forceUpdate, season?, teamRecords?)` accepts an
optional `teamRecords` map, filled for the **current** season only (`season === undefined`) and only for
`League.PWHL`. It goes through `collectPWHLTeamRecords()` and writes `PWHL-<CODE>` → `"W-L-OTL"`:

1. **Primary source** — HockeyTech's official standings (`getPWHLStandings()`), which already
   normalizes OT/SO wins and losses. It takes the `season_id` of the teams' own season; without one,
   `resolveCurrentRegularSeason()` picks it **by date**: the regular season covering today, else the
   most recent one already ended, else the closest upcoming one. (It used to be
   `[...seasons].reverse().find(...)`, which — the feed being listed most recent first — walked them
   **oldest first** and returned the 2024 inaugural season, so every PWHL team record was a two-year-old
   24-game tally.)
2. **Fallback** — the local replay of the schedule (`applyPWHLHistoricalRecords()`) when the standings
   feed is empty or throws, so a single failing source cannot leave the PWHL without records.

This is what makes `GameService.refreshCurrentSeasonRecords()` (the twice-daily records cron) work for
the PWHL: unlike the ESPN leagues, the HockeyTech schedule carries **no** per-game record, so the map
would otherwise stay empty and no `team.record` would ever be written. During **oldies** (`season`
given) the map is deliberately left untouched so the historical record stays frozen.

## Team Colors

NHL and PWHL teams resolve their colors through `getTeamColors()` from `../Colors`:
the stored `ColorsTeam` entry wins, otherwise the generic default placeholder
(`#ffffff` on `#000000`) is used. Non-college leagues never borrow colors from
another league.
