# File: `backend/src/cronJob/cronJob.service.ts`

## Purpose

This service runs scheduled background jobs for refreshing teams, games and scores.

## Key Features

- Starts an initial score recovery cycle after server startup
- Refreshes team data on a monthly schedule
- Refreshes league game data on scheduled times
- Periodically fetches scores for live games
- Checks league availability and triggers refreshes when needed

## Key Scheduled Jobs

- `updateTeams()` — monthly team refresh
- `updateAllGames()` — monthly all-league refresh
- `updateMLBGames()` / `updateNBAGames()` / `updateNFLGames()` / `updateNHLGames()` — daily league refreshes
- `fetchAndApplyScores()` — every 10 minutes, during active game hours
- `checkLeagueGamesAvailability()` — every 12 minutes, with league-specific checks

## Data Flow

1. The Nest scheduler triggers the job based on cron expressions.
2. The service delegates to `TeamService` and `GameService`.
3. Data is refreshed or updated in MongoDB without manual intervention.
