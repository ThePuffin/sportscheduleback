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
- `GET /games/dates/range` — returns min/max game dates
- `GET /games/date/:gameDate` — returns games for a specific date
- `GET /games/hour/:gameDate` — returns games grouped by hour slots
- `GET /games/league/:league` — returns games for a league
- `GET /games/:uniqueId` — returns a single game

### Refresh and sync

- `POST /games/refresh/all` — refreshes all leagues
- `POST /games/refresh/:league` — refreshes one league
- `POST /games/sync/recent` — syncs recent games from external sources
- `POST /games/scores` — recovers missing scores
- `POST /games/live` — fetches live scores for selected game IDs

### Admin mutation routes

- `PATCH /games/:uniqueId`
- `DELETE /games/league/:league`
- `DELETE /games/all`
- `DELETE /games/duplicate`
- `DELETE /games/:uniqueId`

## Data Flow

1. The controller receives HTTP requests.
2. It delegates the work to `GameService`.
3. The result is returned to the client as JSON.
