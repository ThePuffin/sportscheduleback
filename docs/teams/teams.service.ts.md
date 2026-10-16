# File: `backend/src/teams/teams.service.ts`

## Purpose

This service manages the team catalog, including import from external providers, updates to records, and generation of frontend constants.

## Key Features

- **Team import** — fetches team lists from ESPN or PWHL sources
- **Game-count filter** — `GET /teams?minGames=<n>` returns only the teams having at least `n`
  active games, computed on the fly from the games collection (see
  `countActiveGamesByTeam()`); teams marked `isActive: false` (historical/retired) are excluded
  as well, so they can never be picked. The Game model is injected here for that purpose only,
  without importing `GameService` (no circular dependency)
- **Team activation** — teams returned by a current provider roster are saved with `isActive: true`; records created from historical games remain inactive until returned by a current roster
- **Persistence** — stores teams in MongoDB using the `Team` model
- **Record updates** — updates win/loss/tie information from fetched data
- **Frontend constant generation** — writes team, league and color files used by the frontend
- **League refresh support** — refreshes teams for one league or all leagues

## Main Responsibilities

### `create()`

Creates or updates a team document and optionally regenerates frontend constants.

### `getTeams(leagueParam?)`

Fetches teams for a specific league or for all supported leagues, imports them, and saves them to the database. Triggered manually via `POST /teams/refresh?leagueParam=<LEAGUE>` or by the monthly `updateTeams` cron. At the end of the run only (never during game fetches), `backfillMissingUniversityLogos()` adds missing university logo links under both `'{LEAGUE}-{ABBREV}'` and plain `'{ABBREV}'` keys when the file has no entry (or an empty string) for them.

### `findAll(leagues?, options?)` / `findAllLeagues()` / `findByLeague()` / `findOne()`

Expose team lookup helpers for the controller and other services.

`findAll()` accepts an optional `options.minGames` (number or raw query string). When it is a
positive integer, only the teams having **at least** that many active games **and** still active
(`isActive !== false`) are returned — `GET /teams?minGames=4` therefore means "more than 3 games".
The threshold is inclusive, truncated rather than rounded (`'3.9'` → `3`), and `undefined` / `''` /
non-numeric / negative / `0` all mean **no filter**, in which case no aggregation runs at all, the
`isActive` condition is not applied either, and the response is exactly what it was before the
parameter existed — retired teams are still returned there, because the full catalog backs display
and opponent metadata. Every internal caller of `findAll()` (nine call sites in
`GameService`: enrichment, league refresh, day views, stale-team purge) passes no options and is
therefore unaffected.

When `leagues` is given and the query matches **no** team, the missing league is re-fetched
from the provider — **for that league only** (`getTeams(leagues[0])`), and the result is filtered
back on `leagues`. The bootstrap call `getTeams()` with no argument stays reserved for the
no-filter case. Previously the fallback ran unfiltered whatever the caller had asked for, so a
single-league lookup (e.g. `GameService._fetchUniqueGames('NWSL')`) received the teams of **every**
league and then processed them all under the one requested `leagueName`, building schedule URLs
from a league those teams do not belong to.

**Olympic deduplication scope:** `findAll()` itself is intentionally **not** deduplicated —
`GameService` relies on it for per-sport enrichment (`_fetchUniqueGames`) and league discovery
(`getAllGames`), so every Olympic team is still returned there. Olympic deduplication applies only
to the static file generation (`generateLeaguesTeamsAndColorsFiles()`, `Teams.tsx`) and to the
HTTP `GET /teams` response (controller output).

### `countActiveGamesByTeam()` / `clearActiveGameCountCache()`

Backs the `minGames` filter of `findAll()`: returns a `Map<uniqueId, number>` of how many
**active regular-season or playoff** games each team has, past and upcoming alike.

- **Counted on `teamSelectedId`, never on `homeTeamId`/`awayTeamId`.** A match is stored
  **twice** — one document per participating upstream feed, with a `uniqueId` prefixed by that
  team (`NHL-ANA-…` and `NHL-VGK-…`) — and both copies carry the same `homeTeamId`/`awayTeamId`,
  so counting either of those would double every total. `teamSelectedId` yields exactly one
  document per team per match. The synthetic placeholder rows of `findByDateHour()` (empty
  `teamSelectedId`) are skipped, as are legacy documents without the field.
- **Preseason games are excluded** (`recordSeasonType: { $ne: 1 }`, phases being `1` = preseason,
  `2` = regular season, `3` = playoffs). Without it a franchise that only ever appears in
  exhibitions would reach the threshold on friendlies alone and become selectable as an
  "official" team. The exclusion is a `$ne`, **not** an `$in: [2, 3]`, so it only drops games
  positively known to be preseason: documents stored before the phase was persisted carry no
  value, and the whole PWHL feed reports no phase — an `$in` would silently hide those real
  teams. Same reasoning as `_propagateTeamRecordToSeasonGames()`, which matches `{ $in: [2, null] }`.
