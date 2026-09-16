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

## Team Colors

NHL and PWHL teams resolve their colors through `getTeamColors()` from `../Colors`:
the stored `ColorsTeam` entry wins, otherwise the generic default placeholder
(`#ffffff` on `#000000`) is used. Non-college leagues never borrow colors from
another league.
