# Backend Architecture & Recent Changes

> **📚 Per-file documentation:** For AI-readable documentation of backend modules, see the [docs](./docs/) directory. Each file has a matching Markdown explanation of its purpose, key features, responsibilities and data flow.

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
