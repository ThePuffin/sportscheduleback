# File: `backend/src/games/refresh-timestamps.service.ts`

## Purpose

Provides persistence operations for game refresh timestamp records.

## Key Features

- Records manual and automatic refreshes (and retains compatibility with existing recovery records).
- Retrieves refresh timestamps for per-league cooldown and recovery checks.
- `pruneOldTimestamps()` retains the 40 newest records across all leagues and
  refresh types, deleting only records beyond that limit.

## Data Flow

The daily `CronService.pruneRefreshTimestamps()` job calls
`pruneOldTimestamps()`. The service sorts records newest-first, skips the newest
40, and deletes the remaining records by their IDs. It returns the number of
records deleted, or zero when no records exceed the retention limit.
