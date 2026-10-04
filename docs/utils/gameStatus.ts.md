# File: `backend/src/utils/gameStatus.ts`

## Purpose

Single source of truth for **what makes a game status terminal** (the game was played, cancelled or
postponed). Shared by `GameService.fetchGamesForLiveScoreUpdate()` and
`GameService.removeStaleUnresolvedGames()` so the score cycle and the stale-game purge can never
disagree on whether a game is still to be resolved.

## Key Features

- **`TERMINAL_GAME_STATUSES`** — the canonical list `['FINISHED', 'FINAL', 'CANCELLED', 'POSTPONED']`,
  used directly in Mongo `$nin` filters.
- **`isTerminalGameStatus(status)`** — the same decision in TypeScript, case insensitive and tolerant
  of the variants found in stored records: `FINISHED`, `FINAL`, `FULL TIME` / `FULL_TIME`,
  `CANCELLED` / `CANCELED`, `POSTPONED`, plus suffixed finals such as `FINAL AET` / `FINAL PEN`.
  The regex is anchored (`^`), so a status that merely *contains* a word (`"NOT FINAL YET"`) does not
  match. Falsy input (`undefined`, `null`, `''`) → `false`.

## Why the suffixed variants matter

A fully played game can be stored under a non-canonical status. `STATUS_FINAL_AET` (after extra time)
and `STATUS_FINAL_PEN` (shootout) used to be written as `"FINAL AET"` / `"FINAL PEN"` by the import
path, and no terminal-state check recognized those values — so `removeStaleUnresolvedGames()`
classified a completed match with a known score (e.g. MLS `MLS-SEA-557514`, final 4-3) as
"unresolved" and deleted it. Two independent guards now prevent that: the import path normalizes
statuses by family (see `resolveScheduleGameStatus()` in `espnAllData.ts`), and this module makes the
purge itself tolerant.

## Data Flow

1. `getEachTeamSchedule()` normalizes the ESPN `STATUS_*` name through `resolveScheduleGameStatus()`.
2. `fetchGamesForLiveScoreUpdate()` uses `TERMINAL_GAME_STATUSES` in its Mongo `$nin` filter to pick
   games still needing a score.
3. `removeStaleUnresolvedGames()` applies `TERMINAL_GAME_STATUSES` in its query, then re-checks each
   candidate with `isTerminalGameStatus()` and spares the ones that are actually decided.
