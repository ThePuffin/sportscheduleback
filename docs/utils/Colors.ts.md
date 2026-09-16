# File: `backend/src/utils/Colors.ts`

## Purpose

Central color registry for the backend. It merges the generated per-team colors
(`ColorsTeamEnum` from `ColorsTeam.ts`) with the global `Colors.default`
placeholder, and exposes helpers to resolve a team's colors from its `uniqueId`.

## Key Features

- **`Colors`** — `Record<string, TeamColors>` map keyed by `uniqueId`
  (`{LEAGUE}-{ABBREV}`), plus the `default` entry (`#ffffff` on `#000000`).
- **`DEFAULT_TEAM_COLORS`** — single source of truth for the placeholder
  (`color: '#ffffff'`, `backgroundColor: '#000000'`).
- **`isDefaultTeamColors(colors)`** — case-insensitive check for that placeholder.
- **`COLLEGE_LEAGUES`** — the six university leagues
  (`NCAAF, NCAAB, NCCABB, WNCAAB, NCAAMH, NCAAWH`).
- **`getTeamColors(uniqueId)`** — resolution helper:
  1. known non-placeholder entry → returned as-is;
  2. university league with a missing/placeholder entry → the same university
     abbreviation is looked up in the other college leagues (a school keeps the
     same colors across sports, e.g. `NCAAB-X` borrows `NCAAF-X` / `NCAAMH-X`);
  3. anything else (non-college leagues included) → `DEFAULT_TEAM_COLORS`.

## Consumers

- `backend/src/utils/fetchData/espnAllData.ts` — ESPN team mapping fallback when
  `color`/`alternateColor` are missing.
- `backend/src/utils/fetchData/hockeyData.ts` — NHL / PWHL team mapping.
- `backend/src/games/games.service.ts` — `_resolveTeamColors()` display fallback
  in `_enrichGameWithTeamData()`.

## Notes

- `ColorsTeam.ts` / `frontend/constants/ColorsTeam.tsx` are regenerated from the
  DB by `TeamService.generateLeaguesTeamsAndColorsFiles()`; entries whose colors
  could not be retrieved are stored as the placeholder and are therefore
  eligible for the cross-college fallback.
- Only the exact placeholder (`#ffffff` on `#000000`) is treated as "unknown".
  Other degenerate entries stored in `ColorsTeam.ts` are returned as-is.
