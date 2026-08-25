# Backend Architecture & Recent Changes

> **📚 Per-file documentation:** For AI-readable documentation of backend modules, see the [docs](./docs/) directory. Each file has a matching Markdown explanation of its purpose, key features, responsibilities and data flow.

---

## Added: cron oldies refresh is season-aware (dry-run comparison, no-op when complete)

### Purpose

The daily `getOldGames` cron used to pick a random year+league and unconditionally refresh
that season, even when the DB already had every game. It is now aware of what it still lacks.

### Changes

- **`GameService.getSeasonStatus(league, season?)** (`backend/src/games/games.service.ts`):
  does a **dry run** — it fetches a league+season's games from the source (same pipeline as a
  real refresh) **without saving anything** — then compares the number of obtained games against
  how many of those `uniqueId`s are already stored in the DB. Returns
  `{ league, season, obtained, stored, complete }`. It also reports `isCurrentSeason`:
  a season is the current/upcoming one when no `season` is given, or when `isCurrentSeason`
  matches for a representative date in that season (June 30). **For the current season the
  comparison is not trusted** (`complete` is always `true`) because a partial live DB is normal.
- **`GameService._fetchUniqueGames(league, season?)** (new private helper): extracts the
  fetch + flatten + `uniqueId` deduplication logic previously inlined in `getLeagueGames`, and
  is now shared by `getLeagueGames` (which saves) and `getSeasonStatus` (which doesn't).
- **`CronService.getOldGames`** (`backend/src/cronJob/cronJob.service.ts`): now
  1. picks a **random league**;
  2. loops over the last `maxYearBeforeDelete` years, most recent first;
  3. for each year, calls `getSeasonStatus`:
     - **current/upcoming season** → always refreshed (it is still in progress);
     - **past season** and `complete` (obtained counts == DB counts) → **skipped without
       modifying anything**, move to the next year;
     - **past season** and not complete → that year is refreshed via `getOldiesGames`;
  4. **if every year was already complete, it finishes without any modification**.

### Result

The cron avoids re-fetching **past** seasons whose games are already fully stored, and only
refreshes the past years where some games are missing. The **current season is always
refreshed** (a partial DB is expected mid-season). The PWHL pre-2024 years are naturally
treated as "complete" (they are a no-op).

---

## Added: `refresh/oldies` without a year loops over the last N seasons

### Purpose

`GET`/`POST /games/refresh/oldies` previously required a mandatory `year` query parameter;
omitting it raised a `400` error (`NaN`). It is now optional.

### Changes

- In `GameService.getOldiesGames(yearStr?, leagueParam?)` (`backend/src/games/games.service.ts`),
  when `year` is omitted/blank the method loops over the last `maxYearBeforeDelete` seasons
  (5 years), from the most recent to the oldest allowed, instead of requiring a single year.
  An explicit `year` still triggers the historical limit validation and processes a single year.
- `GamesController.refreshOldies` now types `year` as optional (`@Query('year') year?: string`).

### Result

`POST /games/refresh/oldies?league=PWHL` (no year) now recovers PWHL data for the last 5 years,
while `POST /games/refresh/oldies?year=2024&league=PWHL` still targets a single year.

### Note: PWHL pre-2024 seasons are a no-op

The PWHL debuted in 2024. `getLeagueGames` now early-returns (logs + exits) when it is called
for `League.PWHL` with a `season` earlier than 2024, so looping over the last 5 years for PWHL
silently skips the years 2020-2023 instead of making pointless API calls.

---

## Fixed: PWHL previous-season results could never be recovered

### Problem

Requesting past seasons via the `refresh/oldies` endpoint (or the cron job) returned no
PWHL data. In `backend/src/utils/fetchData/hockeyData.ts`, the PWHL branch of
`fetchGamesData()` called the schedule API **without** a `season_id` query parameter, so the
API fell back to its default season. The current default is `season_id=10` (`2026-27
Pre-Season`) whose schedule is **empty**, and the `season` (year) parameter was never
translated into a HockeyTech `season_id` — so previous years produced zero games.

### Changes

- `fetchGamesData()` now resolves the requested year to the relevant PWHL `season_id`(s) and
  appends `&season_id=...` to the schedule request. Without a year, it still requests the
  current/latest regular season instead of relying on the API default.
- Added `HockeyData.getPWHLSeasons()` (fetches the PWHL seasons list) and
  `HockeyData.getPWHLSeasonIds(year?)` which maps:
  - a calendar `year` → every season whose date span overlaps that year (a PWHL season spans
    two years, e.g. `2024` → `2024 Regular` + `2024 Playoffs` + `2024-25 Regular`);
  - no year → the currently live season, falling back to the most recent regular season.
- In `getPWHLTeamschedule()` for PWHL, the historical year filter was tightened from
  `gameYear !== season && gameYear !== season + 1` to `gameYear !== season` so a requested
  calendar year only returns games actually played that year (no spill-over into the next year).

### Result

`POST /games/refresh/oldies?year=2024&league=PWHL` (and equivalent 2025/2026 requests) now
returns PWHL results, and normal refreshes no longer silently return an empty schedule during
the off-season / pre-season period.

---

## Fixed: Live games being marked as FINISHED (e.g. WNBA halftime)

### Problem

A WNBA game at halftime (match id `401857125`) was incorrectly displayed as finished. The bug had two root causes in `backend/src/utils/fetchData/espnAllData.ts`:

1. **Regex false positive on `HALFTIME`**: The status detection regexes used `/final|completed|post|full|time|finished/i`. The `time` alternative matched ESPN's `STATUS_HALFTIME` (and `STATUS_HALFTIME` variants), causing `isFinal` to be `true` for games that were merely at halftime.

2. **`gameStatus` forced to `FINISHED` when both scores present**: In `getEachTeamSchedule`, the `gameStatus` IIFE returned `'FINISHED'` whenever both team scores were non-null, without checking the explicit status. A live game with a score (e.g. 35-30 at halftime) was therefore saved as `FINISHED`.

### Changes

- Removed the `time` alternative from the three final-status detection regexes in `getESPNScores` (both the scoreboard path and the summary/detail path) and in `getESPNGameScore`. The regexes are now `/final|completed|post|full|finished/i`.
- Updated the `gameStatus` IIFE in `getEachTeamSchedule` to return a human-readable status for any explicit `STATUS_*` value instead of defaulting to `FINISHED` whenever both scores are present. Explicit `STATUS_FINAL`/`STATUS_FULL_TIME` still map to `FINISHED`, and `STATUS_POSTPONED`/`STATUS_CANCELLED` are preserved.

### Result

A game at halftime now resolves to a live status (e.g. `Halftime`) instead of `FINISHED`, and its scores are no longer forced to `0`.

## Added: backend documentation for AI consumption

### Purpose

The backend now has a documentation set under [docs](./docs/) that mirrors the frontend documentation approach.

### Added files

- [docs/README.md](./docs/README.md)
- [docs/app.module.ts.md](./docs/app.module.ts.md)
- [docs/app.controller.ts.md](./docs/app.controller.ts.md)
- [docs/app.service.ts.md](./docs/app.service.ts.md)
- [docs/main.ts.md](./docs/main.ts.md)
- [docs/games/games.controller.ts.md](./docs/games/games.controller.ts.md)
- [docs/games/games.service.ts.md](./docs/games/games.service.ts.md)
- [docs/teams/teams.controller.ts.md](./docs/teams/teams.controller.ts.md)
- [docs/teams/teams.service.ts.md](./docs/teams/teams.service.ts.md)
- [docs/auth/api-key.guard.ts.md](./docs/auth/api-key.guard.ts.md)
- [docs/cronJob/cronJob.service.ts.md](./docs/cronJob/cronJob.service.ts.md)
- [docs/utils/utils.ts.md](./docs/utils/utils.ts.md)

### Benefit

These docs explain the purpose of each backend module and its main responsibilities so AI assistants and future contributors can understand the architecture more quickly.
