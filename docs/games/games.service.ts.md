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

### `findByLeague()` / `findByDate()` / `findByDateHour()`

Read-only schedule views used by the frontend tabs. On an empty result (no games for
the requested day/filters) they return `[]` / `{}` immediately without triggering any
league refresh — data freshness is the cron jobs' responsibility (daily per-league
refreshes 2 AM–7 AM, monthly `getAllGames`, `checkLeagueGamesAvailability` every 12
minutes, scores every 10 minutes). Previously, the empty paths of `findByDate` /
`findByDateHour` awaited `getAllGames(false, gameDate, ...)` (and `findAll()` on a
totally empty DB called `getAllGames()` with no date and no league filter), and the
"games found today" paths chained background `getLeagueGames` refreshes via
`refreshChain`; both were removed because they blocked the server (sequential
third-party schedule fetches under the 460 MB heap budget → OOM restarts).

### `fetchGamesScores()`

Runs a recovery cycle that tries to fetch missing or stale scores for recent games from ESPN or PWHL sources.

### `fetchLiveScores(gameIds)`

Fetches live score updates for a specific list of game IDs.

### `syncRecentGames()`

Backfills games from recent dates to keep the database current.

### `checkLeagueGamesAvailability()`

Performs availability checks and triggers a refresh if a league appears to have too few upcoming games.

### `purgeOldestYearsIfNeeded()`

**Capacity-based purge strategy**: Monitors disk usage and automatically purges entire years of games (oldest first) when
storage exceeds 90%. This preserves as much historical data as possible while preventing disk space exhaustion.

**Behavior:**

- Runs every 6 hours (via cron job)
- Calculates disk usage via MongoDB `dbStats` with `$collStats` fallback
- Returns `{ action: 'none' | 'purged', diskUsage, purgedYears?, remainingYears? }`
- Caches last check to avoid excessive I/O (1-hour interval minimum between checks)

**Data Preservation:**

- Games are deleted **year by year** (e.g., all 2020 games, then all 2019, etc.)
- Only triggers when disk usage ≥ 90%
- Stops purging once usage drops below 90%

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
- **Critical threshold alerting**: Logs `console.warn` when usage exceeds 85% (before the 90% purge trigger)
- **Graceful degradation**: Returns last cached value on transient errors, ensuring continuity

**Returns:** `{ usedMB: number, totalMB: number, percentage: number }`

## Data Flow

1. The service receives a request from the controller.
2. It selects the appropriate source provider (ESPN, hockey data, etc.).
3. It normalizes and saves data into the `Game` model.
4. The frontend can then query the enriched game payloads.

## Capacity Management

- **Disk monitoring**: Automatic every 6 hours (cron job)
- **Manual trigger**: `POST /games/capacity/check` (requires API key) — check + purge if needed
- **Read-only status**: `GET /games/capacity/status` (requires API key) — same diagnostics as the check, but **without performing any deletion**; returns `diskUsage`, per-year breakdown (`years[]`), `teamCount`, `gameCount`, `threshold`, and `actionNeeded`.
- **Performance**: `getDiskUsage()` results are cached in-memory for 60 seconds to reduce load on the MongoDB cluster.
