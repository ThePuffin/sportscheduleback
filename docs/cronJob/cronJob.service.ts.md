# File: `backend/src/cronJob/cronJob.service.ts`

## Purpose

This service runs scheduled background jobs for refreshing teams, games and scores, and monitoring disk capacity.

## Key Features

- Starts an initial score recovery cycle after server startup
- **Schedules a season-gated recovery games fetch at startup (`getAllGames(false, new Date())` after 2 min)**
- Refreshes team data on a monthly schedule
- Refreshes league game data on scheduled times
- Periodically fetches scores for live games
- Checks league availability and triggers refreshes when needed
- **Monitors disk usage and auto-purges old data when capacity exceeds 90%**

## Key Scheduled Jobs

| Job                              | Schedule               | Purpose                                             |
| -------------------------------- | ---------------------- | --------------------------------------------------- |
| `onModuleInit()` recovery        | Once at startup (+2 min) | Season-gated `getAllGames(false, new Date())` — fills a cold/stale DB outside cron windows |
| **`refreshLeaguesOneByOne()`**   | **Every 10 min (window 4 AM-11 AM NY)** | **League rotation: ONE league per tick through the `League` enum, season-gated (skip off-season), stops until the next day once the list is complete** |
| `updateTeams()`                  | Monthly (0:30 AM, 1st) | Refresh all teams                                   |
| `updateAllGames()`               | Monthly (1:00 AM, 1st) | Full league refresh                                 |
| `getOldGames()`                  | Daily (10:00 AM)       | Historical season recovery (one random year per tick; anti-reentrancy)          |
| `fetchAndApplyScores()`          | Every 10 min, offset :02 (`2-59/10`) | Live score updates (NY business hours 11 AM - 4 AM); **skips while the rotation/oldies run** |
| `checkLeagueGamesAvailability()` | Every 12 min, offset :07 (`7-59/12`) | Availability checks (LA early hours 0-11 AM); **skips while the rotation/oldies run** |
| **`monitorDiskCapacity()`**      | **Every 6 hours**      | **Disk usage check & auto-purge old years**         |

## New: `monitorDiskCapacity()`

Runs the disk capacity check and automatically purges entire years of games when storage exceeds 90%.

**Execution:**

- Runs every 6 hours automatically
- Logs action taken: `'none'` (capacity OK) or `'purged'` (years removed)
- Logs remaining years after purge for transparency

**Manual Trigger:**

```bash
curl -X POST http://localhost:3000/games/capacity/check \
  -H "x-api-key: YOUR_API_KEY"
```

## Data Flow

1. The Nest scheduler triggers the job based on cron expressions.
2. The service delegates to `TeamService` and `GameService`.
3. Data is refreshed or updated in MongoDB without manual intervention.
4. Disk capacity is monitored automatically; old years are purged only when needed.
