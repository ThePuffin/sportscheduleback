# File: `backend/src/utils/fetchData/hockeyData.ts`

## Purpose

Provides NHL and PWHL team, schedule, standings, and score data adapters.

## PWHL Historical Seasons

Historical requests resolve a calendar year to all overlapping HockeyTech `season_id` values,
then filter returned games to the requested calendar year. This supports regular seasons and
playoffs while avoiding the provider's default preseason response.

## Score Mapping

Completed games use HockeyTech's official final markers (`final`, status `4`, or a `Final`
status string). Scores are preserved even when one team has zero goals.

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
