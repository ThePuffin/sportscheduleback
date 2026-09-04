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

### `deleteManyByIds(ids)`

Deletes teams by `uniqueId`. To be safe it also matches by `_id`, but **only** for ids that are valid
24-char hex ObjectIds. Plain textual ids such as `"PWHL-DET"` are matched via `uniqueId` only — passing
them into an `$in` on the ObjectId `_id` field used to throw a Mongoose `CastError`
(`Cast to ObjectId failed ... at path "_id"`).

### `generateLeaguesTeamsAndColorsFiles()`

Writes generated frontend files such as:

- `frontend/constants/Leagues.tsx`
- `frontend/constants/Teams.tsx`
- `frontend/constants/ColorsTeam.tsx` (+ mirror `backend/src/utils/ColorsTeam.ts`)
- `frontend/constants/UniversityLogos.tsx` (+ mirror `backend/src/utils/UniversityLogos.ts`)

For the **ColorsTeam** and **UniversityLogos** files the generation is **additive/update-only**:
instead of overwriting the whole file, it merges the freshly generated entries with the existing
content so that an entry that already exists is never dropped (`mergeGeneratedEntries`). Existing keys
that are no longer produced are kept, keys present in both are updated with the new value, and brand-new
keys are appended. This guarantees a regeneration never deletes a previously stored line.

## Data Flow

1. Team data is fetched from the provider.
2. It is normalized and saved through `create()`.
3. Frontend constants are regenerated so the app stays aligned with the backend.
