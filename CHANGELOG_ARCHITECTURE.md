# Backend Architecture & Recent Changes

> **📚 Per-file documentation:** For AI-readable documentation of backend modules, see the [docs](./docs/) directory. Each file has a matching Markdown explanation of its purpose, key features, responsibilities and data flow.

## Fix: Stop `[fixScoreIssue]` log spam from future games with scores

### Problem

The `fixScoreIssue()` log (`Removing score for game X that has scores but hasn't started yet...`) appeared hundreds of times. Games like `NCAAWH-*`, `MLS-*` were repeatedly found with scores despite not having started.

### Root Cause

In `getLeagueGames()`, the ESPN/PWHL APIs return scores for games that haven't started yet. The `addMissingOnly` (oldies) flow already rejected future games entirely, but the **normal import flow** had no such guard — it called `create(game)` with the pre-game scores intact. This created an endless cycle:

1. `getLeagueGames` imports a future game with scores → scores written to DB
2. `fetchGamesScores()` → `fixScoreIssue()` finds it, logs a line, removes scores
3. Next `getLeagueGames` cycle re-imports the same scores → back to step 1

### Solution

Added a guard in `getLeagueGames()` that nullifies `homeTeamScore` and `awayTeamScore` for any game whose `startTimeUTC` is in the future, right before `create(game)` is called. This prevents pre-game scores from ever being persisted, eliminating the cycle.

### Files
- `backend/src/games/games.service.ts` — added score-stripping guard before `create(game)` in the import loop
- `backend/docs/games/games.service.ts.md` — documented the guard

## Changed: Unified fetch behavior - current season vs historical (`espnAllData.ts`, `utils.ts`)

### Problem

Different leagues had different fetch behaviors for normal refreshes, causing confusion and inefficiency. Historical data was being fetched on every normal refresh for some leagues. Also, the concept of "current year" didn't account for seasons spanning two calendar years (e.g., NHL Oct-Apr).

### Solution

Unified the year selection logic for **all leagues**:
- **Normal fetch** (no `season` param): Fetches only the **current season years** based on `startSeason`/`endSeason` config
- **Fetch oldest (`getOldiesGames`)**: Fetches historical years via the `season` parameter (up to 10 years back)

Added new utility function `getCurrentSeasonYears(leagueName)` in `utils.ts`:
- For seasons spanning two years (e.g., NHL Oct-Apr): returns both years (e.g., [2025, 2026] or [2026, 2027])
- For single-year seasons (e.g., MLB Mar-Sep): returns only the current year

This applies to:
- Games fetching in `getEachTeamSchedule()` for NCAA and Olympics (scoreboard API)
- Teams fetching fallback in `getESPNTeams()` for NCAA and Olympics

### Files changed

- `backend/src/utils/utils.ts` — Added `getCurrentSeasonYears()` function.
- `backend/src/utils/fetchData/espnAllData.ts` — Uses `getCurrentSeasonYears()` for normal fetch.
- `backend/CHANGELOG_ARCHITECTURE.md` — this entry.

---

## Fixed: NCAA college leagues games not fetching (`espnAllData.ts`)

### Problem

The NCAA college leagues were using the ESPN `/teams/${id}/schedule` endpoint with `seasontype` parameter to fetch games. However, ESPN does not populate this route for some college sports - it returns empty arrays or 404 errors.

This caused:
- No past games being retrieved for NCAA leagues
- No future games being retrieved for NCAA leagues
- Missing schedule data for these leagues

### Solution

Added all NCAA college leagues to the `collegeLeagues` set that uses the **scoreboard API** instead of the schedule API. The scoreboard API (`/scoreboard?dates=${year}`) returns all games for a year, which are then filtered by team ID.

