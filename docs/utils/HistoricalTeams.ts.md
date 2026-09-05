# File: `backend/src/utils/HistoricalTeams.ts`

## Purpose

Static fallback map (same role as `UniversityLogos`) describing **historical teams**
(defunct, relocated or renamed franchises) so that old ("oldies") games can be
enriched with a real name, logo and colors even when the team has no living record
in the database anymore.

## Key Feature

- A `Record<string, HistoricalTeamEntry>` keyed by the full `uniqueId` of the team
  (`'{LIGUE}-{ABBREV}'`), which matches the exact format used by `homeTeamId` /
  `awayTeamId` on stored games. Example: `'NBA-SEA'` -> Seattle SuperSonics.

## Entry shape (`HistoricalTeamEntry`)

- `abbrev` • `label` (display name) • `teamLogo` • `teamLogoDark?` • `color?` •
  `backgroundColor?` • `record?` (optional standings summary) • `isActive?` (always
  `false` for historical teams).

## Main Responsibilities

### Fallback in `GameService._enrichGameWithTeamData`

When `teamsMap.get(game.homeTeamId)` / `.get(game.awayTeamId)` returns `undefined`
(team absent from the database), the enricher now falls back to
`HistoricalTeams[game.homeTeamId]` / `HistoricalTeams[game.awayTeamId]`. This gives
old games a correct team name, logo, color and record at render time.

## Limitations

- **No new-game fetching**: this file only resolves **enrichment/display** of games
  already in the database. It cannot pull in new historical games because fetching
  ESPN calendars requires the team's numeric `id` (handled by a Core API
  `seasons/{year}/teams` sync, see changelog). `HistoricalTeamEntry` intentionally
  carries no numeric ESPN `id`.

## Guards / non-regression

- `GameService._deleteUnlinkedTeams` never deletes a team whose `uniqueId` exists in
  `HistoricalTeams`, nor teams marked `isActive === false`.
- `TeamService.generateLeaguesTeamsAndColorsFiles` excludes `HistoricalTeams` keys and
  `isActive === false` teams from `Teams.tsx`, so defunct teams never pollute the
  frontend filter / favorites.

## Data Flow

1. A game row references `homeTeamId` / `awayTeamId`.
2. `_enrichGameWithTeamData` looks the id up in the DB `teamsMap`.
3. On miss, it falls back to this static file.
4. The frontend renders the enriched payload (name/logo/colors).