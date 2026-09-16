# File: `backend/src/utils/fetchData/espnAllData.ts`

## Purpose

Fetches teams and per-team schedules from ESPN APIs, normalizes them into game payloads, and exposes score helpers. Used by `GameService.getLeagueGames()` (normal + oldies paths) via `getTeamsSchedule()`.

## Key Features

- **Two fetch paths in `getEachTeamSchedule()`**:
  - **Scoreboard path** (Olympics + soccer `MLS`/`NWSL` only): `GET {sport}/{league}/scoreboard?dates={year}&limit=1000&page={n}`, filtered per team by `competitors.team.id`. Years = `[season]` when `season` is given (oldies), else `getCurrentSeasonYears(leagueName)`.
  - **Team schedule path** (all other leagues, **including the 6 college leagues** `NCAAF, NCAAB, NCCABB, WNCAAB, NCAAMH, NCAAWH`): `GET teams/{id}/schedule?seasontype={1,2,3}[&season={season}]`. With `season` (oldies) all fetched games are kept; without it, games older than `untilDate` (10 months when `forceUpdate`, else now) are dropped.
- **College leagues use the team schedule endpoint** (not scoreboard): the `scoreboard?dates={year}` path does not return their full history.
- **College team discovery** (`getESPNTeams`): classic `GET teams` list first, then add-only enrichment by scanning up to **10 scoreboard pages** (`limit=1000`, early stop when a page returns < 1000 events) of the **current year** for `CollegeLeague`. Teams without an `isActive` flag (scoreboard-only partial objects) are accepted so the enrichment is not filtered back out. Logs `[Teams] <LEAGUE>: +N extra teams discovered via scoreboard pages.`
- **University logo resolution** (`resolveUniversityLogo(league, abbrev)`): league-scoped key `'{LEAGUE}-{ABBREV}'` first (logo may differ per sport), systematic fallback to plain `'{ABBREV}'`. Used in team mapping, match payloads, `getTeamsLogo()`, and the pre-save fallback in `TeamService.getTeams()`.
- **University logo backfill** (`TeamService.backfillMissingUniversityLogos()`): runs ONLY at the end of `getTeams()` — i.e. manual `POST /teams/refresh?leagueParam=` or the monthly `updateTeams` cron, never on game fetches. Missing/empty logo keys are filled with the working `teamLogo` under BOTH scoped and plain keys.
- **University team colors** (`getTeamColors(uniqueId)` from `../Colors`): when ESPN returns no `color`/`alternateColor`, the colors of the same university abbreviation in another college league are used (`NCAAB-X` → `NCAAF-X` / `NCAAMH-X` …) instead of the generic `#ffffff` on `#000000` placeholder. Non-college leagues keep the default placeholder.
- **Resilience**: 15s fetch timeout (`fetchWithTimeout`) + 1 retry (`fetchWithRetry`).
- **Score helpers**: `getESPNScores()`, `getESPNGameScore()`, `getTeamsSchedule()`.

## Data Flow

1. `getTeamsSchedule(leagueName, ...)` fans out per team (concurrency 2) to `getEachTeamSchedule()`.
2. `getEachTeamSchedule()` picks scoreboard vs team-schedule path, fetches, then maps events to normalized game objects.

