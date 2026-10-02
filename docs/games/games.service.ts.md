# File: `backend/src/games/games.service.ts`

## Purpose

This is the core business logic module for games. It fetches schedules and scores from external providers, stores them in MongoDB, enriches them with team data, and exposes query helpers for the frontend.

## Key Features

- **Game import and refresh** — pulls schedule data for leagues and stores it in MongoDB
- **Live score updates** — updates ongoing games with score and status data
- **Data enrichment** — attaches team names, logos, records and colors
- **Query helpers** — returns upcoming games, results, date-range data and hour-grouped schedules
- **Maintenance logic** — removes duplicates, old games and invalid score records, and purges stale
  active games whose final result can no longer be recovered.

## Main Responsibilities

### `_resolveTeamColors()` (private)

Resolves a team's display colors for `_enrichGameWithTeamData()`. Stored colors are kept as-is
unless they are the generic placeholder (`#ffffff` on `#000000`) **or degenerate** (`color` equals
`backgroundColor`, e.g. `#000000`/`#000000`, or `#NULL`): in that case `getTeamColors()`
(from `utils/Colors.ts`) borrows the colors of the same university in another college league, or
falls back to the default placeholder. Non-college leagues simply keep the default placeholder, so
already-stored teams display the correct colors without waiting for a re-fetch.

### `create()`

Creates or updates a game document while preserving important live fields such as status and clock.

### `getLeagueGames(params)`

Refreshes a specific league’s game data. It:

1. Checks if a refresh is already in progress.
2. Avoids unnecessary refreshes when data is still considered fresh.
3. Fetches the league’s teams and schedules.
4. Stores new or updated games in MongoDB.
5. Removes stale or unlinked team data when necessary.

**Playoff missing-game grace period:**

For a current-season refresh with a successful non-empty fetch, future active games
that are absent from the external source are not deactivated immediately. The first
missing refresh stores `missingSince` and keeps the game active for the 48-hour grace
period. A game still absent after that period is deactivated and the marker is removed.
When the game reappears, it is saved as active again and `missingSince` is cleared.
An empty fetch still causes no deactivation.

**Decided-series short-circuit (grace period bypass):**

The grace period exists for *undecided* "if necessary" playoff games (a Game 5/6/7 that may
transiently disappear from the source). A future game whose **series is already decided** is a
different case: the game can never be played, because ESPN never creates the event at all for a
decided series (e.g. an NLWC Game 3 after a 2-0 sweep simply does not exist in the feed). Such a
game is therefore deactivated **immediately**, without waiting out the 48-hour window and without
ever writing `missingSince`.

The decision is inferred from the game's `seriesStatus` via `decidedSeriesPattern`
(`(?:win|wins|won)\s+(?:the\s+)?series`, `series (is) over`, `series won`), matching ESPN
`series.summary` values such as `"SD wins series 2-0"`. `seriesStatus` is reliably populated on
future games because `syncGameWithScore()` propagates it to later games of the same matchup. An
empty or absent `seriesStatus` is **not** proof of a decided series, so those games keep the normal
grace period (no false deactivation).

This check runs after the "game is back in the source" test, so a game that reappears is always
confirmed first and never deactivated, even if its stale `seriesStatus` looks decided.

**Crash-safe replace guard (future games:)**

When refreshing a league's current data, upcoming games are **only deactivated AFTER** a successful, non-empty fetch. The previous order (deactivate-all-future-games, then re-write) could leave a league completely empty (all upcoming games marked `isActive:false`) if the server crashed/restarted between the two steps - exactly what happened for MLB and MLS during the data update. Now:

1. The season is fetched and the upcoming games re-inserted with `isActive:true` first.
2. Only stale future games absent from the fresh season get deactivated, matched by `uniqueId`.
3. An empty fetch never triggers a deactivation (guard on `uniqueGames.length > 0`).

