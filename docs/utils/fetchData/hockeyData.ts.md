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
  `getPWHLSeasonsForDate()` returns **every** entry whose span covers it — a date can sit inside two
  groups at once, 2024-11-25 → 29 is both pre-season and regular season — and each entry is fetched
  and replayed **on its own**, so a pre-season, a regular season and a playoff run are never totalled
  together. The default season is only used as a fallback, when nothing covers the date or the
  seasons feed fails.

Without an explicit `season_id` the feed silently answers with its **default** season (currently the
2026-27 pre-season, 12 games all in the future), which is why a past date used to yield neither games
nor records.

When no explicit `season_id` is supplied, `getPWHLSeasonIds()` now resolves the **current season** (the one active on the current date, or the upcoming season if we are still between seasons) and returns all its phase‑specific `season_id`s (pre‑season, regular, playoffs). The resolved `season_id`s are then passed explicitly to the schedule request, so the API never falls back to its default feed. If the current date falls between seasons, the helper picks the earliest upcoming season and returns all of its phases.

## Score Mapping

Completed games use HockeyTech's official final markers (`final`, status `4`, or a `Final`
status string). Scores are preserved even when one team has zero goals.

## Records on a Game (`homeTeamRecord` / `awayTeamRecord`)

HockeyTech standings are the primary source for game records. `getPWHLScores(date)` resolves the
record phase from the exact date: pre-season and regular-season games use their own phase, while
playoff games use the regular season that ended before them. It never relies on the feed's default
season for a historical date.

The phase schedule is replayed to distinguish a phase with no finished game (`0-0-0`) from one in
progress. For a phase with completed games, official standings are preferred; when unavailable,
`applyPWHLHistoricalRecords()` calculates the tally from only that phase's finished games and
handles overtime/shootout losses. Pre-season, regular-season, and playoff game records are never
mixed. Playoff game dates display the corresponding regular-season record, not a playoff-only tally.

During the PWHL oldies fetch, `getPWHLRecordsForDates()` batches stored game dates by record-phase
`season_id`, requests standings or replays the phase schedule once per season, and applies the
resulting records before oldies inserts or corrects each game document.

`GameService.syncGameWithScore()` preserves both supplied PWHL records on the game and does not write
historical phase values to the current `team.record`. When the current phase has no standings for a
team, the schedule replay supplies its phase-specific record.

## NHL historical records

NHL schedules expose `gameType` (pre-season, regular season, or playoffs), game state, final scores,
and overtime/shootout period information, but not an authoritative cumulative record per game.
Historical fetches replay distinct NHL games in date order and calculate records independently for
each game type. Completed pre-season and regular-season records are normalized to the phase final;
playoff records remain game-specific so they progress from one game to the next. The temporary NHL
schedule fields used for this replay are removed before games are returned.

## Team Records (`teamRecords`)

`getHockeySchedule(activeTeams, leagueLogos, league, forceUpdate, season?, teamRecords?)` accepts an
optional `teamRecords` map, filled for the **current** season only (`season === undefined`) and only for
`League.PWHL`. It goes through `collectPWHLTeamRecords()` and writes `PWHL-<CODE>` → `"W-L-OTL"`:

1. **Primary source** — HockeyTech's official standings (`getPWHLStandings()`), which already
   normalizes OT/SO wins and losses. Without an explicit `season_id`, it resolves the record season
   **by date**: the regular season covering today, else the most recent one already ended. This avoids
   relying on the feed's ordering, which previously selected the oldest season and returned stale
   records.
2. **Fallback** — the local replay of the relevant regular-season schedule
   (`applyPWHLHistoricalRecords()`) when the standings feed is empty or throws, so a single failing
   source cannot leave the PWHL without records.

3. **Team schedule matching** — when fetching a team's schedule, the API compares `home_team_code`
   and `visiting_team_code` against the requested team code **case‑insensitively**, so `MTL`
   matches `mtl` and vice‑versa. This prevents missing matches due to inconsistent casing in the
   HockeyTech feed.

4. **PWHL team-code aliases** — the feed is internally inconsistent about the Las Vegas team: the
   `teamsbyseason` feed and the **pre-season** schedule use `VEG`, while the **regular-season**
   schedule and its standings use `VGS` (and `LV` has appeared too). `normalizePWHLCode()` folds
   every known alias onto the canonical `VGS` — the regular-season code, since that feed carries by
   far the most games — at every read site (teams feed, standings, schedule
   filter, `getPWHLTeamschedule()`, the record replay and `getPWHLScores()`), so the same team keeps
   a single id (`PWHL-VGS`), logo, colour, favourite and record across all feeds.

This is what makes `GameService.refreshCurrentSeasonRecords()` (the twice-daily records cron) work for
the PWHL: unlike the ESPN leagues, the HockeyTech schedule carries **no** per-game record, so the map
would otherwise stay empty and no `team.record` would ever be written. During **oldies** (`season`
given) the map is deliberately left untouched so the historical record stays frozen.

## Team Colors

`getHockeySchedule()` logs one fetched-game count per NHL/PWHL team and concludes with the number of team schedules processed and distinct games found.

NHL and PWHL teams resolve their colors through `getTeamColors()` from `../Colors`:
the stored `ColorsTeam` entry wins, otherwise the generic default placeholder
(`#ffffff` on `#000000`) is used. Non-college leagues never borrow colors from
another league.
