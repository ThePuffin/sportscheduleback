# File: `backend/src/games/tests/refresh-timestamps.service.spec.ts`

## Purpose

Tests the retention behavior of `RefreshTimestampService.pruneOldTimestamps()`.

## Coverage

- Confirms that records after the newest 40 are deleted by ID.
- Confirms that no deletion is attempted when there are no excess records.
