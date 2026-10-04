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
- **One day's scores** (`getPWHLScores`): the season is resolved from the **exact date** instead.
  Merging every season overlapping the year would feed several seasons to the record replay and total
  them into one tally. `getPWHLSeasonsForDate()` returns two entries:
  - `gameSeason` — the entry whose span covers the date (regular season first, then playoffs, then
    pre-season when two entries overlap). Its schedule provides the day's games.
  - `recordSeason` — the **regular season** a W-L-OTL comes from: the one covering the date, or, on a
    playoff date, the most recent regular season that ended before it.

Without an explicit `season_id` the feed silently answers with its **default** season (currently the
2026-27 pre-season, 12 games all in the future), which is why a past date used to yield neither games
nor records.

## Score Mapping

Completed games use HockeyTech's official final markers (`final`, status `4`, or a `Final`
status string). Scores are preserved even when one team has zero goals.

## Records on a Game (`homeTeamRecord` / `awayTeamRecord`)

HockeyTech exposes no per-game cumulative record, so `applyPWHLHistoricalRecords()` replays a season:
finished games are walked chronologically and each team's W/L/OTL is incremented (OT/SO loss when
`overtime`/`shootout` is set or the status mentions OT/SO). Following the ESPN leagues, a **finished**
season shows its final tally on every one of its games, while a season still in progress leaves the
record empty so the reader falls back to the live `team.record`.

Playoff games stay out of the tally because the replay is always fed a **regular season** schedule —
**not** because of the `isPlayoff` guard, which never fires: `game_type` is an empty string in both
the regular-season and the playoffs feeds today.

## Team Records (`teamRecords`)

`getHockeySchedule(activeTeams, leagueLogos, league, forceUpdate, season?, teamRecords?)` accepts an
optional `teamRecords` map, filled for the **current** season only (`season === undefined`) and only for
`League.PWHL`. It goes through `collectPWHLTeamRecords()` and writes `PWHL-<CODE>` → `"W-L-OTL"`:

1. **Primary source** — HockeyTech's official standings (`getPWHLStandings()`), which resolves the
   current regular season on its own and already normalizes OT/SO wins and losses.
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