Supports the `addMissingOnly` option (used by the **oldies** recovery): when `true`, it never overwrites
already-stored games; it queries the already-present `uniqueId`s, skips them, and inserts only the missing
games that have a complete home **and** away team. It logs added / skipped counts and returns
`{ added, skippedExisting, skippedMissingTeamData }` instead of the games array.

**Validation for oldies recovery (`addMissingOnly: true`):**

- **Team requirement** (strict): Both `homeTeamId`/`homeTeamShort`/`homeTeam` and `awayTeamId`/`awayTeamShort`/`awayTeam` must exist. Games without both teams are skipped.
- **Score requirement** (flexible for past games):
  - **Past games** (startTimeUTC < now): Null scores are allowed. The cron job's `fetchGamesScores()` will fill them later.
  - **Future games** (startTimeUTC ≥ now): Rejected to prevent scheduled games from polluting historical data.
- **Deduplication**: For a `uniqueId` already in the DB:
  - If the `uniqueId` matches AND both stored home/away scores equal the fetched ones → **skipped** (not overwritten).
  - If the `uniqueId` exists but scores differ → treated as a stale/different result and **refreshed**.
  - Only complete, missing games are created.

**Score stripping for future games (both flows):**

Before `create(game)` is called, scores are nullified for any game whose `startTimeUTC` is in the future. The ESPN/PWHL APIs may return scores for games that haven't started yet; without this guard, scores would be written to the DB and then removed by `fixScoreIssue()` on every `fetchGamesScores()` cycle, creating log spam.

`_resolveStatus()` distinguishes a **temporarily interrupted game** (`DELAYED`/`SUSPENDED`, e.g. a rain delay) from a **true postponement** (`POSTPONED`/`CANCELLED`): an interrupted game resolves to `DELAYED` and stays `isActive` so it remains visible to the frontend with a translated "Match interrompu" status, whereas the existing postponement/cancellation behavior is unchanged.

### `getOldiesGames(yearStr?, leagueParam?)`

Historical recovery over leagues × years. When no `yearStr` is given, it loops from `currentYear - 1` down to the oldest allowed year — the current (in-progress) year is excluded since it is already covered by the normal refresh. An explicit `?year=` (including the current year) still forces that single season. Logs `[Oldies] progress: <pct>% (<done>/<total>) — last: <LEAGUE> <year>` after each step (same pattern as `[getAllGames] progress`), so long recoveries show their advancement. The per-game insertion loop (oldies path, `addMissingOnly: true`) additionally logs `[Oldies] <LEAGUE> (season <year>): insert progress: <pct>% (<processed>/<total>) — added <n>` at 20% milestones + 100%, so the DB insertion phase shows advancement too.

### `getAllGames(forceUpdate, date, leagueList)`

Refreshes all available leagues, optionally scoped to a date or league list. When a
`date` is provided, only leagues whose regular season or playoffs window covers that
date are refreshed (`isCurrentSeason` / `isPlayoffsPeriod`); without a date (e.g. cron
jobs) every league is refreshed all year round regardless of season status.

**Progress logging**: logs the list of leagues to refresh, then for each league logs
`[getAllGames] refreshing <LEAGUE> (<i>/<total>)` before it starts, plus a milestone
line every 20 % (`[getAllGames] progress: 20% (2/10) — last: <LEAGUE>`), and a final
`[getAllGames] done`. If a league blocks mid-refresh, the last line points directly to it.

### `findAll()`

Returns all active games, enriched with team metadata.

### `filterGames({...})`

Builds a filtered game view by league, date range, team selection, and home/away criteria. It also fills placeholder rows for UI display when needed.

### `getDateRange(leagues?)`

Returns `{ minDate, maxDate }` from the active games aggregate. When a `leagues`
string is provided (comma/space/plus separated, uppercased) the min/max is scoped
to those leagues via `league: { $in }`; otherwise it spans every league. Returns
`{ minDate: null, maxDate: null }` when no active games match.

### `getClosestDates({ leagues, teamSelectedIds, date })`

