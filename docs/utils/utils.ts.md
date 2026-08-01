# File: `backend/src/utils/utils.ts`

## Purpose

This utility module contains helper functions for league season detection, refresh decisions, and date calculations.

## Key Features

- Maps leagues to their season configuration
- Detects whether a league is in regular season or playoffs
- Determines whether game data should be refreshed
- Provides date helpers such as season overlap checks

## Main Functions

### `getLeagueConfig(leagueName)`

Returns league metadata such as sport, ESPN identifier and season period boundaries.

### `isInThePeriod(start, end)`

Checks whether the current date falls inside a given month-based period.

### `isCurrentSeason(leagueName, date?)`

Determines whether the provided date falls in the active regular season window.

### `isPlayoffsPeriod(leagueName, date?)`

Determines whether the provided date falls in the active playoff window.

### `doesDateRangeOverlapLeaguePeriod(...)`

Checks whether a requested date range overlaps the active season/playoff period for a league.

### `needRefresh(leagueName, games)`

Decides whether a league should be refreshed based on age of the current game data.

## Data Flow

1. The service asks these helpers whether a league is currently active.
2. The helpers use league config plus date logic to return a boolean.
3. The game service uses the result to decide whether a refresh is necessary.
