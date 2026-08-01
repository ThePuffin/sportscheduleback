# File: `backend/src/teams/teams.service.ts`

## Purpose

This service manages the team catalog, including import from external providers, updates to records, and generation of frontend constants.

## Key Features

- **Team import** — fetches team lists from ESPN or PWHL sources
- **Persistence** — stores teams in MongoDB using the `Team` model
- **Record updates** — updates win/loss/tie information from fetched data
- **Frontend constant generation** — writes team, league and color files used by the frontend
- **League refresh support** — refreshes teams for one league or all leagues

## Main Responsibilities

### `create()`

Creates or updates a team document and optionally regenerates frontend constants.

### `getTeams(leagueParam?)`

Fetches teams for a specific league or for all supported leagues, imports them, and saves them to the database.

### `findAll(leagues?)` / `findAllLeagues()` / `findByLeague()` / `findOne()`

Expose team lookup helpers for the controller and other services.

### `updateRecord()`

Updates team records such as wins/losses and ties/OT losses.

### `generateLeaguesTeamsAndColorsFiles()`

Writes generated frontend files such as:

- `frontend/constants/Leagues.tsx`
- `frontend/constants/Teams.tsx`
- `frontend/constants/ColorsTeam.tsx`
- `frontend/constants/UniversityLogos.tsx`

This keeps the frontend constants synchronized with backend data.

## Data Flow

1. Team data is fetched from the provider.
2. It is normalized and saved through `create()`.
3. Frontend constants are regenerated so the app stays aligned with the backend.
