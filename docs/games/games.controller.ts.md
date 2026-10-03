# File: `backend/src/games/games.controller.ts`

## Purpose

This controller exposes the HTTP API for game data operations.

## Key Features

- Lists games, filters by team/league/date, and retrieves game details
- Supports game refresh and score sync endpoints
- Provides admin-only deletion/update routes using the API key guard

## Main Endpoints

### Read operations

- `GET /games` — returns all active games
- `GET /games/team/:teamSelectedId` — returns games for a team
- `GET /games/team/:teamSelectedId/results` — returns completed results for a team
- `GET /games/league/:league/results` — returns completed results for a league
- `GET /games/filter` — filters games by date range and team selection
- `GET /games/dates/range` — returns min/max game dates (optional `leagues` query param scopes the range to the given league list)
- `GET /games/dates/closest` — returns the closest past and upcoming game dates (`previousDate`/`nextDate`), optionally scoped by `leagues` and/or `teamSelectedIds`, relative to an optional reference `date` (defaults to today)
- `GET /games/date/:gameDate` — returns games for a specific date
- `GET /games/hour/:gameDate` — returns games grouped by hour slots
- `GET /games/league-day/:gameDate` — returns games grouped by **league** (query params: `leagues`, `maxResults`, `skip`, `favoriteTeams`); adds a leading `FAVORITES` group when `favoriteTeams` matches games of that day. Used by the frontend day view for past dates.
- `GET /games/league/:league` — returns games for a league
- `GET /games/:uniqueId` — returns a single game

### Refresh and sync

- `POST /games/refresh/all` — refreshes all leagues
- `POST /games/refresh/oldies` — recovers historical games (`year`/`league` query params optional). The capacity check run after every league × year step is **forced by default** (`?force=false` restores the 1-hour throttled behavior), so a long recovery cannot fill the database up to 100%.
- `POST /games/refresh/allOldies` — recovers history league by league (leagues in **random order** via
  `Object.values(League).sort(() => Math.random() - 0.5)`); after **each league's** `getOldiesGames`,
  retries `purgeOldestMonthIfNeeded(true)` up to **5 times** with a **30-second wait between attempts**
  (except after the last one) to let disk usage settle. The `force: true` flag bypasses the 1-hour check
  guard and invalidates the 60s disk-usage cache so each retry re-measures real usage. Long-running
  request (minutes per league), returns `void`.
- `POST /games/refresh/:league` — refreshes one league
- `POST /games/sync/recent` — syncs recent games from external sources
- `POST /games/scores` — recovers missing scores
- `POST /games/refresh/records` — refreshes `team.record` for leagues whose season (regular season or playoffs) covers today; **writes no game**. Run twice a day by the `refreshTeamRecordsMorning()` / `refreshTeamRecordsAfternoon()` crons
- `POST /games/live` — fetches live scores for selected game IDs

### Admin mutation routes

- `PATCH /games/:uniqueId`
- `DELETE /games/league/:league`
- `DELETE /games/all`
- `DELETE /games/duplicate`
- `DELETE /games/:uniqueId`

### Capacity management

- `POST /games/capacity/check` (API key) — check disk usage and purge **only the oldest month** (single shot, no loop) if ≥ 97% usage
- `GET /games/capacity/status` (API key) — read-only capacity report: disk usage, per-year game counts, team/game totals, and `actionNeeded` flag (no deletion performed)

## Data Flow

1. The controller receives HTTP requests.
2. It delegates the work to `GameService`.
3. The result is returned to the client as JSON.