Returns `{ previousDate, nextDate }` — the closest past and future game dates
(`YYYY-MM-DD`, or `null` when nothing matches). The reference boundary is the
optional `date` (`YYYY-MM-DD`); when omitted, today is used. The flow uses two
dedicated helpers so it is easy to follow:

1. `_buildClosestDatesFilter(leagues, teamSelectedIds)` turns the raw query params
   into a Mongo filter (same conventions as `findByDateHour` for leagues and
   `filterGames` for teams).
2. `_findClosestGameDate(filter, '$max')` — largest `gameDate` strictly **before**
   the boundary (past match).
3. `_findClosestGameDate(filter, '$min')` — smallest `gameDate` **from the
   boundary onwards** (upcoming match).

Both helpers are `private`; only `getClosestDates` is exposed.

### `findByTeam()` / `findResultsByTeam()`

Returns upcoming or completed games for a selected team. When no games are found for the
team, the league refresh is only triggered if the league is actually in season (regular
season or playoffs); off-season requests return the legitimately empty result without
hitting third-party APIs — the cron jobs keep data fresh all year round instead.

### `findByLeague()` / `findByDate()` / `findByDateHour()` / `findByDateLeague()`

Read-only schedule views used by the frontend tabs. On an empty result (no games for
the requested day/filters) they return `[]` / `{}` / `{ groups: [] }` immediately without
triggering any league refresh — data freshness is the cron jobs' responsibility (daily
per-league refreshes 2 AM–7 AM, monthly `getAllGames`, `checkLeagueGamesAvailability`
every 12 minutes, scores every 10 minutes). Previously, the empty paths of `findByDate` /
`findByDateHour` awaited `getAllGames(false, gameDate, ...)` (and `findAll()` on a
totally empty DB called `getAllGames()` with no date and no league filter), and the
"games found today" paths chained background `getLeagueGames` refreshes via
`refreshChain`; both were removed because they blocked the server (sequential
third-party schedule fetches under the 460 MB heap budget → OOM restarts).

`_findEnrichedGamesForDay(gameDate, leagues?, maxResults?, skip?)` (private) is the shared
query behind the day views:

1. Filter `{ isActive: true }` + `$expr: { $eq: ['$homeTeamId', '$teamSelectedId'] }` — a game
   is stored once per team, so this keeps exactly one row per game.
2. Optional `league: { $in: [...] }` (split on `,` / space / `+`, upper-cased) and `skip` / `limit`.
3. `gameDate` filter: for **today**, the day plus yesterday's games started less than 3 h ago;
   for any other date, exactly that `gameDate`.
4. Sort by `startTimeUTC`, then enrich each game (`_enrichGameWithTeamData`) after dropping
   `FINISHED` games older than 12 h (the same 12-hour guard as before).

`findByDateHour` groups the result by 30-minute UTC time slot (`HH:00` / `HH:30`).
`findByDateLeague` (added for the **past-day** view) returns the same games grouped by
**league** instead:

```
{ groups: [
    { key: 'FAVORITES', games: [...] },  // only when `favoriteTeams` matches
    { key: 'MLB', games: [...] },        // leagues in alphabetical order
    { key: 'NBA', games: [...] } ] }
```

- `favoriteTeams` (query param, `,` / space / `+` separated team `uniqueId`s) builds a leading
  `FAVORITES` section; those games are **also** kept in their league section (a duplicate view).
- League sections are ordered alphabetically (`localeCompare`; unknown/empty leagues fall back to
  the `OTHER` key, sorted like any other league name).
- Games are ordered from oldest to most recent (`startTimeUTC` ascending) inside every section.

All the grouping, ordering and favorites extraction happen server-side, so the client renders
the payload as-is (it only applies its own league/team/bookmark chips filters).

### `fetchGamesScores()`

Runs a recovery cycle that tries to fetch missing or stale scores for recent games from ESPN or PWHL sources.

### `fetchLiveScores(gameIds)`

Fetches live score updates for a specific list of game IDs.

### `syncRecentGames()`

Backfills games from recent dates to keep the database current.

### `findUsedTeamIds()` (new)

