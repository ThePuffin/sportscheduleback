# File: `backend/src/games/games.service.ts`

## Purpose

This is the core business logic module for games. It fetches schedules and scores from external providers, stores them in MongoDB, enriches them with team data, and exposes query helpers for the frontend.

## Key Features

- **Game import and refresh** — pulls schedule data for leagues and stores it in MongoDB
- **Live score updates** — updates ongoing games with score and status data
- **Data enrichment** — attaches team names, logos, records and colors
- **Query helpers** — returns upcoming games, results, date-range data and hour-grouped schedules
- **Maintenance logic** — removes duplicates, old games and invalid score records

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

### `getAllGames(forceUpdate, date, leagueList)`

Refreshes all available leagues, optionally scoped to a date or league list.

### `findAll()`

Returns all active games, enriched with team metadata.

### `filterGames({...})`

Builds a filtered game view by league, date range, team selection, and home/away criteria. It also fills placeholder rows for UI display when needed.

### `findByTeam()` / `findResultsByTeam()`

Returns upcoming or completed games for a selected team.

### `findByLeague()` / `findByDate()` / `findByDateHour()`

Provides schedule views used by the frontend tabs.

### `fetchGamesScores()`

Runs a recovery cycle that tries to fetch missing or stale scores for recent games from ESPN or PWHL sources.

### `fetchLiveScores(gameIds)`

Fetches live score updates for a specific list of game IDs.

### `syncRecentGames()`

Backfills games from recent dates to keep the database current.

### `checkLeagueGamesAvailability()`

Performs availability checks and triggers a refresh if a league appears to have too few upcoming games.

## Data Flow

1. The service receives a request from the controller.
2. It selects the appropriate source provider (ESPN, hockey data, etc.).
3. It normalizes and saves data into the `Game` model.
4. The frontend can then query the enriched game payloads.
