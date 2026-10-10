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

For the Olympic aggregates (`OLYMPICS-MEN` / `OLYMPICS-WOMEN`) it also picks the sport by date —
Winter (hockey) vs Summer (basketball) — and returns the **valid** ESPN scoreboard slug for that
sport, the same ones used by `leagueConfigs` in `espnAllData.ts`: `olympics-mens-ice-hockey` /
`olympics-womens-ice-hockey` and `mens-olympics-basketball` / `womens-olympics-basketball`. These
`sport`/`league` values feed `fetchLeagueDates()`'s `scoreboard` request, so they must be endpoints
ESPN answers with 200 (the earlier `basket` typo and the `olympics.men`/`olympics.women` slugs all
returned 400). `isCurrentSeason`, `isPlayoffsPeriod` and `getCurrentSeasonYears` only read the
`startSeason`/`endSeason`/`endPlayoffs` boundaries, not the slug.

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
