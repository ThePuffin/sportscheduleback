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
- **Monitors disk usage and auto-purges old data when capacity reaches 97%**

## Key Scheduled Jobs

| Job                              | Schedule               | Purpose                                             |
| -------------------------------- | ---------------------- | --------------------------------------------------- |
| `onModuleInit()` recovery        | Once at startup (+2 min) | Season-gated `getAllGames(false, new Date())` — fills a cold/stale DB outside cron windows |
| **`refreshLeaguesOneByOne()`**   | **Every 10 min (window 4 AM-11 AM NY)** | **League rotation: ONE league per tick through the `League` enum, frequency-gated by `needRefresh()` (playoffs: 1 day, season: 3 days, off-season: 7 days), stops until the next day once the list is complete** |
| `updateTeams()`                  | Monthly (0:30 AM, 1st) | Refresh all teams                                   |
| `updateAllGames()`               | Monthly (1:00 AM, 1st) | Full league refresh                                 |
| `getOldGames()`                  | Daily (10:00 AM)       | Historical season recovery (one random league + random past year `[currentYear - maxYearBeforeDelete .. currentYear - 1]` per tick; anti-reentrancy) |
| `fetchAndApplyScores()`          | Every 10 min, offset :02 (`2-59/10`) | Live score updates (NY business hours 11 AM - 4 AM); **skips while the rotation/oldies run** |
| `checkLeagueGamesAvailability()` | Every 12 min, offset :07 (`7-59/12`) | Availability checks (LA early hours 0-11 AM); **skips while the rotation/oldies run** |
| **`refreshTeamRecordsMorning()`** | **Daily (`0 6 * * *` = 3 AM Pacific / 6 AM New York, 9 AM NY in DST)** | **Refreshes `team.record` for in-season leagues only (regular season or playoffs); no game is written** |
| **`refreshTeamRecordsAfternoon()`** | **Daily (`0 15 * * *` = 9 AM Pacific / 12 PM New York, 3 PM NY in DST)** | **Same midday safety net, so a failed or skipped morning run is caught the same U.S. day** |
| **`purgeStaleTeams()`**           | **Weekly Sunday 4AM UTC**       | **Refresh teams, then delete teams stale for more than 2 months with no active game** |
| **`monitorDiskCapacity()`**      | **Every hour (`0 */1 * * *`)** | **Disk usage check & purge of the oldest month**     |

## Team records refresh (`refreshTeamRecordsMorning` / `refreshTeamRecordsAfternoon`)

Two daily crons, both delegating to the private `runTeamRecordsRefresh(slot)`:

- `refreshTeamRecordsMorning()` — `0 6 * * *` = **3:00 AM `America/Los_Angeles`** (6 AM New York in winter, 9 AM New York in DST). The two U.S. coasts are 3 hours apart, so anchoring on Los Angeles is the literal "3 AM U.S." slot; anchoring on New York would land on 0 AM / 3 AM locally.
- `refreshTeamRecordsAfternoon()` — `0 15 * * *` = **9:00 AM Pacific / 12:00 PM New York** (3 PM New York in DST). Midday safety net: if the morning run was skipped or failed, the tally is still refreshed the same U.S. day, after the previous night's games have been played.

Both call `GameService.refreshCurrentSeasonRecords()`, which:

- keeps only leagues where `isCurrentSeason()` **or** `isPlayoffsPeriod()` covers today (off-season leagues are skipped before any third-party call, so they cost nothing);
- fetches each kept league's schedule through `_fetchUniqueGames()` **without persisting anything** — the games are discarded, only the per-team tallies are harvested;
- writes the result through `TeamService.updateRecords()` and returns `{ leagues, updatedTeams }`.

**Guards:** never runs while `isHeavyRefreshRunning` (league rotation / oldies), never overlaps itself (`isRefreshingTeamRecords` flag, released in `finally`), and a failing league is logged without aborting the others.

**Manual trigger:** `POST /games/refresh/records` (API key).

## New: `monitorDiskCapacity()`

Runs the disk capacity check and, when storage reaches 97%, purges **only the oldest month** of games (single shot — never a loop over years).

**Execution:**

- Runs every hour automatically (`0 */1 * * *`)
- Logs action taken: `'none'` (capacity OK) or `'purged'` (oldest month removed)
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
4. Disk capacity is monitored automatically; the oldest month is purged only when needed.