- **Inactive games are excluded** (decided series, expired grace period, stale unresolved
  fixtures), so the count matches what the app actually shows.
- **One aggregation, memoised for 5 minutes** (`ACTIVE_GAME_COUNT_CACHE_TTL_MS`): a burst of
  parallel `GET /teams` requests costs a single pass, and `clearActiveGameCountCache()` lets
  `GameService` drop the memo as soon as it writes or deletes games.
- **Cost**: served from the `{ isActive: 1, teamSelectedId: 1, recordSeasonType: 1 }` index
  declared in `game.schema.ts`, which covers every field used here (the phase included, so the
  `$ne` filter is evaluated in the index), so no game document is read. The counts are
  deliberately **not** stored on the team documents: the games collection has about ten
  write/delete paths (`create()`, `removeDuplicatesAndOlds()`, `_deleteGamesOfPurgedTeams()`, the
  disk-capacity purge that deletes a whole month, …) and a stored counter maintained incrementally
  would drift silently the first time one of them is missed.

### `updateRecord()`

Updates team records such as wins/losses and ties/OT losses.

### `resetLeagueRecords(league)`

Zeroes the current-season tally (`wins` / `losses` / `ties` / `otLosses`) of every team of `league` in one `updateMany`, and returns the number of documents modified. Called by `GameService.finalizeFinishedSeasonRecords()` once a league's season is over (no game started in 2 months), right after the end-of-season tally has been frozen onto that league's games, so the next season's upcoming games start from a blank tally instead of the previous season's final record.

### `purgeNonD1Teams(league, espnTeams?)`

Deletes the stored teams of `league` that ESPN no longer lists as Division 1 (set difference between the stored `uniqueId`s and the D1-filtered ESPN roster). This covers parent-marker leagues plus NCAAMH and NCAAWH, whose ESPN D1 roster filters use explicit allowlists. The already-fetched roster can be passed as `espnTeams` (as `getTeams()` does) so a refresh does not query ESPN twice.

Safety rules: never deletes on an empty ESPN roster (outage guard), never deletes `HistoricalTeams` entries or `isActive === false` teams. Returns the deleted `uniqueId`s; `getTeams()` queues them in `lastPurgedNonD1Ids` so `GameService._deleteGamesOfPurgedTeams()` can cascade the deletion to their games (pull via `takeLastPurgedNonD1Ids(league?)`, no Team↔Game circular dependency). When `league` is given, only the ids carrying that league's prefix are drained — each league's game refresh cascades its own purge while the other leagues' ids stay queued (a global drain would be consumed by the first refresh, whose `league` filter never matches them).

### `findStaleTeamCandidates()`

Returns teams whose `updateDate` is older than 2 months (60 days) or missing —
i.e. teams no longer returned by the provider. Excludes `isActive === false`
and `HistoricalTeams` entries (never physically deleted).

### `purgeStaleTeamsWithoutGames(usedTeamIds)`

Deletes stale candidates (see above) that are referenced by **no** active game
(`usedTeamIds` is supplied by `GameService.findUsedTeamIds()`, avoiding a
circular Team↔Game dependency).

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
keys are appended. This guarantees a regeneration never deletes a previously stored line. For colors,
if the database still has the exact default placeholder (or no color fields) and the existing file
contains a non-placeholder palette, regeneration retains that palette. A later non-placeholder
database value can still update it.

**Team filtering in `Teams.tsx`:** `generateLeaguesTeamsAndColorsFiles()` only writes teams that
actually play to the frontend constant:
- **Regular leagues** — at least `TEAMS_CONSTANT_MIN_GAMES` (10) active (non-preseason) games,
  computed via `countActiveGamesByTeam()`.
- **Olympic teams** (`OLYMPICS-*` ids) — at least 1 active game, so country delegations are never
  empty.
- **Olympic deduplication** — when both `OLYMPICS-HOCKEY-{GENDER}-{PAYS}` and
  `OLYMPICS-BASKETBALL-{GENDER}-{PAYS}` exist, only one entry per country/gender
  (`OLYMPICS-{MEN|WOMEN}-{PAYS}`) is written to `Teams.tsx`. The representative is the
  **first-encountered** team in the group (no lexicographic tie-break favoring basketball), and its
  ID is unified to `OLYMPICS-{GENDER}-{COUNTRY}` (e.g. `OLYMPICS-WOMEN-USA`) so neither sport is
  arbitrarily favored. The sport-specific IDs are preserved in the color entries below for match
  display and in `findAll()` for `GameService` enrichment.
Teams marked `isActive: false` and `HistoricalTeams` entries are still excluded as before.

## Data Flow

1. Team data is fetched from the provider.
2. It is normalized and saved through `create()`.
3. Frontend constants are regenerated so the app stays aligned with the backend.