The college leagues now using the scoreboard API:
- NCAAF (College Football)
- NCAAB (Men's College Basketball)
- NCCABB (College Baseball)
- WNCAAB (Women's College Basketball)
- NCAAMH (Men's College Hockey)
- NCAAWH (Women's College Hockey)

### Files changed

- `backend/src/utils/fetchData/espnAllData.ts` — Added `collegeLeagues` set and modified `getEachTeamSchedule()` to use scoreboard API for all college leagues.
- `backend/CHANGELOG_ARCHITECTURE.md` — this entry.

---

## Refactored: `getDiskUsage()` production hardening (`games.service.ts`)

The `getDiskUsage()` method was refactored for production robustness with the following improvements:

- **Type safety**: Replaced `(this.gameModel.collection as any).conn.db as any` with proper Mongoose API access via `this.gameModel.db.db` — eliminates hidden `any` casts and prevents runtime crashes if Mongoose internals change.
- **In-memory caching**: Added a 60-second TTL cache (`DISK_USAGE_CACHE_TTL_MS`) to avoid spamming `dbStats` on every call — critical when healthchecks or Kubernetes probes hit the endpoint frequently.
- **Accurate size calculation**: Now prioritizes `totalSize` (data + indexes across all collections) for shared clusters (M0/M2/M5), and falls back to `storageSize + indexSize` for dedicated clusters (M10+).
- **Percentage capping**: The percentage is now clamped to a maximum of 1.0 (100%) using `Math.min(rawPercentage, 1)`.
- **Critical threshold alerting**: Logs a `console.warn` when disk usage exceeds 85%, providing early warning before the 90% purge threshold.
- **Graceful degradation**: On transient errors, returns the last cached value instead of a cold fallback, ensuring continuity of service.

### Files changed

- `backend/src/games/games.service.ts` — `getDiskUsage()` refactored with caching, type safety, and production hardening.
- `backend/CHANGELOG_ARCHITECTURE.md` — this entry.

---

## Changed: `purgeOldestMonth` now runs twice daily (`cronJob.service.ts`)

The oldest-month purge cron was upgraded from **once daily (3AM UTC)** to **twice daily (3AM & 3PM UTC)** to accelerate time-based cleanup of historical game data.

- **Schedule**: `0 3,15 * * *` (3AM and 3PM UTC) — roughly 12 hours apart.
- **Behavior unchanged**: deletes all games from the oldest month in the DB (e.g. September 2016), logs the count and remaining years.
- **Tests updated**: `cronJob.service.spec.ts` describe block renamed to `purgeOldestMonth (twice-daily time-based purge)`.

### Files changed

- `backend/src/cronJob/cronJob.service.ts` — cron expression `0 3 * * *` → `0 3,15 * * *`.
- `backend/src/cronJob/tests/cronJob.service.spec.ts` — renamed describe block.
- `backend/docs/cronJob/cronJob.service.ts.md` — documented new schedule.

---

## Changed: Single league rotation cron (`cronJob.service.ts`)

The six fixed daily per-league crons (`updateMLBGames` 2 AM → `updateWNBAGames` 7 AM)
are replaced by ONE 10-minute cron, `refreshLeaguesOneByOne()`:

- **One league per 10-minute tick**, walking the whole `League` enum in order —
  covers every league daily (college/NWSL/Olympics included, which the fixed crons
  never refreshed), and bounds each third-party cycle to a single league.
- **Window 4 AM-11 AM New York** (`America/New_York`) — ticks outside the window
  are no-ops; 17 leagues × 10 min = the full list completes ~2 h50 after opening
  (~6 h50 AM NY), well inside the window. The cursor resets when the 4 AM window
  of a new NY calendar day opens (day key from the NY-converted clock).
- **Season-gated**: `isCurrentSeason` / `isPlayoffsPeriod` (10-day cached dates)
  skip off-season leagues without any third-party fetch; the slot is still consumed.
- **Slot consumed before awaiting**: a slow refresh never double-runs the same
  league; a restart resets the cursor and re-walks fresh leagues (skipped by the
  1-hour timestamp / staleness gates in `getLeagueGames`).
- **No overlap with the fast crons**:
  - schedules are offset — rotation `*/10` (:00,:10,…), scores `2-59/10`
    (:02,:12,…), availability `7-59/12` (:07,:19,…): no shared fire minute;
  - `GameService.isScoreRecoveryRunning` (new getter) lets the rotation postpone
    its tick while a score recovery cycle runs (slot not consumed, retried next tick);
  - conversely `CronService.isHeavyRefreshRunning` (rotation OR oldies) makes the
    scores and availability crons skip their tick.

### Files changed

- `backend/src/cronJob/cronJob.service.ts` — `refreshLeaguesOneByOne()` + removed `update{MLB,NBA,NFL,NHL,PWHL,WNBA}Games`; offset schedules + `isHeavyRefreshRunning` guards.
- `backend/src/games/games.service.ts` — `isScoreRecoveryRunning` getter.
- `backend/src/cronJob/tests/cronJob.service.spec.ts` — rotation tests (window, order, season skip, next-day idle, overlap postponement, fast-cron skip).
- `backend/docs/cronJob/cronJob.service.ts.md` — updated job table.

---

## Added: Season-gated recovery games fetch at startup (`cronJob.service.ts`)

Since the read-only routes change (`findAll` / `findByDate` / `findByDateHour` no longer
refresh on empty), a **cold or stale DB** would stay empty until the next daily/monthly
cron (up to ~24 h) — e.g. a deploy/restart in the evening, or a wiped games volume.

`CronService.onModuleInit` now schedules (2 min after boot, after the existing 30 s
score recovery) a one-shot `getAllGames(false, new Date())`:

- **Season-gated per league**: the `date` boundary makes `getAllGames` skip leagues
  where `isCurrentSeason(league, today)` / `isPlayoffsPeriod(league, today)` are false —
  off-season leagues are never fetched.
- **Warm restarts stay cheap**: `getLeagueGames`'s internal 1-hour timestamp freshness
  and `needRefresh` staleness gates skip already-fresh leagues; each attempt stamps the
  league (`'auto'` timestamp) so a crash/restart loop makes progress instead of
  re-fetching completed leagues.
- **Fresh-deploy gap closed**: `getAllGames` fetches teams first when the teams
  collection is empty — `checkLeagueGamesAvailability` cannot (its 30 % threshold
  compares against a zero team count, so it never triggers).

Why not piggyback on `fetchGamesScores`: it only updates scores of games **already in
the DB** (`fetchGamesForLiveScoreUpdate(2)`) and never inserts new scheduled games.
`checkLeagueGamesAvailability` does insert schedules but is window-limited (0–11 LA)
and has the zero-team edge above.

### Files changed

- `backend/src/cronJob/cronJob.service.ts` — recovery `getAllGames(false, new Date())` scheduled in `onModuleInit`.
- `backend/src/cronJob/tests/cronJob.service.spec.ts` — fake-timer test for the scheduled recovery.
- `backend/docs/cronJob/cronJob.service.ts.md` — documented the startup recovery job.

---

## Changed: Read-only game routes — no refresh-on-empty (`games.service.ts`)

The date-view routes (`GET /games/hour/:gameDate` → `findByDateHour`,
`GET /games/date/:gameDate` → `findByDate`, `GET /games` → `findAll`) no longer
trigger league refreshes:

- **Empty result** → returns `{}` / `[]` immediately. Previously, on a totally empty
  DB these paths awaited `getAllGames(false, gameDate, ...)` — and `findAll()` even
  called `getAllGames()` with **no date and no league filter**, refreshing every
  league from third-party APIs directly inside a user request.
- **Games found for today** → the `needRefresh`-gated background loop (one
  `getLeagueGames` per stale league seen in the day's games, chained on
  `refreshChain`) has been removed from `findByDate` / `findByDateHour`.
- `refreshChain` (the last chained-refresh mechanism in read paths) is deleted.

Why: these call-time refreshes blocked the backend during sequential third-party
schedule fetches and, combined with the 460 MB heap budget
(`NODE_OPTIONS=--max-old-space-size=460`), caused memory-pressure blocks and server
restarts. An empty day is a legitimate result (off-season); the frontend already
handles it (`NoResults` + bounded auto-retry + cooldown).

Data freshness is now entirely the cron jobs' responsibility, unchanged:

- monthly `getAllGames` (1st of month, 1 AM) + monthly teams (1st, 0:30 AM),
- daily per-league refreshes 2 AM–7 AM (MLB, NBA, NFL, NHL, PWHL, WNBA),
- `fetchGamesScores` every 10 minutes (11 AM–2 AM NY) + once at server restart,
- `checkLeagueGamesAvailability` every 12 minutes (0 AM–11 AM LA) — re-triggers a
  league refresh when too few upcoming games are stored,
- `getOldGames` daily at 10 AM (oldies history, one league+year per run).

Manual levers unchanged: `POST /games/refresh/:league` (single league, `forceUpdate`),
`POST /games/refresh/all`, `POST /games/refresh/oldies`. `findByTeam` keeps its
existing refresh, already gated to leagues in season or playoffs.

### Files changed

- `backend/src/games/games.service.ts` — removed empty-path refreshes and today-branch `refreshChain` loops in `findAll` / `findByDate` / `findByDateHour`; deleted `refreshChain`.
- `backend/src/games/tests/games.service.spec.ts` — added read-only route tests (empty result returns without calling `getAllGames`).
- `backend/docs/games/games.service.ts.md` — documented read-only behavior.

---

## Added: Read-only capacity status endpoint

- **New endpoint** `GET /games/capacity/status` (requires API key) — returns a read-only snapshot of the MongoDB storage footprint **without performing any purge**.
- Response fields:
  - `diskUsage`: `{ usedMB, totalMB, percentage }` computed via the same `df` + `$collStats` fallback used by the existing capacity manager.
  - `years[]`: per-year game count (`{ year, count, oldestDate, newestDate }`), oldest → newest.
  - `teamCount`: total number of stored teams.
  - `gameCount`: total number of game documents.
  - `threshold` (0.9 by default) and `actionNeeded` (boolean) for an at-a-glance decision signal before triggering the destructive `POST /games/capacity/check`.
- New `GameService.getCapacityStatus()` and `TeamService.countAllTeams()` helpers.
- Test added in `games.controller.spec.ts`.

### Files changed

- `backend/src/games/games.service.ts` — `getCapacityStatus()` (read-only; wraps `getDiskUsage()`, `getAvailableYears()`, `countDocuments()`, and the new `TeamService.countAllTeams()`; returns safe defaults on any error).
- `backend/src/teams/teams.service.ts` — `countAllTeams()`.
- `backend/src/games/games.controller.ts` — `GET /games/capacity/status` route.
- `backend/src/games/tests/games.controller.spec.ts` — mock + test for `getCapacityStatus`.
- `backend/docs/games/games.controller.ts.md` / `games.service.ts.md` — documented the new endpoint and method.

---

The response message from `POST /games/refresh/oldies` used to list all requested years (e.g. "2026, 2025, 2024, ...") regardless of whether any games were inserted. Years where `added: 0` (all games already existed) cluttered the response.

Now:
- `getLeagueGames` returns `{ added, skippedExisting, skippedMissingTeamData }` when `addMissingOnly: true` (instead of the games array — only the oldies path uses this flag).
- `getOldiesGames` tracks which years had `added > 0` and only includes those in the message.
- When no years had additions, the message reads "completed — no new games were added (all years already up to date)".
- The response also includes `yearsWithAdditions: number[]` for programmatic use.

### Files changed

- `backend/src/games/games.service.ts` — `getLeagueGames` returns stats object when `addMissingOnly`; `getOldiesGames` filters message by years with additions.
- `backend/src/games/tests/games.service.spec.ts` — added tests for filtered message and "already up to date" case.
- `backend/docs/games/games.service.ts.md` — documented new return type.

---

## Added: Timeout + retry on ESPN schedule fetches (`espnAllData.ts`)

ESPN requests inside `getEachTeamSchedule` used raw `fetch` with undici's (very long)
default timeout, so a connect-timeout could block the schedule/oldies refresh for an
unbounded time and produce noisy errors.

- `fetchWithTimeout(url, timeoutMs, options?)` — aborts the request after 15 s using
  the global `AbortController`.
- `fetchWithRetry(url, retries = 1)` — retries once (500 ms backoff) on transient
  errors, then throws so the existing per-saison-type try/catch still captures it.
- The two `fetch` calls in `getEachTeamSchedule` (scoreboard + per-season-type
  schedule) now use `fetchWithRetry`.

## Added: Closest past/upcoming game dates endpoint (`games.service.ts`, `games.controller.ts`)

New `GET /games/dates/closest` returns `{ previousDate, nextDate }` — the closest
past and upcoming game dates — optionally scoped by `leagues` and/or
`teamSelectedIds`. Implemented with **dedicated helpers** so the endpoint flow is
easy to follow:

- `GameService.getClosestDates({ leagues, teamSelectedIds })` — orchestrator.
- `GameService._buildClosestDatesFilter(leagues, teamSelectedIds)` — builds the
  Mongo filter (comma/space/plus leagues, comma-separated teams, both `$in`).
- `GameService._findClosestGameDate(filter, '$min'|'$max')` — single aggregation
  returning the boundary date or `null`.

Boundary: past is strictly `<` boundary, upcoming is `>=` boundary. The boundary
is the optional `date` query param (`YYYY-MM-DD`); if omitted it defaults to today
(UTC `readableDate`). `previousDate`/`nextDate` are returned as `YYYY-MM-DD` strings.

- `backend/src/games/games.controller.ts` — added `GET /dates/closest`.
- `backend/src/games/games.service.ts` — added `getClosestDates` + 2 private helpers.
- `backend/src/games/tests/games.controller.spec.ts` — controller forwards params.
- `backend/src/games/tests/games.service.spec.ts` — unit tests for `getDateRange`
  and `getClosestDates` (filters, boundary date, source & team scoping, fallbacks).

## Added: League-scoped date range limits (`games.service.ts`, `games.controller.ts`)

`GET /games/dates/range` now accepts an optional `leagues` query param
(comma/space/plus separated, uppercased). When provided, the min/max dates returned
by `GameService.getDateRange(leagues)` are scoped to those leagues via
`league: { $in }` instead of spanning every league.

- `backend/src/games/games.controller.ts` — added `@Query('leagues')` to `getDateRange`.
- `backend/src/games/games.service.ts` — `getDateRange(leagues?)` builds a league-scoped `$match`.
- `backend/src/games/tests/games.controller.spec.ts` — forwards the `leagues` param.

## Added: Progress logging during full league refresh (`games.service.ts`)

`getAllGames` now emits a `console.info` line at every 20 % of leagues processed
(`[getAllGames] progress: 20% (2/10)`), plus the initial list of leagues and a final
`[getAllGames] done`. If a league blocks mid-refresh, the last log line points
directly to it.

## Changed: Season-aware refresh gating for on-demand endpoints (`games.service.ts`)

Avoids calling third-party APIs (ESPN, PWHL) for leagues that are off-season:

- **`GET /games/team/:teamSelectedId` (`findByTeam`)**: when the team has no games, the
  league refresh now only runs if `isCurrentSeason(league, new Date())` or
  `isPlayoffsPeriod(league, new Date())` is true (league dates come from a 10-day cache).
- **`GET /games/date/:gameDate` (`findByDate`)**: on a totally empty DB, it now calls
  `await this.getAllGames(false, new Date(gameDate))` instead of `this.getAllGames()`,
  so `getAllGames` only refreshes leagues whose season/playoffs cover that date (same
  pattern as `findByDateHour`).
- **Cron jobs unchanged**: `cronJob.service.ts` calls `getAllGames()` without a date, so
  no season check applies and monthly/daily crons keep running all year round.
- **`getLeagueGames` no longer propagates provider errors**: the `try/finally` now has a
  `catch` that logs and returns. Without it, a single failing third-party API call
  (timeout / malformed response, common off-season) made `getAllGames` reject and turned
  every dependent route (`/games`, `/games/date/...`, `/games/hour/...`, `/games/team/...`)
  into a 500 — very visible when the frontend config contains a single off-season league.

### Files changed

- `backend/src/games/games.service.ts` — season gate in `findByTeam`; dated refresh in `findByDate`; error swallowing in `getLeagueGames`.
- `backend/docs/games/games.service.ts.md` — documentation updated.

---


## Added: Historical teams fallback for enrichment (`HistoricalTeams.ts`)

Old ("oldies") games involving defunct, relocated or renamed franchises previously
rendered with empty team data because those teams no longer have a living record in the
database. We now provide a **static fallback map** (same pattern as `UniversityLogos`)
keyed by the full `uniqueId` (`'{LIGUE}-{ABBREV}'`, e.g. `'NBA-SEA'`) that carries the
team `label`, `abbrev`, logo, dark logo, colors and optional `record`.

### Behavior

- `GameService._enrichGameWithTeamData` falls back to `HistoricalTeams[id]` when a
  game's `homeTeamId` / `awayTeamId` is not found in the DB `teamsMap`, so old games
  render correct name / logo / colors again.
- This file resolves **enrichment only**. Fetching *new* historical games still needs the
  numeric ESPN team `id` (a Core API `seasons/{year}/teams` sync) and is out of scope.

### Guards / non-regression

- `GameService._deleteUnlinkedTeams` never deletes teams referenced by `HistoricalTeams`,
  nor teams marked `isActive === false` (they are required to enrich old games).
- `TeamService.generateLeaguesTeamsAndColorsFiles` excludes `HistoricalTeams` keys and
  `isActive === false` teams from `Teams.tsx`, keeping the frontend filter/favorites clean.
- The `Team` schema / `TeamType` / DTOs now expose `isActive?: boolean` (default `true`)
  to support future Core-API import of inactive teams with the same protections.

### Files changed

- `backend/src/utils/HistoricalTeams.ts` — new static fallback map + `HistoricalTeamEntry`.
- `backend/src/games/games.service.ts` — enrichment fallback; `_deleteUnlinkedTeams` guard.
- `backend/src/teams/teams.service.ts` — `Teams.tsx` generation excludes inactive/historical.
- `backend/src/teams/schemas/team.schema.ts`, `backend/src/teams/dto/*.ts`,
  `backend/src/utils/interface/team.ts` — added `isActive?: boolean`.
- `backend/docs/utils/HistoricalTeams.ts.md` — documentation of the new module.

---

Future playoff games that temporarily disappear from an external schedule source are
now protected from flickering. `getLeagueGames()` records the first missing time in
`missingSince`, keeps the game active for 48 hours, and deactivates it only when it
remains absent beyond that period. When the game reappears, the refresh confirms it,
restores `isActive: true`, and clears `missingSince`.

The behavior is limited to current-season refreshes with a successful non-empty fetch;
empty or historical fetches do not deactivate future games.

### Files changed

- `backend/src/games/schemas/game.schema.ts` — added the internal `missingSince` field.
- `backend/src/games/games.service.ts` — added delayed deactivation and reappearance handling.
- `backend/src/games/tests/games.service.spec.ts` — added lifecycle regression tests.
- `backend/docs/games/games.service.ts.md` — documented the grace-period behavior.

## Fixed: PWHL oldies lost shutout scores

PWHL historical imports inferred `FINISHED` only when both scores were different from `0`.
That incorrectly treated valid results such as `0-4` as unfinished and stored null scores.
The importer now uses HockeyTech's official final indicators (`final`, status `4`, or a `Final`
game status), so shutouts and overtime results retain their scores.

---

## Fixed: Oldies refresh crashed on team cleanup (CastError on ObjectId \_id)

### Problem

During the historical oldies refresh, `_deleteUnlinkedTeams` called `teamService.deleteManyByIds` with a
list of textual `uniqueId`s such as `"PWHL-DET"`. The query built `$or: [{ uniqueId: { $in: ids } }, { _id: { $in: ids } }]`,
so those plain strings were also pushed into `$in` on the ObjectId `_id` field. Mongoose then threw
`CastError: Cast to ObjectId failed for value "PWHL-DET" at path "_id" for model "Team"`, aborting the
cleanup right after teams were detected as unlinked (reproduced on every season 2026 down to 2019 in the logs).

### Solution

`deleteManyByIds` now only includes the `_id` branch for ids that are valid 24-char hex ObjectIds.
Plain textual uniqueIds (`"PWHL-DET"`, `"NHL-BOS"`, ...) are matched via `uniqueId` only, so the query
never casts a non-hex string into an ObjectId.

### Files changed

- `backend/src/teams/teams.service.ts` — filter valid ObjectIds before adding the `_id` branch in `deleteManyByIds`.
- `backend/src/teams/tests/teams.service.spec.ts` — updated `deleteManyByIds` tests + new regression test for textual ids.

---

## Fixed: MLB/MLS future games disappeared after the data update (crash between deactivating and re-writing)

### Problem

When refreshing a league (MLB, MLS, ...), the `getLeagueGames` service first **deactivated all future games** (`isActive:false`)and _then_ re-fetched/re-wrote the season. If the server **crashed/restarted** between these two steps (the very large oldies refreshes could trigger one), every upcoming game of that league was left `isActive:false` and never re-inserted. Result:the **Programme du jour** tab showed **No results** for 2026 in both MLB and MLS, until a manual league refresh succeeded.

### Solution

1. **Reordered the refresh**:the season is now fetched and the future games re-inserted `isActive:true` **before** any deactivation runs.
2. **Selective deactivation** (safe-replace): only the stale future games absent from the fresh season (matched by `uniqueId`) are deactivated, never blindly per date range.

3. **Empty-fetch guard**:if the fetch returns zero games, no deactivation happens (the league is never blanked on a crash or failed fetch..

4. **Bound the oldies cron**:the daily oldies refresh now processes **one random year per tick** (instead of up to 11 years at once) and has an **anti-reentrancy guard**,cutting the per-tick work volume that could trigger Render restarts during the data update.

### Files changed

- `backend/src/games/games.service.ts` — crash-safe reordered / selective / empty-guarded deactivation in `getLeagueGames`.
- `backend/src/cronJob/cronJob.service.ts` — one-random-year-per-tick oldies refresh + anti-reentrancy guard.

---

## Fixed: Oldies historical import now allows null scores for past games (cron fills them later)

### Problem

When recovering historical data via `POST /games/refresh/oldies?year=...&league=...`, games with null scores were rejected
even though they were valid completed matches. The strict validation required both home and away scores to be present, which
prevented leagues like MLS, NWSL, and Olympic games from being imported when score data was initially unavailable.
The log showed: `[Oldies] Skipping MLS-TOR-693036 ... because team/score data is incomplete...`.

### Solution

Split the validation into two concerns:

1. **Team requirement** (strict): Both home and away teams must be present. Games without proper team data are still rejected.
2. **Score requirement** (flexible for past games):
   - **Past games** (startTimeUTC < now): Null scores are allowed. The cron's `fetchGamesScores()` will fill them in later.
   - **Future games** (startTimeUTC ≥ now): Rejected to prevent scheduled games from polluting historical data.

### Changes

- **`GameService.getLeagueGames(params)` with `addMissingOnly: true`** (`backend/src/games/games.service.ts`, lines 485–510):
  - Removed strict score validation for past games;
  - Added date-based filtering to reject future scheduled games;
  - Allows historical matches with pending scores to be persisted and filled by the cron later.
- **Unit tests** (`backend/src/games/tests/games.service.spec.ts`):
  - Added regression test: past games with null scores are inserted;
  - Added regression test: future scheduled games are rejected.
- **Documentation** (`backend/docs/games/games.service.ts.md`):
  - Updated `getLeagueGames()` section to document the new validation logic.

### Result

Historical oldies recovery now successfully imports valid matches from all leagues, even when score data is initially pending.
The cron's `fetchGamesScores()` subsequently fills in the scores in a separate pass, eliminating the skip warnings.

### Verification

- Unit tests pass: 2 new regression tests confirm past-game insertion and future-game rejection.
- `npm run test -- --testPathPattern=games.service.spec` passes all tests.

---

## Changed: ColorsTeam / UniversityLogos regeneration is now additive-only (no deleted lines)

### Purpose

`generateLeaguesTeamsAndColorsFiles()` in `backend/src/teams/teams.service.ts` rewrote the
`ColorsTeam.tsx`/`ColorsTeam.ts` and `UniversityLogos.tsx`/`UniversityLogos.ts` files from scratch,
**overwriting** the whole file and therefore **deleting** any entry that was no longer produced by the
current team data. The requirement is that updating either of these two files must never remove a line —
only **add** new entries or **update** existing ones.

### Changes

- `backend/src/teams/teams.service.ts`:
  - added small helpers `readExistingFile()`, a block parser, and `mergeGeneratedEntries()`;
  - the ColorsTeam and UniversityLogos generation now merges freshly generated entries with the existing
    file content (additive/update-only) instead of replacing the file wholesale;
  - the same merge is applied to both the frontend mirrors (`frontend/constants/*.tsx`) and the backend
    mirrors (`backend/src/utils/*.ts`).
- `updateLeagues.js` (root): the `UniversityLogos.tsx` update now also merges with existing content so it
  does not delete previously stored logos, only adding or updating entries.
- Restored the previously-dropped `ColorsTeam` entries (`NCAAB-BUT`, `NCAAF-SIU`, `NCAAF-UND`) in both
  `backend/src/utils/ColorsTeam.ts` and `frontend/constants/ColorsTeam.tsx`.

### Result

Regenerating `ColorsTeam` or `UniversityLogos` (from the backend generator or the `updateLeagues.js` script)
no longer deletes lines: existing entries are preserved (or updated), and only new entries are added.

### Verification

- `tsc --noEmit` clean; Jest backend suite passes.
- `git diff` confirms ColorsTeam has no removed entries (only adds/updates) and UniversityLogos contains no
  truly-deleted keys (every removed line is an update).

---

## Added: oldies recovery never overwrites existing matches (only adds missing ones)

### Purpose

When re-running `POST /games/refresh/oldies?year=...&league=...` (or the historical cron), the oldies
path previously went through `getLeagueGames` → `create()`, which **overwrites** every already-stored game
whose `uniqueId` already exists in the DB. We now make oldies updates **additive only**: already-present matches
are left untouched, and only genuinely missing matches are inserted.

### Changes

- **`GameService.getLeagueGames(params)`** (`backend/src/games/games.service.ts`) — new `addMissingOnly: boolean = false` option:
  when `true` (oldies path only), the normal refresh path is unchanged:
  - the set of fetched `uniqueId`s already present in the DB is queried once;
  - games that already exist are **skipped** (never overwritten) when they are the **same match** — i.e. the
    `uniqueId` matches **AND** both the home score and the away score equal the stored ones;
  - if the `uniqueId` exists butt the scores differ (or are missing**, the game is treated as a stale/different result and
    **refreshed\*\* via `create()` instead of being skipped;
  - games missing a well-defined **home and away team** data (`homeTeamId`/`homeTeamShort`/`homeTeam`
    and `awayTeamId`/`awayTeamShort`/`awayTeam`) or missing a home/away score are skipped with a warning log;
  - only complete, missing games are created.
    Logs added / skipped counts.
- **`GameService.getOldiesGames(...)`** now passes `addMissingOnly: true` when calling `getLeagueGames`.
- Added unit tests in `backend/src/games/tests/games.service.spec.ts` (only-create-missing behavior; same-id+score guard; home/away data + score guard; flag passthrough).

### Result

Updating a year for a league never wipes or degrades existing match data anymore; it purely fills the
gaps by adding only the missing (complete) matches.

### Verification

`tsc --noEmit` clean; Jest suites pass (84 tests).

---

## Fixed: stale active PWHL game keeps triggering the scores fetch cycle on every start

### Problem

The backend logged `[fetchGamesScores] Fetching scores for PWHL on 2026-05-11...` at every server
start / cron run. A PWHL game stuck in the DB (`isActive: true`, non‑terminal status, started months
ago) matched `fetchGamesForLiveScoreUpdate(2)` forever, and since its final result can no longer be
recovered from the source, the recovery cycle re‑detected it each time.

### Changes

- **`GameService.removeStaleUnresolvedGames(maxAgeDays?)`** (`backend/src/games/games.service.ts`, new):
  purges games that are still `isActive: true`, started more than the max age ago (default 90 days),
  and whose `gameStatus` is not `FINISHED`/`FINAL`/`CANCELLED`/`POSTPONED`.
- New configurable `GameService.staleGameMaxAgeDays = 90`.
- `fetchGamesScores()` now calls `removeStaleUnresolvedGames()` at the end of the cycle, next to the
  existing `removeOldGamesWithoutScore()`.
- Added unit tests in `backend/src/games/tests/games.service.spec.ts`.

### Result

Stale, unresolvable active games are purged after ~3 months; the recurring `Fetching scores...` log
for those games disappears.

---

## Added: unit tests for the season-aware recovery features

### Purpose

Prevent regressions on the PWHL historical recovery, the `getOldiesGames` multi-year loop,
and the season-aware oldies cron.

### Added

- **`backend/src/games/tests/games.service.spec.ts`** — new `describe` blocks:
  - `getSeasonStatus`: past complete/incomplete seasons, current season always `complete`,
    PWHL pre-2024 short-circuit (no fetch / no DB count).
  - `getOldiesGames`: throws on out-of-range explicit year, loops over the last 5 seasons when
    no year is given, and processes a single explicit year with a league filter.
  - The `mockGameModel` now also exposes `countDocuments`.
- **`backend/src/cronJob/tests/cronJob.service.spec.ts`** (new file) — `CronService.getOldGames`:
  refreshes the current season even when `complete`, skips a past complete season without
  refreshing, and refreshes a past incomplete season. Uses a deterministic `Math.random`.

### Verification

`tsc --noEmit` clean; ESLint clean on the new/edited spec files; Jest suites pass.

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
- **`GameService.\_fetchUniqueGames(league, season?)** (new private helper): extracts the
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
