# Backend Architecture & Recent Changes

> **📚 Per-file documentation:** For AI-readable documentation of backend modules, see the [docs](./docs/) directory. Each file has a matching Markdown explanation of its purpose, key features, responsibilities and data flow.

## Added: Playoff future-game grace period

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
