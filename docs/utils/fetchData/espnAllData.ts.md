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
- **Team records (`homeTeamRecord` / `awayTeamRecord`)**:
  - `extractCompetitorRecord(competitor)` — the single reader for both ESPN shapes: the singular `competitor.record` array (`displayValue`) returned by `teams/{id}/schedule`, and the plural `competitor.records` array (`summary`) returned by `scoreboard` / `summary`. Entry priority is `total` → `ytd` → first entry, because the NHL/season schedules only expose `ytd` while the post-season schedule and the scoreboard expose `total`. The previous `records.find(r => r.type === 'total')` lookup therefore returned `''` for the NHL scoreboard and for `getESPNGameScore()`. The trailing `", 109 PTS"` hockey suffix is stripped, so a bare `"W-L-T"` string is stored.
  - `getEachTeamSchedule()` writes a **cumulative** tally (record at the time of the game) on the team-schedule path — that path previously wrote no record at all, which is why past seasons had none.
  - `applySeasonFinalRecords(allGames)` runs at the end of `getTeamsSchedule()` and rewrites those cumulative tallies into what must be displayed:
    - **every fetched game has already started** (season over) → each team's **final** season tally is taken from its most complete record (max games played) and copied onto *all* of its games, so a whole season shows one identical, end-of-season record;
    - **any game is still upcoming** (season in progress) → the records are **cleared**, so readers fall back to `team.record`, which always holds the most recent win/loss/draw tally.
  - PWHL is unaffected: its games come from `hockeyData.ts`, not this module.

## Data Flow

1. `getTeamsSchedule(leagueName, ...)` fans out per team (concurrency 2) to `getEachTeamSchedule()`.
2. `getEachTeamSchedule()` picks scoreboard vs team-schedule path, fetches, then maps events to normalized game objects (including a cumulative `homeTeamRecord` / `awayTeamRecord`).
3. `applySeasonFinalRecords()` normalizes those records across the whole league batch: final tally for a finished season, cleared for a season in progress.