Returns the union of `teamSelectedId` + `homeTeamId` + `awayTeamId` over all
`isActive: true` games. Used by the stale-teams purge so a team still
referenced by any active game is never deleted (e.g. off-season leagues).

### `purgeStaleTeamsWithoutGames()` (new)

Collects `findUsedTeamIds()` then delegates to
`TeamService.purgeStaleTeamsWithoutGames()`. Exposed manually via
`POST /games/teams/purge-stale` (API key) and run weekly by
`CronService.purgeStaleTeams()` (Sunday 4AM UTC, after a teams refresh).

### `checkLeagueGamesAvailability()`

Performs availability checks and triggers a refresh if a league appears to have too few upcoming games.

### `purgeOldestMonthIfNeeded(force = false)`

**Capacity-based purge strategy**: Monitors disk usage and, when storage is at or above 96%, deletes **only the oldest
month of games** — a single, one-shot deletion per call.
**Behavior:**

- Runs every hour (via `monitorDiskCapacity` cron `0 */1 * * *`), manual via `POST /games/capacity/check`
- Calculates disk usage via MongoDB `dbStats` with `$collStats` fallback
- Returns `{ action: 'none' | 'purged', diskUsage, purgedYear?, purgedMonth?, deletedCount?, remainingYears? }`
- Caches last check to avoid excessive I/O (1-hour interval minimum between checks, bypassed with `force: true`)
- `force: true` also invalidates the 60s `getDiskUsage()` cache so each retry re-measures real usage

**Data Preservation:**

- Only triggers when disk usage ≥ 96% (`DISK_USAGE_THRESHOLD = 0.96`)
- Deletes **exactly one month per call** (the oldest one, e.g. `2016-09`) — never loops over years or months
- Repeated calls (hourly cron / manual endpoint) gradually free space, one month at a time
- ⚠️ **Regression fixed**: the previous implementation deleted whole years in a `for` loop and re-checked the disk
  after each deletion — but `getDiskUsage()` serves a 60-second cached value, so the loop condition never became
  false and the entire database could be wiped. The loop has been removed.

**Protected Data:**

- No arbitrary "after N years" deletion — only deletes when capacity requires it
- All years remain queryable via `findAll()`, `filterGames()`, `findByLeague()` until purged

### `getDiskUsage()` (private)

Calculates MongoDB disk usage via `dbStats` command with `$collStats` fallback.

**Production Hardening:**

- **Type-safe Mongoose access**: Uses `this.gameModel.db.db` (official Mongoose API) instead of unsafe `as any` casts
- **In-memory caching**: 60-second TTL cache (`DISK_USAGE_CACHE_TTL_MS`) prevents `dbStats` spam on frequent calls
- **Accurate size calculation**: Prioritizes `totalSize` for shared clusters (M0/M2/M5), falls back to `storageSize + indexSize` for dedicated clusters (M10+)
- **Percentage capping**: Clamped to max 1.0 (100%) to prevent misleading metrics
- **Critical threshold alerting**: Logs `console.warn` when usage exceeds 85% (before the 96% purge trigger)
- **Graceful degradation**: Returns last cached value on transient errors, ensuring continuity

**Returns:** `{ usedMB: number, totalMB: number, percentage: number }`

## Data Flow

1. The service receives a request from the controller.
2. It selects the appropriate source provider (ESPN, hockey data, etc.).
3. It normalizes and saves data into the `Game` model.
4. The frontend can then query the enriched game payloads.

## Capacity Management

- **Disk monitoring**: Automatic every hour (cron job)
- **Manual trigger**: `POST /games/capacity/check` (requires API key) — check + purge the oldest month if needed
- **Read-only status**: `GET /games/capacity/status` (requires API key) — same diagnostics as the check, but **without performing any deletion**; returns `diskUsage`, per-year breakdown (`years[]`), `teamCount`, `gameCount`, `threshold`, and `actionNeeded`.
- **Performance**: `getDiskUsage()` results are cached in-memory for 60 seconds to reduce load on the MongoDB cluster.
