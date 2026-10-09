# Backend Architecture & Recent Changes

> **📚 Per-file documentation:** For AI-readable documentation of backend modules, see the [docs](./docs/) directory. Each file has a matching Markdown explanation of its purpose, key features, responsibilities and data flow.

## Fixed: oldies runs no longer purge a month on every league × year step

### Problem

During a `getOldiesGames()` recovery, the disk sat just above the threshold (e.g. 499MB / 512MB = 97.5% vs the 97% `DISK_USAGE_THRESHOLD`) and the logs showed the **same oldest month (`2016-11`) purged over and over** — once per step, across up to ~144 steps (16 leagues × 9 seasons):

```
[Oldies] progress: 37% — NHL 2024  → Capacity purge after NHL 2024: removed 7 games from 2016-11
[Oldies] progress: 38% — NHL 2025  → Capacity purge after NHL 2025: removed 10 games from 2016-11
[Oldies] progress: 39% — NWSL 2017 → Capacity purge after NWSL 2017: removed 3 games from 2016-11
```

Two compounding causes:
- `forceCapacityCheck` defaults to `true`, so the per-step check bypasses the 1-hour `CHECK_INTERVAL_MS` guard **and** invalidates the 60s disk-usage cache → it re-measures and purges on **every** step.
- Deleting a month does not immediately reclaim WiredTiger storage (`dataSize` stays ~450MB) while the oldies backfill keeps re-inserting early-season games whose `gameDate` falls in the oldest month — so usage never drops below the threshold and the next step purges again.

The existing `FORCED_PURGE_MIN_INTERVAL_MS` (60s) anti-wipe floor only guarded the no-space path (`handleNoSpaceError`), not the oldies loop, so a long recovery could delete many months of history in a tight cascade.

### Changes

- **`backend/src/games/games.service.ts`**
  - new field **`lastOldiesForcedPurgeAt`** tracking the last forced purge issued from inside `getOldiesGames()`.
  - the per-step capacity check in the `getOldiesGames()` `finally` block now applies the **same `FORCED_PURGE_MIN_INTERVAL_MS` (60s) floor** before calling `purgeOldestMonthIfNeeded()`. Steps inside the cooldown log `[Oldies] Capacity purge throttled after <LEAGUE> <year>: a forced purge ran <n>s ago (next allowed in ~<n>s).` and skip the delete, so space is still freed promptly (about once a minute) without a month-per-step wipe. This floor is independent from the no-space path (`lastForcedPurgeAt`), which is unchanged.
- **`backend/src/games/tests/games.service.spec.ts`** — new test `should throttle forced capacity purges to one per FORCED_PURGE_MIN_INTERVAL_MS across steps`: a multi-step run (no explicit year) triggers exactly **one** forced purge despite many league × year steps.
- **`backend/docs/games/games.service.ts.md`** — documented the per-step purge rate limit under `getOldiesGames()`.

### Note for operators

If disk usage is stuck near the threshold, the real lever is capacity, not purge frequency: the oldies backfill legitimately re-adds historical months. Consider a larger cluster or lowering `maxYearBeforeDelete` so oldies does not re-populate the very months the purge keeps deleting.

## Changed: `getOldiesGames` now iterates years from oldest to most recent

### Problem

When called without a `year` param, `getOldiesGames()` built its `years` list from
`currentYear - 1` down to the oldest allowed year (most recent → oldest). The desired order is the
opposite: start with the oldest season and move toward the most recent one.

### Changes

- **`backend/src/games/games.service.ts`** — `getOldiesGames()`: the default loop now runs
  `for (let y = minYear + 1; y <= currentYear - 1; y++)`, so seasons are fetched oldest → most
  recent. The set of years is unchanged (still excludes the in-progress current year); only the
  iteration order flips.
- **`backend/src/games/tests/games.service.spec.ts`** — the "only list years where games were
  actually added" test now expects the **oldest** year (`currentYear - maxYearBeforeDelete + 1`) to be
  processed first, instead of `currentYear - 1`.
- **`backend/docs/games/games.service.ts.md`** — documented the oldest → most recent order.

## Changed: inserting games when the DB is full now forces a rate-limited one-shot purge and retries once

### Problem

`executeWithCapacityGuard()` already wrapped `create()` / `update()`, but on a MongoDB "no space
left" error it only called `handleNoSpaceError()` (which purged) and then **re-threw** — it never
retried. Worse, the purge it triggered went through the throttled path in practice: a "no space"
error means the DB is full *right now*, yet the retry that would have used the freed space did not
exist. The result: during an insert / oldies run that hit a full disk, the failing `create()` threw
and the match (and, in a loop, the rest of the batch) was lost until a human intervened.

### Solution

- `backend/src/games/games.service.ts` — `executeWithCapacityGuard()` now **retries the operation
  once** after a successful purge before re-throwing. `handleNoSpaceError()` forces the purge via
  `purgeOldestMonthIfNeeded(force = true)` (bypasses the 1-hour `CHECK_INTERVAL_MS` guard and the
  60s disk-usage cache so the decision uses a fresh measurement); because a no-space error is
  authoritative, if that forced check still reports `action: 'none'` it falls back to a direct
  `purgeOldestMonth()`. It returns `true` only when at least one month was actually deleted, and
  that boolean drives the single retry. If the retry still fails, the original error is re-thrown.
  No manual `POST /games/capacity/check` is needed — the failed insert triggers the purge itself.
- **Rate-limited to protect the data (anti-wipe safeguard).** A forced purge bypasses the hourly
  guard, so a new `FORCED_PURGE_MIN_INTERVAL_MS` (60s) floor caps forced purges to **one per
  minute**. `lastForcedPurgeAt` records the last forced purge; a no-space error arriving within the
  1-minute window skips the purge and re-throws the error instead of deleting another month. This
  prevents a tight insert loop whose disk stays full from purging a month on every failed write and
  deleting the whole history within seconds. Between purges the caller fails loudly rather than
  cascading deletions.
- `backend/src/games/tests/games.service.spec.ts` — 5 new tests under
  `describe('create: capacity guard (no-space retry)')`: purges + retries and succeeds; does not
  retry when the error is not a no-space error; forces the purge (`purgeOldestMonthIfNeeded(true)`)
  and falls back to a direct purge when the forced check reports `none`; re-throws when nothing can
  be purged; and **does not purge again within `FORCED_PURGE_MIN_INTERVAL_MS`** (the second no-space
  error inside the 1-minute window does not trigger a second purge).
- Docs: `backend/docs/games/games.service.ts.md` — `create()` section documents the no-space retry
  and the 1-minute forced-purge floor.

## Removed: `backend/src/utils/Teams.tsx` pending-teams file and its logic

### Problem

The hand-maintained pending-teams file (`backend/src/utils/Teams.tsx`) existed because team discovery
could silently miss university teams: `getESPNTeams()` was truncated to ~50 teams by ESPN pagination.
With the `?limit=1000` fix plus the Division-1-only filter, a plain `POST /teams/refresh` now
discovers the complete D1 college roster automatically, so the file no longer had a reason to exist —
it only accumulated stale or never-addable entries (non-D1 schools blocked by the filter, `uniqueId`
mismatches such as `NCCABB-S ALA`).

### Solution

- **Deleted** `backend/src/utils/Teams.tsx`.
- **`TeamService`** — removed `pendingTeamsFilePath`, `readPendingTeams()`, `writePendingTeams()`,
  `prunePendingTeamsFile()` (and its call at the end of `getTeams()`) and
  `addPendingTeamsOfLeague()`. Team discovery is now `getESPNTeams()` alone.
- **`GameService._fetchUniqueGames()`** — no longer calls `addPendingTeamsOfLeague()` before a
  league fetch.
- **`espnAllData.ts`** — removed the `resolveESPNLeagueKeys()` / `getESPNLeagueKeyForTeamId()`
  helpers (they existed only to select pending entries).
- Note: `frontend/constants/Teams.tsx` (generated app constants used by `FavModal`) is a different
  file and is untouched.

### Files

- `backend/src/utils/Teams.tsx` — deleted.
- `backend/src/teams/teams.service.ts` — pending-file logic removed.
- `backend/src/games/games.service.ts` — `addPendingTeamsOfLeague()` call removed.
- `backend/src/utils/fetchData/espnAllData.ts` — league-key helpers removed.
- `backend/docs/teams/teams.service.ts.md`, `backend/docs/games/games.service.ts.md`,
  `backend/docs/utils/fetchData/espnAllData.ts.md` — this entry.

## Added: college rosters are Division-1-only (filter + purge + game cascade)

### Problem

ESPN's `GET {sport}/{league}/teams` returns every program it tracks, including
Divisions 2/3 (e.g. `NCAAF` returned 763 teams instead of ~260 D1 programs).
Those non-D1 teams were stored and their D1-vs-D2 fixtures polluted the D1
record, while the pending file kept shrinking around the wrong perimeter.

### Solution

- **`espnAllData.ts`** — `D1_PARENT_IDS` maps each college league to its D1
  parent group id(s) as exposed by ESPN's per-team detail endpoint
  (`groups: { id, parent: { id } }`): NCAAF `80/81` (FBS+FCS, both D1),
  NCAAB/WNCAAB `50`, NCCABB `27`, NCAAMH `51`. `isD1Groups()` tests the parent
  id only (`isConference` is unreliable — ESPN sets it to `false` for
  legitimate D1 teams such as every NCCABB team). NCAAWH is excluded (ESPN
  exposes no marker there). `getESPNTeams()` drops non-D1 teams, fail-open
  (a team whose detail fetch fails is kept, never dropped on a network error).
- **`TeamService.purgeNonD1Teams(league, espnTeams?)`** — deletes stored teams absent from
  the D1-filtered ESPN roster; reuses the caller's just-fetched roster when passed (no
  second ESPN round-trip). Never deletes on an empty ESPN roster (outage
  guard), never deletes `HistoricalTeams` or `isActive === false` teams.
  Called from `getTeams()` per league (only when ESPN returned a non-empty D1
  roster); deleted ids are queued in `lastPurgedNonD1Ids`.
- **`GameService._deleteGamesOfPurgedTeams(league)`** — cascades the purge to
  games (pulled via `takeLastPurgedNonD1Ids(league)`, which drains only that
  league's prefix so every league cascades its own purge instead of the first
  refresh consuming the whole queue — no circular dependency):
  deletes games whose `teamSelectedId`/`homeTeamId`/`awayTeamId` matches a
  purged id, removing both the non-D1 rows and the D1-side twin of D1-vs-D2
  fixtures. Runs in `getLeagueGames()` before `_deleteUnlinkedTeams()`.

### Files

- `backend/src/utils/fetchData/espnAllData.ts` — `D1_PARENT_IDS`, `isD1Groups()`, D1 filter in `getESPNTeams()`.
- `backend/src/teams/teams.service.ts` — `purgeNonD1Teams()`, league-scoped `takeLastPurgedNonD1Ids()`, purge call in `getTeams()`.
- `backend/src/games/games.service.ts` — `_deleteGamesOfPurgedTeams()` + call in `getLeagueGames()`.
- `backend/docs/utils/fetchData/espnAllData.ts.md`, `backend/docs/teams/teams.service.ts.md`, `backend/docs/games/games.service.ts.md` — this entry.

## Fixed: ESPN team discovery was truncated to ~50 teams (missing most of the roster)

### Problem

`getESPNTeams()` fetched `GET {sport}/{league}/teams` **without a `limit`**. ESPN paginates that
endpoint and, with no `limit`, silently returns only the **first ~50 teams** of the league. As a
result the whole roster was never discovered: for `NCAAB` only ~130 teams reached the database
instead of the full 362 (e.g. `NCAAB-AKR` Akron was absent even though ESPN still serves it as
`isActive: true`). The same silent truncation applied to the college scoreboard fallback.

### Solution

- `leaguesData[*].fetchTeam` is now `` `${teamBase}?limit=1000` `` so a single request returns the
  whole roster (NCAAB: 363 teams, Akron included).
- The `CollegeLeague` scoreboard fallback URL also carries `&limit=1000`.
- A manual `POST /teams/refresh` now repopulates the full catalog and the pending-file prune removes
  every team that reached the database from `backend/src/utils/Teams.tsx`.

### Files

- `backend/src/utils/fetchData/espnAllData.ts` — `fetchTeam` / scoreboard fallback URLs.
- `backend/docs/utils/fetchData/espnAllData.ts.md` — this entry.

## Added: pending teams of `Teams.tsx` are pruned by refresh and backfilled by game fetches

### Problem

`backend/src/utils/Teams.tsx` is a hand-maintained list of teams known to the app but missing from
the database. It had no automation around it: teams that reached the database stayed in the file
forever (drift), and teams still missing could only be inserted by hand — refreshing the games never
fixed the team catalog.

### Solution

- **`TeamService` (`backend/src/teams/teams.service.ts`)**
  - `readPendingTeams()` / `writePendingTeams()` parse and rewrite `backend/src/utils/Teams.tsx` as a
    `{ uniqueId: label }` map.
  - `prunePendingTeamsFile()` removes every pending team already stored in the database. It runs at
    the end of `getTeams()`, so `POST /teams/refresh` shrinks the file to the teams that are really
    missing (verified: 1051 stale entries removed on the first run).
  - `addPendingTeamsOfLeague(league)` adds the pending teams of one league when the provider (ESPN)
    still returns them, **only after confirming the write landed** (`findOne()`); a team ESPN no
    longer returns or a failed write stays in the file. Matching is by **exact `uniqueId`** only —
    abbreviation matching could store a team under the wrong league (e.g. `NCAAB-BOS` built from a
    NCAAF team abbreviated `BOS`). PWHL teams are skipped (not served by ESPN).
- **`GameService._fetchUniqueGames()` (`backend/src/games/games.service.ts`)** — calls
  `addPendingTeamsOfLeague()` before fetching a league's games, so updating the matches is enough to
  backfill the team catalog.
- **`espnAllData.ts`** — new helpers `resolveESPNLeagueKeys(league)` (league → ESPN keys, `[]` for
  non-ESPN leagues) and `getESPNLeagueKeyForTeamId(uniqueId)` (uniqueId → ESPN key) select the
  pending entries a league's ESPN fetch can actually resolve.

ESPN only: no other team source was touched.

## Fixed: PWHL current-group records read the standings of the wrong season

### Problem

`getPWHLScores()` splits dates in two: past groups use the local schedule replay, the group covering
today keeps the old behaviour — records from the official standings feed. But the standings call
passed **no** `season_id`, so `getPWHLStandings()` fell back to `resolveCurrentRegularSeason()`,
which only knows regular seasons. During a pre-season (today: 2026-27 pre-season) that resolution
finds no regular season covering today and no ended one to keep — it returns the closest upcoming
regular season, whose standings feed answers for a season that has not started: **every
`homeTeamRecord` / `awayTeamRecord` of the current group came back empty**.

### Solution

- **`backend/src/utils/fetchData/hockeyData.ts`** — the current-group branch now passes the
  covering season's `season_id` to `getPWHLStandings()` explicitly (single covering season only;
  several overlapping seasons still fall back to the default resolution), so a current pre-season
  or playoff group reads its own standings.
- **Tests** (`hockeyData.spec.ts`): fixed three stale `mockFeed()` calls missing the `seasons`
  argument, and corrected the past-group expectation — a finished season shows its **final** tally
  on every game (like the ESPN leagues), not the `asOf` slice.

## Removed: `game.show`, `game.color`, `game.backgroundColor`, and `team.value`

### Problem

A follow-up audit of the game/team payloads found four more write-only fields:

- **`Game.show`** — written by the ESPN/NHL/PWHL fetchers as `homeTeam.abbrev === teamId` (the exact
  expression already stored in `selectedTeam`) and by the day-placeholder in `games.service.ts`, but
  never used in any query or response consumer (the frontend only read it from the deleted
  `Cards.tsx`).
- **`Game.color` / `Game.backgroundColor`** — copies of the team colors written by the fetchers and
  the day placeholder; no backend logic ever read them (the API enrichment already computes
  `homeTeamColor`/`awayTeamColor` from the team documents when needed).
- **`Team.value`** — always written as `value: uniqueId` by the fetchers, so it duplicated
  `uniqueId`; the fetchers read it back only to stamp `teamSelectedId`/game `uniqueId`, i.e. they
  could read `uniqueId` directly.

### Changes

- **`backend/src/games/schemas/game.schema.ts`**, **`create-game.dto.ts`**, **`update-game.dto.ts`**,
  **`backend/src/utils/interface/game.ts`** — removed `show`, `color`, `backgroundColor` from the
  schema, DTOs and `GameFormatted`.
- **`backend/src/games/games.service.ts`** — the day-placeholder game no longer sets `show`, `color`
  or `backgroundColor`.
- **`backend/src/teams/schemas/team.schema.ts`**, **`create-team.dto.ts`**, **`update-team.dto.ts`**,
  **`backend/src/utils/interface/team.ts`** — removed `value` from the schema, DTOs and `TeamType`.
- **`backend/src/utils/fetchData/espnAllData.ts`** — teams no longer expose `value`;
  `getTeamsSchedule()`/`getEachTeamSchedule()` now take a `teamUniqueId` parameter (renamed from
  `value`) used for `teamSelectedId`, the game `uniqueId`, records and logs; the fetcher no longer
  writes `show`/`color`/`backgroundColor` on games and no longer passes `color`/`backgroundColor`
  down the call chain.
- **`backend/src/utils/fetchData/hockeyData.ts`** — same treatment for `getNHLTeamschedule()` /
  `getPWHLTeamschedule()` (parameter renamed to `teamUniqueId`, `color`/`backgroundColor`
  parameters dropped, game literals no longer write the removed fields).
- **`backend/src/utils/interface/card.ts`** — deleted: its `PropsCards`/`PropsCard`/`TeamBodyProps`
  interfaces were the leftover backend counterpart of the deleted frontend `Cards.tsx` and had no
  importer (the live `CardsProps` used by `CardLarge` lives in `frontend/utils/types.tsx`).
- **`backend/src/utils/fetchData/espnAllData.spec.ts`** — fixture team no longer carries `value`.

**Impact:** none on behavior — `show` duplicated `selectedTeam`, `color`/`backgroundColor` had no
reader, and `value === uniqueId` for every team the fetchers produce (so `teamSelectedId` and game
`uniqueId` values are unchanged). Existing MongoDB documents keep their old keys; the fields simply
become invisible to Mongoose once the schema drops them. No migration required.

## Removed: unused fields `divisionName`, `conferenceName` (Team) and `venueTimezone`, `divisionName` (Game)

### Problem

An audit cross-referencing the Mongoose schemas against every real read in the codebase showed that
these fields were **write-only**: the fetch layer stored them but no consumer ever read them.

- `Team.divisionName` / `Team.conferenceName` — written by `espnAllData.ts` (parsed from ESPN
  `standingSummary`) and `hockeyData.ts` (from the NHL/PWHL standings APIs), never read anywhere.
- `Game.venueTimezone` — written by the ESPN/NHL/PWHL fetchers, never read by the backend or the
  frontend (the frontend `GameFormatted` declared it but no component used it).
- `Game.divisionName` — declared in the schema and DTOs but never even written by any fetcher.

### Changes

- **`backend/src/teams/schemas/team.schema.ts`**, **`create-team.dto.ts`**, **`update-team.dto.ts`** —
  removed `conferenceName` and `divisionName`.
- **`backend/src/games/schemas/game.schema.ts`**, **`create-game.dto.ts`**, **`update-game.dto.ts`** —
  removed `venueTimezone` and `divisionName`.
- **`backend/src/utils/interface/team.ts`** — removed both fields from `TeamType` (the `TeamNHL`
  interface, which mirrors the external NHL API payload, keeps its own `conferenceName`/`divisionName`).
- **`backend/src/utils/interface/game.ts`** — removed `venueTimezone?` from `GameFormatted`.
- **`backend/src/utils/fetchData/espnAllData.ts`** — `getDivision()` only ever mattered for the team
  record; it was renamed **`getTeamRecord()`** and simplified to return just `record` (the
  `standingSummary` parsing for conference/division was dropped). The fetchers no longer write the
  removed fields.
- **`backend/src/utils/fetchData/hockeyData.ts`** — no longer writes the removed fields (NHL, PWHL
  teams and schedules).
- **`backend/src/games/games.service.ts`** — placeholder game no longer sets `venueTimezone`.

**Impact:** none on behavior — no consumer existed. Existing MongoDB documents keep their old
values; the fields simply become invisible to Mongoose (not projected) once the schema drops them.
No migration required.

## Added: `game.dataChangedAt` — the instant the live data actually changed

### Problem

`updateDate` is rewritten by `syncGameWithScore()` on **every** live sync, whether or not anything
moved. It therefore answers "when did we last poll the provider", which is useless for the frontend
question "is this game actually still being reported?" — a provider stuck on `"02:00"` for twenty
minutes is indistinguishable from one refreshing normally. Without a real change timestamp, the app
cannot tell a finished game from a live one whose feed went silent, and a live-looking clock can hang
on the card indefinitely.

### Changes

- **`backend/src/games/schemas/game.schema.ts`** — new optional `dataChangedAt` prop: ISO-8601 string of
  when `gameClock` / `gamePeriod` / scores / `gameStatus` last **changed value**.
- **`backend/src/games/games.service.ts`** — `syncGameWithScore()` snapshots the previous clock, period,
  both scores and the previous status before overwriting them, still writes `updateDate` on every sync,
  and writes `dataChangedAt` only when one of those values differs. A document that has no
  `dataChangedAt` yet gets one on its first sync, so existing data backfills itself without a migration.
- **`backend/src/games/dto/create-game.dto.ts`** and **`update-game.dto.ts`** — `dataChangedAt?: string`.

**Consumers:** the frontend `isLiveFeedStale()` (`frontend/utils/date.ts`) compares this timestamp
against a 15-minute threshold to decide when the `"Finalisation"` label should replace a stale live
clock. `updateDate` keeps its existing meaning and existing consumers (stale-team purge, grace
periods) are untouched.

## Fixed: a truncated ESPN fetch froze an intermediate tally as the season record

### Problem

`applySeasonFinalRecords()` decides that a finished season is over, then copies each team's **most
complete** tally onto **every** game of that season. Nothing checked that the batch actually held the
whole season, so a **truncated** fetch (ESPN quota exhausted, pagination cut short, or a team fetch
that silently failed) silently produced a wrong result: the intermediate tally of whatever games were
retrieved was written on the entire season, and displayed as the season's final record.

The `_backfillSeasonRecords()` pass added for the oldies records inherited the same flaw — it would
have propagated those partial numbers onto the stored games.

### The invariant used

A team's tally on its last game of a season accounts for **every** game it played that season. So a
tally implying **more** games than were fetched for that team is proof the batch is incomplete. Games
are de-duplicated per team by game identity, so the two rows a match produces (one per
`teamSelectedId`) do not inflate the count.

### Changes

- **`backend/src/utils/fetchData/espnAllData.ts`**
  - new exported **`getSeasonFinals(games)`** returning `{ verified, truncated }`: `verified` maps a
    `teamId` to its tally only when that tally accounts for every game held for the team; `truncated`
    lists the teams whose tally was rejected as incomplete.
  - `applySeasonFinalRecords()` uses it: a rejected team keeps its own per-game cumulative value instead
    of being given a number that may not be the season's, and a
    `[ESPN] Season looks truncated for N team(s) (…)` warning is logged.
- **`backend/src/games/games.service.ts`**
  - `_backfillSeasonRecords()` restores **only verified** tallies, so a partial fetch can never freeze a
    wrong record on the stored games. Truncated teams are left for a later, complete run. This filter is
    **not** redundant with `applySeasonFinalRecords()`: that pass deliberately leaves a truncated team's
    games holding their own cumulative value, so rebuilding the tally without the filter would pick an
    arbitrary intermediate number. No extra truncation warning is logged — `applySeasonFinalRecords()`
    already reported it for the same batch.
- **Tests**: `getSeasonFinals` (complete tally verified, oversized tally rejected, a duplicated match
  not counted twice, most-complete tally kept); `applySeasonFinalRecords` leaves the per-game tally
  untouched on a truncated season.

### Note on the existing fixtures

Two `applySeasonFinalRecords` tests used unrealistic data (a `33-39-10` tally — 82 games — on a batch of
two games). Under the new invariant that is a truncated season, so the fixtures were corrected to
tallies consistent with the number of games held. The behaviour they cover is unchanged.

### Files changed

- `backend/src/utils/fetchData/espnAllData.ts`
- `backend/src/utils/fetchData/espnAllData.spec.ts`
- `backend/src/games/games.service.ts`
- `backend/docs/utils/fetchData/espnAllData.ts.md`, `backend/docs/games/games.service.ts.md`
- `backend/CHANGELOG_ARCHITECTURE.md` — this entry.

## Added: oldies runs now refresh the per-game records at the end of the season

### Problem

An oldies run (`getLeagueGames({ addMissingOnly: true })`) could leave a past game with an **empty**
`homeTeamRecord` / `awayTeamRecord` forever, even once the season had been fetched again:

- A game stored **before** the per-game records existed has no record. The `addMissingOnly`
  comparison skips a game as soon as the stored records **match** the fetched ones. When the freshly
  fetched season carries no `record` for that team (ESPN omits it on some seasons), _both sides are
  empty_ → the comparison says "identical" → the game is skipped and its record is never filled.
- Worse, `create()` protected the **scores** against being overwritten by `null`, but **not** the
  records. A game refreshed because its scores differed (`Object.assign(existingGame, gameDto)`)
  therefore had its correct stored records overwritten by the empty fetched ones.

### Changes

- **`backend/src/games/games.service.ts`**
  - new private **`_backfillSeasonRecords(league, fetchedGames)`**: runs at the end of every oldies
    pass. It reads the season tally per team from the fetched games (already normalized to the final
    value by `applySeasonFinalRecords()`) and writes it onto every **stored** game of that season
    whose record is still empty. Restricted to the `uniqueId`s of the current fetch, and it only ever
    writes an empty slot, so it can fill gaps but never destroy data. Errors are caught and logged.
  - the `[Oldies] <LEAGUE> (season <year>)` summary line now also reports `records backfilled <n>`.
  - `create()` now drops an incoming `homeTeamRecord` / `awayTeamRecord` that is empty
    (`''` / `null` / `undefined`) when a record is already stored — mirroring the existing score guard.
- **Tests** (`games.service.spec.ts`): records backfilled onto a stored game with empty records; a
  stored record is never overwritten by the sweep; `create()` keeps the stored record when the fetched
  one is empty but still applies a score change; `create()` still writes a record when one is fetched.

### Files changed

- `backend/src/games/games.service.ts`
- `backend/src/games/tests/games.service.spec.ts`
- `backend/docs/games/games.service.ts.md`
- `backend/CHANGELOG_ARCHITECTURE.md` — this entry.

## Fixed: `Cannot read properties of undefined (reading 'fetchGames')` on every refresh

### Problem

Production logs were full of this, for unrelated leagues (`NCAAMH-BRWN`, `NCAAWH-QUIN`,
`NWSL-CHI`, `OLYMPICS-HOCKEY-WOMEN-SUI`, …):

```
TypeError: Cannot read properties of undefined (reading 'fetchGames')
    at getEachTeamSchedule (espnAllData.ts:777:49)
    at <anonymous> (espnAllData.ts:675:38)
    at Array.map (<anonymous>)
    at async GameService.getLeagueGames (games.service.ts:583:27)
```

Two independent defects stacked up:

1. **`leaguesData[leagueName]` was read without a guard** (`const baseUrl =
leaguesData[leagueName].fetchGames…`). `leaguesData` is built from `leagueConfigs`, so it has
   **no entry** for the PWHL (its games come from `hockeyData.ts`) nor for any unrecognized name.
2. **`TeamService.findAll(leagues)` fell back to an _unfiltered_ re-fetch.** When the query for the
   requested league matched nothing, it called `getTeams()` with **no argument**, which returns the
   teams of **every** league. Those teams were then processed under the single requested
   `leagueName` — so an `NWSL` refresh ended up iterating `NCAAMH-BRWN` and building NWSL schedule
   URLs for a college hockey team. That is why the failing team names had no relation to the league
   being refreshed, and why the problem showed up on many leagues at once.

The `TypeError` was then swallowed by `getEachTeamSchedule()`'s `catch`, which returned
`undefined`; both callers (`[...allGames, ...games]` in the aggregate-league recursion, and
`allGames[leagueID] = …` in `getTeamsSchedule()`) require an array, so the failure surfaced a
second time as a `TypeError` on `Array.map` — hiding the real cause behind a noisy stack.

### Changes

- **`backend/src/utils/fetchData/espnAllData.ts`**
  - `getEachTeamSchedule()` now checks `leaguesData[leagueName]` right after the aggregate-league
    branch and returns `[]` with a `No ESPN schedule config for league "<X>" (team <Y>) — skipped.`
    log — mirroring the guard `getESPNScores()` already had.
  - the `catch` returns `[]` instead of `undefined`.
- **`backend/src/teams/teams.service.ts`**
  - `findAll(leagues)` re-fetches **only the requested league** (`getTeams(leagues[0])`) and filters
    the result back on `leagues`; the unfiltered `getTeams()` bootstrap is now reserved for the
    no-filter case.
- **Tests**: two regression tests in `espnAllData.spec.ts` asserting `getTeamsSchedule()` resolves
  with empty lists (never `undefined`) for a league with no ESPN config.

### Files changed

- `backend/src/utils/fetchData/espnAllData.ts`
- `backend/src/utils/fetchData/espnAllData.spec.ts`
- `backend/src/teams/teams.service.ts`
- `backend/docs/utils/fetchData/espnAllData.ts.md`, `backend/docs/teams/teams.service.ts.md`
- `backend/CHANGELOG_ARCHITECTURE.md` — this entry.

## Fixed: no record on any past PWHL game (season never requested)

### Problem

`getPWHLScores(date)` requested the HockeyTech schedule **without `season_id`**:

```ts
fetch(`${pwhlAPI}?feed=modulekit&view=schedule&key=…&client_code=pwhl`);
```

The feed then silently answers with its **default** season — measured live, `season_id=10`
(2026-27 Pre-Season, 12 games, all dated 2026-11-22 → 2026-11-30). Two consequences, one after the
other:

1. the requested past day is **absent from the payload**, so `filter(date_played === date)` returned
   an empty list;
2. `applyPWHLHistoricalRecords()` replayed 12 **unplayed, future** games, so `seasonOver` was `false`
   and `finals` empty — hence `homeTeamRecord`/`awayTeamRecord` always `''`.

So no PWHL game from a past date ever showed a record.

### Why the obvious fix is not enough

Resolving the year through `getPWHLSeasonIds(year)` — what `fetchGamesData()` does — returns **four**
seasons for 2025: `2024-25 Regular Season`, `2025 Playoffs`, `2025-26 Preseason` and
`2025-26 Regular Season`. Merging their schedules into one `allGames` feeds **four seasons** to the
record replay, totalling them into a single plausible-looking but wrong record. It would also flip
`seasonOver` back to `false` for 2026 (the 2026-27 season starts in December).

### Changes

- **`backend/src/utils/fetchData/hockeyData.ts`**
  - new `getPWHLSchedule(seasonId?)` helper (the schedule fetch, now season-explicit);
  - new `getPWHLSeasonsForDate(date)` returning **`gameSeason`** (the entry whose span covers the
    date — regular season first, then playoffs, then pre-season) and **`recordSeason`** (the regular
    season a W-L-OTL comes from: the one covering the date, or, on a playoff date, the most recent
    regular season that ended before it);
  - `getPWHLScores()` reads the day's games from `gameSeason` and replays the record from
    `recordSeason` — one request when both are the same season, two otherwise. When no season covers
    the date (or the seasons feed fails) it falls back to the default feed rather than losing the day.
  - `PWHLSeason` is now a named type instead of an inline shape.
- **`backend/src/utils/fetchData/hockeyData.spec.ts`** — 5 new tests: the regular season covering a
  past date is requested, a playoff day reads games from the playoffs feed but the tally from the
  regular season, a single request when the day already belongs to the record season, the fallback to
  the default feed, and an empty result for a day with no game.
- **`backend/docs/utils/fetchData/hockeyData.ts.md`** — season-resolution rules and the record replay
  rewritten.

### Side findings, not fixed here

- `applyPWHLHistoricalRecords()` carries a `game_type` guard meant to skip playoff games, but
  `game_type` is an **empty string in every feed**, so that guard never fires. The three tallies stay
  apart because each is replayed from its **own** `season_id` — the group selection does the
  filtering, not that guard. The comment and the documentation now say so.
- `selectedTeam` is set to `home === id` in all three fetchers (`espnAllData`, `hockeyData` ×2).
  Taken alone that reads like a bug — the flag is `false` when the queried team plays away — but since
  every match is stored **twice**, exactly one of the two documents has the home team as its
  `teamSelectedId`, so `filterGames({ selectedTeam: true })` is in practice a de-duplication filter
  that keeps one row per match. Changing it to "home **or** away" would make the flag true on both
  copies and return each match twice. Left untouched.

Verified live: `getPWHLScores('2025-02-15')` → `MTL 19-8-3` vs `NY 12-13-5` (regular season);
`getPWHLScores('2025-05-07')` → `TOR 1-2-1` vs `MIN 6-1-1` (playoffs, its own tally).

## Fixed: a match was counted twice in the form dots (double-stored documents)

### Problem

A finished match is stored **twice**: each upstream feed writes its own document for the team it was
asked about, so the two rows describe the same match but differ by `teamSelectedId` — and their
`uniqueId`s differ too, because that id is prefixed with the selected team (`NHL-ANA-401892433` vs
`NHL-VGK-401892433`). `findRecentFormGames` returned both copies, so a single result filled **two
dots** and pushed a real game out of the `limit`. Because the duplicates have to fit inside the
`before` window to be counted, the outcome depended on where that bound fell: the modals of two
consecutive games showed rows that did not match each other.

`removeDuplicatesAndOlds` never cleaned this up — it keys on `teamSelectedId + startTimeUTC`, which
differs between the two copies.

### Changes

- **`backend/src/games/games.service.ts`** — the rows are collapsed on
  `${homeTeamId}-${awayTeamId}-${startTimeUTC}`, the stable identity of a match (`uniqueId` cannot be
  used as that key). Since the twins would otherwise consume the budget, the query **over-fetches**
  `limit * FORM_DUPLICATE_OVERFETCH` rows and the `limit` is applied only after deduplication.
- **`backend/src/games/tests/games.service.spec.ts`** — new test asserting the two copies of a match
  collapse into a single result, plus one for the over-fetch; the limit-clamping tests now assert the
  over-fetched value (1 → 3, 20 → 60, default 5 → 15).

### Deliberately left out of scope

The duplicate documents are still in the database, and `removeDuplicatesAndOlds` still does not
remove them: it keys on `teamSelectedId` (which differs between the copies) and then deletes by
`uniqueId` (which would remove both copies at once). Re-keying that cleanup is a destructive change
on the whole collection and deserves its own change.

## Fixed: form dots stayed empty for upcoming games (score filter applied after `limit`)

### Problem

`findRecentFormGames` dropped games without both scores **after** the query, in JavaScript, while
`limit` was applied by the database. With no `before` bound — which is exactly what an upcoming
game sends — a team's most recent games by date are its _scheduled fixtures_: the `$or` query
returned the next 5 unplayed games, the JS filter removed all of them, and the row came back empty.
A past game escaped the bug only because its own `startTimeUTC` already excluded the future fixtures.

### Changes

- **`backend/src/games/games.service.ts`** — the played-only condition moved into the Mongo filter:
  `homeTeamScore: { $ne: null }` and `awayTeamScore: { $ne: null }` now sit alongside `isActive` and
  the `$or`, so the database only counts finished games when applying `limit`. The JS-side filter is
  kept as belt-and-braces for documents stored with an explicit `undefined`.
- **`backend/src/games/tests/games.service.spec.ts`** — the filter assertion now includes both score
  conditions, plus a regression test asserting they are part of the _query_ rather than a post-filter.

## Added: `GET /games/team/:teamId/form` for the game modal's form dots

### Problem

The frontend derived a team's last-5 results from `GET /games/team/:id/results`, which filters on
`teamSelectedId`. Games are deduplicated by `uniqueId`, and `teamSelectedId` is produced by whichever
upstream feed happened to create the document, so it is stored on only **one** side of a match: the
opponent's id never lands on it. The returned history was therefore incomplete for that side (dots
missing or empty), and the query matched on a field that is not a reliable team key.

### Changes

- **`backend/src/games/games.service.ts`** — new `findRecentFormGames(teamId, before?, limit = 5)`:
  - filters on `$or: [{ homeTeamId: teamId }, { awayTeamId: teamId }]` (plus `isActive: true`), sorted
    by `startTimeUTC` descending, capped at `limit`, projected to the fields the client needs;
  - `before` is applied only when it parses as a date, as a **strict** `startTimeUTC: { $lt: before }`
    bound — strict so the displayed game itself is never returned. With no `before`, the team's most
    recent games are returned.
  - `limit` is clamped to `[1, 20]`, defaulting to 5 when it is missing or non-numeric.
  - Games missing either score are dropped: only a game already played counts as a result. The status
    is returned untouched, so the client stays the single source of truth for what counts as finished
    and for the overtime rule.
- **`backend/src/games/games.controller.ts`** — new `GET /games/team/:teamSelectedId/form`, forwarding
  `before` and `limit`. Like every other read route of the controller (`/team/:id`,
  `/team/:id/results`, `/league/:league/results`, …) it is **public**: `ApiKeyGuard` is reserved for the
  write and maintenance routes, and the frontend never sends an `x-api-key` header. Guarding it made
  every modal open return **401**.
- **`backend/src/games/schemas/game.schema.ts`** — two compound indexes added:
  `{ isActive: 1, homeTeamId: 1, startTimeUTC: -1 }` and `{ isActive: 1, awayTeamId: 1, startTimeUTC: -1 }`.
  `homeTeamId` / `awayTeamId` are plain props with no index of their own, so the `$or` query was a
  **full collection scan** on every call — the sort and the `before` bound could only be applied in
  memory. The same scan affected the day views and the orphan-team cleanup
  (`findUsedTeamIds()`), which query the same two fields.

### Notes / limits

- Storing a pre-computed "recent form" on the game or team document was considered and **rejected**:
  the computation is negligible, and three existing jobs mutate past games retroactively —
  `purgeOldestMonth()` deletes the oldest month under disk pressure,
  `getOldiesGames({ addMissingOnly })` backfills historical games, and `fetchGamesScores()` fills null
  scores later — so any stored row would silently drift from the truth. The index removes the real
  cost (the collection scan) without that risk.

### Tests

`backend/src/games/tests/games.service.spec.ts` — new `findRecentFormGames` describe block (7 tests):
the `$or` filter on both team fields with `isActive`, the strict `$lt` bound, an unparsable `before`
producing no bound, score-less games dropped, and the `limit` clamping (default 5, `1`, `20`, and
non-numeric → 5). The suite was 109 tests green after the change. The `afterEach` calls
`jest.clearAllMocks()` **and** `mockReset()` + `mockReturnThis()`: the former does not reset
`mockImplementation`, so the `find` override written for this block leaked into the sibling suites.

---

## Fixed: a completed game was deleted as "unresolved" because of its `gameStatus`

### Problem

The backend logged, on every `fetchGamesScores()` cycle:

```
[fetchGamesScores] Removing unresolved game MLS-SEA-557514 (MLS) started more than 90 days ago without a final status...
```

…even though the match is finished and shows a score on ESPN (SEA 4-3 DAL, _final after extra time_,
19/10/2019 — `STATUS_FINAL_AET`, `state: post`, `completed: true`).

Two independent defects combined:

1. **The import wrote a status no terminal-state check recognized.** The `gameStatus` IIFE of
   `getEachTeamSchedule()` (the _scoreboard_ path used by MLS/NWSL/Olympics) compared ESPN status
   names by **equality** against `STATUS_FINAL`, `STATUS_FULL_TIME`, `STATUS_POSTPONED`,
   `STATUS_CANCELLED`. ESPN suffixes the final states with how the game ended
   (`STATUS_FINAL_AET`, `STATUS_FINAL_PEN`, `STATUS_FULL_TIME_2`, …), so every one of them fell
   through to the generic `STATUS_*` branch and was stored as `"FINAL AET"` — a value outside the
   `['FINISHED', 'FINAL', 'CANCELLED', 'POSTPONED']` exclusion list.
2. **The 90-day purge deleted anything carrying such a status**, with no regard for the score. Its
   purpose (cf. the "stale active PWHL game" entry below) is to drop _stuck_ games whose result can
   never be recovered — not real historical games whose result is known.

The score cycle could not save it either: `fetchGamesForLiveScoreUpdate()` bounds its scan to the
last `staleGameMaxAgeDays` (90), so a 2019 game is never re-scored, even though the source still
serves it. The result was silent data loss of a legitimately scored match.

### Changes

- **`backend/src/utils/fetchData/espnAllData.ts`** — the inline IIFE is replaced by a new exported,
  unit-tested **`resolveScheduleGameStatus(status)`** that maps an ESPN `STATUS_*` name by **family**
  rather than by equality: `FINAL*` / `FULL_TIME*` → `FINISHED`, `POSTPONED*` → `POSTPONED`,
  `CANCELLED*` / `CANCELED*` → `CANCELLED`, `DELAYED*` / `SUSPENDED*` / `INTERRUPTED*` → `DELAYED`
  (consistent with `GameService._resolveStatus()`), `IN_PROGRESS*` → `IN_PROGRESS`, any other
  `STATUS_*` → a readable value (`STATUS_HALFTIME` → `"HALFTIME"`), no status → `null`.
  Case insensitive.
- **`backend/src/utils/gameStatus.ts`** (new) — shared definition of a terminal status:
  `TERMINAL_GAME_STATUSES` (for Mongo `$nin` filters) and `isTerminalGameStatus(status)` (anchored,
  case-insensitive regex also accepting the suffixed/legacy variants `FINAL AET`, `FINAL PEN`,
  `FULL TIME`, `CANCELED`). Replaces the two duplicated hardcoded lists so the score cycle and the
  purge cannot drift apart.
- **`backend/src/games/games.service.ts`**:
  - `removeStaleUnresolvedGames()` now additionally requires `homeTeamScore: null` **and**
    `awayTeamScore: null` — a game that already has a score is a real historical game, never a stuck
    one — and re-checks each candidate with `isTerminalGameStatus()` in memory so a legacy record
    stored as `"final"` or `"FINAL AET"` is spared too. Skipped games are logged
    (`[fetchGamesScores] Skipped N old game(s) carrying a score or a decided status…`).
  - `fetchGamesForLiveScoreUpdate()` and the purge both use `TERMINAL_GAME_STATUSES` instead of an
    inline literal list.

Both layers are intentional: fixing the import stops new records from being written with a bogus
status, and hardening the purge protects the records already in the database (which keeps their
`"FINAL AET"` values until they are re-imported).

### Files

- `backend/src/utils/gameStatus.ts` (new) + `backend/src/utils/gameStatus.spec.ts` (new)
- `backend/src/utils/fetchData/espnAllData.ts` + `espnAllData.spec.ts`
- `backend/src/games/games.service.ts` + `backend/src/games/tests/games.service.spec.ts`
- `backend/docs/utils/gameStatus.ts.md` (new), `backend/docs/utils/fetchData/espnAllData.ts.md`,
  `backend/docs/games/games.service.ts.md`, `backend/docs/README.md`

### Known limitation (not addressed here)

A game older than 90 days is still never re-scored by `fetchGamesForLiveScoreUpdate()` (the lower
bound that fixed a heap-OOM restart loop). Records already stored with a non-normalized status are
therefore _kept_ rather than resolved; correcting them requires a bounded one-off backfill or a
recovery pass that calls `getESPNGameScore()` (which resolves any ESPN event id, including 2019
ones) before purging.

## Added: twice-daily team records refresh cron, restricted to in-season leagues

### Problem

`team.record` (wins / losses / ties / otLosses, the tally the frontend shows on games of
the **current** season) had no dedicated refresh. It was only updated as a side effect of
`fetchGamesScores()` — when a game flips to `FINISHED` — and of the daily league rotation,
which is throttled by `needRefresh()` (every 3 days in season, 7 days off-season) and only
runs inside a 4 AM-11 AM New York window. So the record could stay stale for days.

### Changes

- **`backend/src/games/games.service.ts`** — new `refreshCurrentSeasonRecords()`:
  - keeps only leagues where `isCurrentSeason()` **or** `isPlayoffsPeriod()` covers today,
    so off-season leagues are skipped before any third-party call (zero cost);
  - fetches each kept league's schedule via `_fetchUniqueGames(league, undefined, teamRecords)`
    and **discards the games** — only the harvested per-team tallies are used, so no `Game`
    document is created, updated or deactivated;
  - writes them through `TeamService.updateRecords()` and returns `{ leagues, updatedTeams }`;
  - the **PWHL is handled specially**: its HockeyTech schedule carries **no** per-game record, so
    `_fetchUniqueGames()` forwards `teamRecords` to `HockeyData.getHockeySchedule()`, which fills
    the map from the official standings (fallback: a local replay of the schedule). Without this
    the map stayed empty for the PWHL and no `team.record` was ever written for it;
  - a league that throws is logged (`[Records] Could not refresh records for …`) and does not
    abort the remaining leagues.
- **`backend/src/cronJob/cronJob.service.ts`** — two daily crons sharing
  `runTeamRecordsRefresh(slot)`:
  - `refreshTeamRecordsMorning()` — `0 6 * * *` = **3:00 AM `America/Los_Angeles`**
    (6 AM New York in winter, 9 AM New York in DST). The U.S. coasts are 3 hours apart, so
    anchoring on LA is the literal "3 AM U.S."; anchoring on New York would land on 0 AM.
  - `refreshTeamRecordsAfternoon()` — `0 15 * * *` = **9 AM Pacific / 12 PM New York**
    (3 PM New York in DST), a midday safety net for a skipped or failed morning run.
  - Both skip while `isHeavyRefreshRunning` (league rotation / oldies) and never overlap
    themselves (`isRefreshingTeamRecords`, released in `finally`).
- **`backend/src/games/games.controller.ts`** — `POST /games/refresh/records` (API key) for a
  manual run.
- **Tests** — 5 in `games.service.spec.ts` (only in-season leagues, playoffs included, nothing
  in season → no call at all, one failing league does not stop the others, never persists a
  game) + 5 in `cronJob.service.spec.ts` (both slots, heavy-refresh guard, self-overlap guard,
  flag released on error).
- **Docs** — `backend/docs/cronJob/cronJob.service.ts.md` (schedule table + section),
  `backend/docs/games/games.service.ts.md`, `backend/docs/games/games.controller.ts.md`.

### Files changed

- `backend/src/games/games.service.ts`
- `backend/src/games/games.controller.ts`
- `backend/src/cronJob/cronJob.service.ts`
- `backend/src/utils/fetchData/hockeyData.ts`
- `backend/src/utils/fetchData/hockeyData.spec.ts` (new)
- `backend/src/games/tests/games.service.spec.ts`
- `backend/src/cronJob/tests/cronJob.service.spec.ts`
- `backend/docs/cronJob/cronJob.service.ts.md`
- `backend/docs/utils/fetchData/hockeyData.ts.md`
- `backend/docs/games/games.service.ts.md`
- `backend/docs/games/games.controller.ts.md`

---

## Changed: oldies runs now force the capacity check after every league × year step

### Problem

`getOldiesGames()` called `purgeOldestMonthIfNeeded()` **without** `force` after each
league × year step. `purgeOldestMonthIfNeeded()` refuses to run more than once per hour
(`CHECK_INTERVAL_MS`), so in a long recovery (leagues × 5 seasons, minutes per step) every
check after the first returned `{ action: 'none' }` without even measuring the disk. The purge
therefore only happened once per hour while the DB kept growing — exactly the scenario that
fills the cluster to 100%.

### Changes

- `backend/src/games/games.service.ts` — `getOldiesGames(yearStr?, leagueParam?, options?)`
  accepts `options.forceCapacityCheck` (default `true`) and forwards it to
  `purgeOldestMonthIfNeeded(force)`. With `force: true` the 1-hour guard is bypassed **and**
  the 60s `getDiskUsage()` cache is invalidated, so each step measures the real usage and can
  purge one month if usage is ≥ 95%. The call is wrapped in `try/catch` (an unavailable
  `dbStats` must not abort the recovery) and logs
  `[Oldies] Capacity purge after <LEAGUE> <year>: ...` when a month is actually purged.
- `backend/src/games/games.controller.ts` — `POST /games/refresh/oldies` accepts `?force=false`
  to opt back into the throttled (hourly) capacity check.
- `backend/src/games/tests/games.service.spec.ts` — 3 new tests: forced by default, not forced
  with `forceCapacityCheck: false`, and recovery continues when the capacity check throws.
- Docs: `backend/docs/games/games.service.ts.md`, `backend/docs/games/games.controller.ts.md`.

### Files changed

- `backend/src/games/games.service.ts`
- `backend/src/games/games.controller.ts`
- `backend/src/games/tests/games.service.spec.ts`
- `backend/docs/games/games.service.ts.md`
- `backend/docs/games/games.controller.ts.md`

---

## Added: per-game team records — final tally of a past season, most recent tally of the current one

### Goal

Opening a game of a **past season** must show the win/loss/draw tally of that season (option chosen:
the **final, end-of-season** tally, identical on every game of that season), while a game of the
**current season** must show the **most recent** tally. ESPN leagues only.

### Problem

- The team-schedule path of `getEachTeamSchedule()` (the one used by NHL, NBA, MLB, NFL, the 6
  college leagues …) returned **no** `homeTeamRecord` / `awayTeamRecord` at all, so past seasons had
  no record and `_enrichGameWithTeamData()` fell back to `team.record` — today's tally, which is
  wrong for an old season.
- The scoreboard/summary paths read `competitor.records.find(r => r.type === 'total')`, but the NHL
  scoreboard and the NHL season schedule only expose `type: 'ytd'` (and the season schedule puts the
  data under the singular `competitor.record`). Those lookups always returned `''` — a latent bug for
  every `ytd`-shaped league.
- `fetchGamesScores()` froze `game.homeTeamRecord` at the time the score was synced, which is the
  opposite of "most recent" for the current season.

### Solution

- **`backend/src/utils/fetchData/espnAllData.ts`**
  - New `extractCompetitorRecord(competitor)` — reads both ESPN shapes (`record` / `records`,
    `displayValue` / `summary`), picks `total` → `ytd` → first entry, strips the `", 109 PTS"`
    hockey suffix. Now used by the 3 former `records.find(… 'total' …)` sites **and** by the
    team-schedule mapping, which gained `homeTeamRecord` / `awayTeamRecord` (cumulative per game).
  - New `applySeasonFinalRecords(allGames)`, called at the end of `getTeamsSchedule()` so it sees the
    whole league batch (a single team's fetch does not contain its opponents' last game, hence the
    league-level pass):
    - every fetched game already started (season over) → each team's **final** tally, taken from its
      most complete record (max games played, so pre-season tallies lose), copied onto all its games;
    - any game still upcoming (season in progress) → records **cleared**, so readers fall back to
      `team.record`, always kept up to date by `syncGameWithScore()` → `updateRecord()`.
- **`backend/src/games/games.service.ts`**
  - The `addMissingOnly` (oldies) comparison now also checks `homeTeamRecord` / `awayTeamRecord`, and
    the `existingResults` projection fetches them. Games stored before this change are therefore
    **backfilled** on the next oldies run instead of being skipped forever, and the check converges
    (both sides equal afterwards).
  - `fetchGamesScores()` no longer writes the per-game record (see above).
- **PWHL is untouched** (`hockeyData.ts` was not modified), as requested.

### Files changed

- `backend/src/utils/fetchData/espnAllData.ts` — `extractCompetitorRecord()`, `recordGamesPlayed()`, `applySeasonFinalRecords()`, records on the team-schedule mapping, 3 unified lookups.
- `backend/src/games/games.service.ts` — records included in the oldies `existingResults` projection + `sameResult`, record freeze removed from `fetchGamesScores()`.
- `backend/src/utils/fetchData/espnAllData.spec.ts` (new) + `backend/src/games/tests/games.service.spec.ts` — unit tests.
- `backend/docs/utils/fetchData/espnAllData.ts.md`, `backend/docs/games/games.service.ts.md` — documentation.

### Result

- `npx jest` → 8/8 suites, 191/191 tests pass.
- Live checks against the real ESPN API:
  - NHL `season=2025`: 3012 games, 0 empty record, **0 team with more than one value**; `NHL-BOS 33-39-10`, `NHL-WSH 51-22-9` (the true 2024-25 final tallies).
  - NHL current season: 2646 games, all records cleared → `team.record` (most recent).
  - MLS `season=2025` (scoreboard path): 1088 games, 0 team with more than one value (the only 2 empty records are the MLS All-Star game, `MLS-MLS` vs `MLS-LMX`, which has no season tally).
  - MLS current season: 212/212 records cleared.
  - `getESPNScores('NHL', '2025-04-01')` now returns `"30-36-9"` instead of `''` (the `ytd` bug), same for `getESPNGameScore()`.

## Fix: capacity purge threshold set to 95% — tests and docs aligned

### Problem

`GameService.DISK_USAGE_THRESHOLD` was raised from `0.9` (90%) to `0.95` (95%), but the test
fixtures and the documentation still assumed 90%. Two tests in
`backend/src/games/tests/games.service.spec.ts` mocked `getDiskUsage()` at `0.95` — exactly _at_
the threshold, so `purgeOldestMonthIfNeeded()` returned `"none"` while the tests expected
`"purged"`:

- `purgeOldestMonthIfNeeded > should purge ONLY the oldest month when disk usage exceeds threshold`
- `purgeOldestMonthIfNeeded > never loops: purges a single month even when usage stays above threshold`

### Solution

- **Tests** (`games.service.spec.ts`): the "above threshold" fixtures now mock `0.97`
  (`usedMB: 97` / `totalMB: 100`), which stays strictly above the threshold; stale comments
  referencing "90%" were rewritten to reference the threshold generically or the new 95% value.
- **Tests** (`games.controller.spec.ts`): the mocked `getCapacityStatus()` payload now reports
  `threshold: 0.95` instead of the stale `0.9`.
- **Source** (`games.service.ts`): the JSDoc on `getCapacityStatus().threshold` no longer claims
  "default 0.9" — it points at `DISK_USAGE_THRESHOLD` (0.95).
- **Docs** updated from 90% to 95%: `backend/docs/games/games.service.ts.md`,
  `backend/docs/games/games.controller.ts.md`, `backend/docs/cronJob/cronJob.service.ts.md`.
- The `0.85` "CRITICAL" early-warning in `getDiskUsage()` is unchanged (still below the 95%
  trigger, so it keeps warning _before_ a purge).

### Result

- `npx jest` → 8/8 suites, 199/199 tests pass (the 2 previously failing purge tests are fixed).
- Note: the 2 failures listed as "pre-existing" in the _phantom playoff games_ entry below are
  exactly these tests; they are now resolved.

## Fix: phantom playoff games now deactivated immediately when their series is already decided

### Problem

When a playoff series ends early (e.g. Cubs swept 0-2 by Padres in the 2026 NLWC), ESPN **never
creates the event** for the remaining games. There is no status to detect: no `STATUS_CANCELLED`,
no `STATUS_POSTPONED`, nothing — the game is simply absent from the feed. Those games stayed
`isActive: true` and visible in the API for the full **48-hour grace period**
(`missingSince: 2026-10-01T16:53:58Z` → deactivation only on 2026-10-03), showing users a match
that could never be played.

The grace period was designed for the opposite case: _undecided_ "if necessary" playoff games
(Game 5/6/7) that transiently disappear from the source and reappear, where a flicker must be
avoided. A decided series is not transient — the game will never come back.

### Solution

- **`GameService.decidedSeriesPattern` + `GameService._isSeriesDecided(seriesStatus?)`**
  (`backend/src/games/games.service.ts`, new): matches ESPN `series.summary` strings certifying the
  series is over — `(?:win|wins|won)\s+(?:the\s+)?series`, `series (is) over`, `series won`
  (covers `"SD wins series 2-0"`, `"LAD wins the series 4-3"`, `"Series over"`).
- In `getLeagueGames()`, a future game absent from the fresh fetch is now deactivated **immediately**
  when `_isSeriesDecided(g.seriesStatus)`, bypassing the grace period entirely and never writing
  `missingSince`. It is grouped in a separate `toDeactivateDecided` list with its own log line so
  the two deactivation reasons stay distinguishable.
- The `existingFuture` projection now also selects `seriesStatus` (previously only
  `uniqueId` / `missingSince`).
- The check is placed **after** the "game is back in the source" test, so a reappearing game is
  always confirmed first and never deactivated despite a stale decided `seriesStatus`.
- An empty/absent `seriesStatus` returns `false`: absence of proof keeps the normal grace period,
  so no game is deactivated on a guess.

`seriesStatus` is reliably available on these future games because `syncGameWithScore()` already
propagates it to later games of the same matchup (games.service.ts) — which is exactly how the
phantom Game 3 carried `"SD wins series 2-0"`.

### Tests

- `backend/src/games/tests/games.service.spec.ts` — 4 new tests in
  `getLeagueGames playoff grace period`: immediate deactivation on a decided series (asserting no
  `missingSince` write), the same while mid-grace-period, grace period still applied for an
  undecided status (`"Series tied 1-1"`), and grace period still applied when `seriesStatus` is
  absent.
- 58 passed / 2 failed. The 2 failures are **pre-existing** and unrelated
  (`purgeOldestMonthIfNeeded` disk-usage threshold, expecting `"purged"` but receiving `"none"`);
  they fail identically on the unmodified baseline (verified via `git stash`).

### Files changed

- `backend/src/games/games.service.ts` — pattern + helper, projection, short-circuit, deactivation.
- `backend/src/games/tests/games.service.spec.ts` — 4 new tests.
- `backend/docs/games/games.service.ts.md` — documented the decided-series short-circuit.

## Chore: dead `purgeOldestMonth` test removed, stale cron doc fixed, purge log gaps closed

### Changes

- **Dead test removed** — `backend/src/cronJob/tests/cronJob.service.spec.ts`: deleted the
  `describe('purgeOldestMonth (twice-daily time-based purge)')` block (4 tests calling
  `CronService.purgeOldestMonth()`, a method that does not exist) plus its mock. At HEAD this
  block made the whole suite fail to compile (`TS2339` ×4), so `cronJob.service.spec.ts` could
  not run at all; the suite now runs (15 tests).
  - `backend/docs/cronJob/cronJob.service.ts.md` — removed the stale Key Feature line and the
    schedule-table row for the non-existent twice-daily `purgeOldestMonth()` cron (the code has
    8 crons, none of them a twice-daily purge; the oldest-month purge is the hourly
    `monitorDiskCapacity()`).
- **Log gaps closed** — `backend/src/games/games.service.ts` `purgeOldestMonthIfNeeded()` now
  logs `[Capacity Manager]` on the two previously silent outcomes (skipped by the 1-hour guard,
  and below the 90% threshold), so all four paths (`purged` / `skipped` / `below threshold` /
  `error`) are visible in the logs.

### Result

- `npx tsc --noEmit` → 0 errors.
- `npx jest --runInBand` → 7/7 suites, 175/175 tests pass. Note: with the default parallel
  workers, `utils.spec.ts › needRefresh (empty games)` can hit its 5s timeout — that test
  performs a real `fetch` to `site.api.espn.com` and 7 concurrent ts-jest workers can starve it;
  it passes in isolation and serially (environment-dependent flake, not a code defect).

---

## Changed: `POST /games/refresh/allOldies` — 30-second wait between purge retries

### Goal

After each league's `getOldiesGames()`, the endpoint retries `purgeOldestMonthIfNeeded()` up to 5 times.
Each attempt now waits **30 seconds** before the next one (except after the last), so MongoDB disk
usage has time to settle between deletions.

### Changes

- `backend/src/games/games.controller.ts` — `refreshAllOldies()`: fixed the dead retry loop
  (`for (i < 0; ...)` → `for (let i = 0; i < 5; i++)`), passes `force: true`, and awaits
  `setTimeout(30 * 1000)` between attempts (skipped after the 5th).
- `backend/src/games/games.service.ts` — `purgeOldestMonthIfNeeded(force = false)`: `force: true`
  bypasses the 1-hour `CHECK_INTERVAL_MS` guard (otherwise retries 2–5 would return `none` without
  purging) and invalidates the 60s `getDiskUsage()` cache so each retry re-measures real usage.
- Docs: `backend/docs/games/games.controller.ts.md` (endpoint now fully documented: random league
  order, per-league purge retries, 30s wait, `force` semantics), `backend/docs/games/games.service.ts.md`
  (`force` param), `backend/docs/cronJob/cronJob.service.ts.md` (fixed stale "every 6 hours" →
  hourly `0 */1 * * *`, matching the code).

---

## Added: `GET /games/league-day/:gameDate` — day games grouped by league (+ favorites section)

### Goal

The frontend day view uses this route for **past dates**, where leagues are more meaningful
than kick-off hours, and it must receive the grouping, the section order and the favorites
section already computed.

### Changes

- `backend/src/games/games.service.ts`
  - `_findEnrichedGamesForDay(gameDate, leagues?, maxResults?, skip?)` (private) — the read-only
    query/enrichment shared by the day views, extracted from `findByDateHour` with identical
    behaviour (active + `homeTeamId === teamSelectedId`, `leagues` filter, today's 3-hour
    yesterday window, `skip`/`limit`, `startTimeUTC` sort, 12-hour `FINISHED` guard,
    `_enrichGameWithTeamData`). Empty day → `[]`.
  - `findByDateLeague(gameDate, leagues?, maxResults?, skip?, favoriteTeams?)` — groups the
    enriched games by league and returns
    `{ groups: [{ key: 'FAVORITES'?, games }, { key: <league>, games }, …] }`:
    - the leading `FAVORITES` group is built from the `favoriteTeams` param
      (`,` / space / `+` separated team `uniqueId`s) and only added when at least one favorite
      team plays that day; the same games **stay** in their league group;
    - league groups are ordered alphabetically (`localeCompare`; unknown/empty league → `OTHER`,
      sorted like any other league name);
    - games are ordered from oldest to most recent (`startTimeUTC` ascending) inside every group.
      Empty day → `{ groups: [] }` (still no
      refresh-on-empty).
  - `findByDateHour` now delegates to `_findEnrichedGamesForDay` (returns `{}` on an empty day).
- `backend/src/games/games.controller.ts` — new `GET /games/league-day/:gameDate` with `leagues`,
  `maxResults`, `skip` and `favoriteTeams` query params (no conflict with `GET /games/league/:league`).
- `backend/src/games/tests/games.service.spec.ts` — added `skip`/`limit` to the model mock and a
  `findByDateLeague` suite (alphabetical league order, games oldest-to-newest within each group,
  favorites on the away team, favorites omitted, leagues filter + pagination, empty day without
  `getAllGames`).
- `backend/src/games/tests/games.controller.spec.ts` — `findByDateLeague` mock + forwarding tests.

### Docs

- `backend/docs/games/games.service.ts.md` — documented `_findEnrichedGamesForDay` and
  `findByDateLeague` (payload, ordering, favorites duplication).
- `backend/docs/games/games.controller.ts.md` — added the new route.

---

## Fixed: capacity purge wiped the whole database — now deletes only the oldest month

### Problem

`POST /games/capacity/check` (and the 6-hourly `monitorDiskCapacity()` cron) called
`GameService.purgeOldestYearsIfNeeded()`, which deleted **entire years** in a `for` loop (oldest first) and,
after each deletion, re-checked disk usage to decide when to stop (`break` once < 90%).

But `getDiskUsage()` serves a value cached for 60 seconds (`DISK_USAGE_CACHE_TTL_MS`), and that cache had just
been filled by the very check that triggered the purge. Every post-deletion re-check therefore returned the
same stale "≥ 90%" figure, the `break` never fired, and the loop kept deleting year after year until **the
whole database was emptied**.

### Solution

When usage ≥ 90%, the purge now performs a **single call to `purgeOldestMonth()`** (deletes only the oldest
month, e.g. `2016-09`) and returns immediately. **No loop at all** — a stale cache can never trigger repeated
deletions. Space is freed progressively: each subsequent check (cron every 6h / manual endpoint) may purge one
more month.

- Renamed `purgeOldestYearsIfNeeded()` → **`purgeOldestMonthIfNeeded()`**.
- Return shape changed: `{ action, diskUsage, purgedYear?, purgedMonth?, deletedCount?, remainingYears? }`
  (replaces `purgedYears?: number[]`).
- `diskUsage` in the response is the measurement that _triggered_ the purge (taken before the deletion); it is
  re-measured on the next check once the 60-second cache expires.
- Removed the now-unused private helper `deleteGamesForYear()`.

### Files changed

- `backend/src/games/games.service.ts` — new `purgeOldestMonthIfNeeded()`, removed `deleteGamesForYear()`, oldies
  capacity-check call updated.
- `backend/src/games/games.controller.ts` — `POST /games/capacity/check` delegates to the new method (also fixed
  decorator indentation).
- `backend/src/cronJob/cronJob.service.ts` — `monitorDiskCapacity()` delegates to the new method and logs the
  purged month instead of purged years.
- `backend/src/games/tests/games.service.spec.ts` — tests updated + regression test asserting the purge is
  triggered **exactly once** even when usage stays above the threshold.
- Docs: `backend/docs/games/games.service.ts.md`, `backend/docs/games/games.controller.ts.md`,
  `backend/docs/cronJob/cronJob.service.ts.md`.

---

## Added: summary counter logs after purging unresolved / missing-score games

### Changes

- `backend/src/games/games.service.ts`:
  - In `removeStaleUnresolvedGames()`: added a summary log `[fetchGamesScores] Removed ${deletedCount} unresolved game(s) started more than ${maxAgeDays} days ago.` after completing the deletion loop.
  - In `removeOldGamesWithoutScore()`: added a summary log `[fetchGamesScores] Removed ${deletedCount} game(s) without score started more than 72h ago.` after completing the deletion loop.
- `backend/src/games/tests/games.service.spec.ts`: updated tests to assert the summary log after deletions.

---

## Changed: `getOldGames` cron selects a random year strictly between `currentYear - 1` and `currentYear - maxYearBeforeDelete`

### Purpose

In `CronService.getOldGames()` (runs daily at 10:00 AM), the random year selection previously included `currentYear` (`minYear + Math.floor(Math.random() * (currentYear - minYear + 1))`). Because the current/in-progress season was flagged as `isCurrentSeason: true`, it bypassed the `status.complete` dry-run check and was always unconditionally refreshed, even though in-progress seasons are already kept up-to-date by the regular rotation (`refreshLeaguesOneByOne`) and live score crons.

### Changes

- `backend/src/cronJob/cronJob.service.ts`: the random year range is now bounded by `maxOldieYear = currentYear - 1` instead of `currentYear`. The cron strictly picks a random league from `League` and a random past year in `[currentYear - maxYearBeforeDelete .. currentYear - 1]`.
- All selected years are past seasons, allowing the `status.complete` optimization to skip DB writes whenever a past season is already fully retrieved.
- `backend/src/cronJob/tests/cronJob.service.spec.ts`: updated the unit test to verify that `randomYear` is strictly within `minYear .. currentYear - 1` and never hits `currentYear`.

---

## Added: weekly purge of stale teams without active games

### Purpose

Delete teams that disappeared from the provider (renamed/defunct) and have no
active game left: candidates are teams whose `updateDate` is older than 2
months (refreshed monthly by `getTeams()`) and that are referenced by **no**
`isActive: true` game (`teamSelectedId`/`homeTeamId`/`awayTeamId`).
`HistoricalTeams` entries and `isActive === false` teams are never deleted
(display fallback for oldies). A team still referenced by any active game is
kept (covers off-season leagues).

### Files

- `backend/src/teams/teams.service.ts` — `findStaleTeamCandidates()`,
  `purgeStaleTeamsWithoutGames(usedTeamIds)`
- `backend/src/games/games.service.ts` — `findUsedTeamIds()`,
  `purgeStaleTeamsWithoutGames()` (delegates to TeamService, no circular
  dependency)
- `backend/src/cronJob/cronJob.service.ts` — `purgeStaleTeams()` weekly Sunday
  4AM UTC (refreshes teams first, then purges)
- `backend/src/games/games.controller.ts` — `POST /games/teams/purge-stale`
  (API key)
- `backend/src/teams/tests/teams.service.spec.ts`,
  `backend/src/games/tests/games.service.spec.ts`,
  `backend/src/cronJob/tests/cronJob.service.spec.ts` — new tests
- `backend/docs/teams/teams.service.ts.md`, `backend/docs/games/games.service.ts.md`,
  `backend/docs/cronJob/cronJob.service.ts.md` — documentation

### Verification

`tsc --noEmit` clean; Jest suites pass.

---

## Change: Team catalogs and color maintenance

Expanded static catalogs and synchronized frontend/backend colors while preserving provider identifiers and avoiding duplicate aliases. College additions use lighter text and darker backgrounds; contrast requires separate validation. Redundant color properties were removed without changing effective values.

Documentation now describes general architecture and maintenance rather than team-specific decisions or color provenance. Catalog metadata does not import teams or schedules; database-driven regeneration can replace manual team entries and update colors.

## Change: Degenerate color pairs (color === background) treated as unknown

Entries where `color` equals `backgroundColor` (e.g. `#000000`/`#000000`, or the `#NULL` artifact) are unusable for display. New `isDegenerateTeamColors()` in `Colors.ts` makes such pairs "unknown" everywhere: `getTeamColors()` never returns one (cross-college fallback then `DEFAULT_TEAM_COLORS`), `_resolveTeamColors()` in `games.service.ts` no longer trusts them, and the ESPN team mapping (`espnAllData.ts`) replaces a `color === alternateColor` pair with the resolved fallback colors. General validation guidance is maintained in `COLORS_REPORT.md`.

### Files

- `backend/src/utils/Colors.ts` — `isDegenerateTeamColors()` + degenerate-aware `getTeamColors()`
- `backend/src/utils/fetchData/espnAllData.ts` — degenerate pair guard at fetch time
- `backend/src/games/games.service.ts` — `_resolveTeamColors()` degenerate-aware
- `backend/src/utils/Colors.spec.ts` + `backend/src/games/tests/games.service.spec.ts` — new tests
- `COLORS_REPORT.md` — general color validation checklist

## Change: University teams borrow colors from another college league when missing

Some university teams come back from ESPN without colors; their `ColorsTeam` entry was then stored as the generic placeholder (`#ffffff` on `#000000`) and the UI showed a white-on-black card. `backend/src/utils/Colors.ts` now exposes `getTeamColors(uniqueId)`: a known, non-placeholder entry is returned as-is; for a **university league** with a missing/placeholder entry the same university abbreviation is looked up in the other college leagues (a school keeps the same colors across sports, e.g. `NCAAB-X` → `NCAAF-X`); every other case (non-college leagues included) keeps `Colors.default`. This applies at fetch time (ESPN + NHL/PWHL team mapping) and at display time via the new `GameService._resolveTeamColors()`, so already-stored teams show the borrowed colors without waiting for a re-fetch.

### Files

- `backend/src/utils/Colors.ts` — `DEFAULT_TEAM_COLORS`, `isDefaultTeamColors()`, `COLLEGE_LEAGUES`, `getTeamColors()`
- `backend/src/utils/fetchData/espnAllData.ts` — fallback branch uses `getTeamColors(uniqueId)`
- `backend/src/utils/fetchData/hockeyData.ts` — NHL/PWHL team mapping uses `getTeamColors(uniqueId)`
- `backend/src/games/games.service.ts` — new `_resolveTeamColors()` used by `_enrichGameWithTeamData()`
- `backend/src/utils/Colors.spec.ts` + `backend/src/games/tests/games.service.spec.ts` — unit tests
- `backend/docs/utils/Colors.ts.md` (new) + `espnAllData.ts.md`, `hockeyData.ts.md`, `games/games.service.ts.md` — documentation

## Change: NCAA team discovery via scoreboard pages + league-scoped university logos

`getESPNTeams()` keeps the classic `GET teams` list, then enriches `CollegeLeague` teams add-only by scanning up to 10 scoreboard pages (`limit=1000`, early stop) of the current year; teams without `isActive` (partial scoreboard objects) are accepted. New `resolveUniversityLogo(league, abbrev)` tries `'{LEAGUE}-{ABBREV}'` first with systematic fallback to `'{ABBREV}'` (used in team mapping, match payloads, `getTeamsLogo()`, pre-save fallback). Missing logo links are backfilled with AND without the league prefix by `backfillMissingUniversityLogos()`, which runs ONLY at the end of `getTeams()` (manual `POST /teams/refresh` or monthly `updateTeams` cron — never on game fetches). Colors already keyed per league via `uniqueId` — unchanged.

### Files

- `backend/src/utils/fetchData/espnAllData.ts` — 10-page scoreboard enrichment + `resolveUniversityLogo()` + match logo fallbacks
- `backend/src/teams/teams.service.ts` — pre-save resolver + `backfillMissingUniversityLogos()` at end of `getTeams()` only
- `backend/src/games/games.service.ts` — `getTeamsLogo()` + `_enrichGameWithTeamData()` use the resolver
- `backend/docs/utils/fetchData/espnAllData.ts.md` + `backend/docs/teams/teams.service.ts.md` — documented discovery + logo resolution/backfill

## Change: NCAA oldies back to team-schedule endpoint (Olympics/soccer unchanged)

College leagues (`NCAAF, NCAAB, NCCABB, WNCAAB, NCAAMH, NCAAWH`) fetch history via the team schedule endpoint again (`teams/{id}/schedule?seasontype=&season=`): the `scoreboard?dates={year}` path (introduced in `e2e60ed`) does not return their full history. Olympics + soccer (`MLS`/`NWSL`) keep the scoreboard path, including oldies via explicit `season`. `NCAAS` is intentionally not restored.

### Files

- `backend/src/utils/fetchData/espnAllData.ts` — removed `collegeLeagues` from the scoreboard branch (back to `else`/team-schedule path)
- `backend/docs/utils/fetchData/espnAllData.ts.md` — created, documents both fetch paths

## Change: `getOldiesGames` skips the current year by default (explicit `?year=` still forces it)

Without a `year` param, `getOldiesGames()` now loops from `currentYear - 1` down to the oldest allowed year instead of starting at `currentYear`. The current (in-progress) season is already covered by the normal refresh (`getLeagueGames` / rotation cron), so fetching it again via oldies was duplicate work. Forcing remains possible via `POST /games/refresh/oldies?year=<currentYear>&league=<LEAGUE>` — the explicit-year validation (`minYear..currentYear`) is unchanged.

### Files

- `backend/src/games/games.service.ts` — default loop starts at `currentYear - 1`
- `backend/src/games/tests/games.service.spec.ts` — updated default-loop test, added explicit-current-year test
- `backend/docs/games/games.service.ts.md` — documented the default exclusion + explicit force

## Change: Oldies progress logging (`getOldiesGames`)

`getOldiesGames()` now logs `[Oldies] progress: <pct>% (<done>/<total>) — last: <LEAGUE> <year>` after each league×year step (in a `finally`, so failures still advance the counter), mirroring the existing `[getAllGames] progress` pattern. Useful to track long historical recoveries.

The per-game insertion loop in `getLeagueGames()` (oldies path only, `addMissingOnly: true`) also logs `[Oldies] <LEAGUE> (season <year>): insert progress: <pct>% (<processed>/<total>) — added <n>` at every 20% milestone plus a final 100% line, so the DB insertion phase itself shows advancement even when most games are skipped as already existing.

### Files

- `backend/src/games/games.service.ts` — progress counter in `getOldiesGames()` + insert-progress milestones in `getLeagueGames()`
- `backend/docs/games/games.service.ts.md` — documented the progress logging

## Change: Interrupted games keep a visible translated status (`DELAYED`); postponement behavior unchanged

### Problem

A temporarily interrupted game (e.g. a baseball rain delay / suspension) was being conflated with a true postponement: `_resolveStatus()` mapped `DELAY`/`RAIN`/`WEATHER` keywords to `POSTPONED`, and `syncGameWithScore()` then set `isActive = false`. The game disappeared from the responses and the frontend could never show it or translate its status.

### Solution

- `_resolveStatus()` now detects temporarily interrupted games (`STATUS_DELAYED` / `STATUS_SUSPENDED`, or `DELAY`/`SUSPENDED`/`INTERRUPTED`/`RAIN`/`WEATHER` text) and returns a distinct **`DELAYED`** status. A true postponement (`POSTPONED`/`POSTPONE`/`TBD`) or cancellation (`CANCELLED`) is still detected first, so a detail like "Postponed - Heavy Rain" stays a postponement.
- Because `DELAYED` is not in the `postponed`/`cancelled` conditions, `syncGameWithScore()` leaves the game `isActive = true` → it stays visible in API responses with `gameStatus = 'DELAYED'`.
- Postponed/cancelled games keep their existing behavior (unchanged).

### Files

- `backend/src/games/games.service.ts` — `_resolveStatus()` now returns `DELAYED` for interrupted games
- `backend/docs/games/games.service.ts.md` — documented the `DELAYED` status

## Fix: Stop `[fixScoreIssue]` log spam from future games with scores

### Problem

The `fixScoreIssue()` log (`Removing score for game X that has scores but hasn't started yet...`) appeared hundreds of times. Games like `NCAAWH-*`, `MLS-*` were repeatedly found with scores despite not having started.

### Root Cause

In `getLeagueGames()`, the ESPN/PWHL APIs return scores for games that haven't started yet. The `addMissingOnly` (oldies) flow already rejected future games entirely, but the **normal import flow** had no such guard — it called `create(game)` with the pre-game scores intact. This created an endless cycle:

1. `getLeagueGames` imports a future game with scores → scores written to DB
2. `fetchGamesScores()` → `fixScoreIssue()` finds it, logs a line, removes scores
3. Next `getLeagueGames` cycle re-imports the same scores → back to step 1

### Solution

Added a guard in `getLeagueGames()` that nullifies `homeTeamScore` and `awayTeamScore` for any game whose `startTimeUTC` is in the future, right before `create(game)` is called. This prevents pre-game scores from ever being persisted, eliminating the cycle.

### Files

- `backend/src/games/games.service.ts` — added score-stripping guard before `create(game)` in the import loop
- `backend/docs/games/games.service.ts.md` — documented the guard

## Change: League rotation now refreshes off-season leagues weekly instead of skipping them

### Problem

The `refreshLeaguesOneByOne()` cron skipped off-season leagues entirely (`isCurrentSeason` check). This meant that if a league released its schedule during the off-season (e.g. NFL in May, NBA/NHL in August), the system wouldn't pick it up until the season officially started.

### Solution

Replaced the hard off-season skip with a `needRefresh()` check that uses `numberOfDaysToRefresh()`:

- **Playoffs**: refresh every day
- **Regular season**: refresh every 3 days
- **Off-season**: refresh every 7 days

This ensures off-season leagues are still checked weekly for newly released schedules, while in-season leagues get refreshed more frequently.

### Files

- `backend/src/cronJob/cronJob.service.ts` — replaced `isCurrentSeason` skip with `needRefresh()` check in `refreshLeaguesOneByOne()`
- `backend/docs/cronJob/cronJob.service.ts.md` — updated documentation

## Changed: Unified fetch behavior - current season vs historical (`espnAllData.ts`, `utils.ts`)

### Problem

Different leagues had different fetch behaviors for normal refreshes, causing confusion and inefficiency. Historical data was being fetched on every normal refresh for some leagues. Also, the concept of "current year" didn't account for seasons spanning two calendar years (e.g., NHL Oct-Apr).

### Solution

Unified the year selection logic for **all leagues**:

- **Normal fetch** (no `season` param): Fetches only the **current season years** based on `startSeason`/`endSeason` config
- **Fetch oldest (`getOldiesGames`)**: Fetches historical years via the `season` parameter (up to 10 years back)

Added new utility function `getCurrentSeasonYears(leagueName)` in `utils.ts`:

- For seasons spanning two years (e.g., NHL Oct-Apr): returns both years (e.g., [2025, 2026] or [2026, 2027])
- For single-year seasons (e.g., MLB Mar-Sep): returns only the current year

This applies to:

- Games fetching in `getEachTeamSchedule()` for NCAA and Olympics (scoreboard API)
- Teams fetching fallback in `getESPNTeams()` for NCAA and Olympics

### Files changed

- `backend/src/utils/utils.ts` — Added `getCurrentSeasonYears()` function.
- `backend/src/utils/fetchData/espnAllData.ts` — Uses `getCurrentSeasonYears()` for normal fetch.
- `backend/CHANGELOG_ARCHITECTURE.md` — this entry.

---

## Fixed: NCAA college leagues games not fetching (`espnAllData.ts`)

### Problem

The NCAA college leagues were using the ESPN `/teams/${id}/schedule` endpoint with `seasontype` parameter to fetch games. However, ESPN does not populate this route for some college sports - it returns empty arrays or 404 errors.

This caused:

- No past games being retrieved for NCAA leagues
- No future games being retrieved for NCAA leagues
- Missing schedule data for these leagues

### Solution

Added all NCAA college leagues to the `collegeLeagues` set that uses the **scoreboard API** instead of the schedule API. The scoreboard API (`/scoreboard?dates=${year}`) returns all games for a year, which are then filtered by team ID.

The college leagues now using the scoreboard API:

- NCAAF (College Football)
- NCAAB (Men's College Basketball)
- NCCABB (College Baseball)
- WNCAAB (Women's College Basketball)
- NCAAMH (Men's College Hockey)
- NCAAWH (Women's College Hockey)

### Files changed

- `backend/src/utils/fetchData/espnAllData.ts` — Added `collegeLeagues` set and modified `getEachTeamSchedule()` to use scoreboard API for all college leagues.
- `backend/CHANGELOG_ARCHITECTURE.md` — this entry.

---

## Refactored: `getDiskUsage()` production hardening (`games.service.ts`)

The `getDiskUsage()` method was refactored for production robustness with the following improvements:

- **Type safety**: Replaced `(this.gameModel.collection as any).conn.db as any` with proper Mongoose API access via `this.gameModel.db.db` — eliminates hidden `any` casts and prevents runtime crashes if Mongoose internals change.
- **In-memory caching**: Added a 60-second TTL cache (`DISK_USAGE_CACHE_TTL_MS`) to avoid spamming `dbStats` on every call — critical when healthchecks or Kubernetes probes hit the endpoint frequently.
- **Accurate size calculation**: Now prioritizes `totalSize` (data + indexes across all collections) for shared clusters (M0/M2/M5), and falls back to `storageSize + indexSize` for dedicated clusters (M10+).
- **Percentage capping**: The percentage is now clamped to a maximum of 1.0 (100%) using `Math.min(rawPercentage, 1)`.
- **Critical threshold alerting**: Logs a `console.warn` when disk usage exceeds 85%, providing early warning before the 90% purge threshold.
- **Graceful degradation**: On transient errors, returns the last cached value instead of a cold fallback, ensuring continuity of service.

### Files changed

- `backend/src/games/games.service.ts` — `getDiskUsage()` refactored with caching, type safety, and production hardening.
- `backend/CHANGELOG_ARCHITECTURE.md` — this entry.

---

## Changed: `purgeOldestMonth` now runs twice daily (`cronJob.service.ts`)

The oldest-month purge cron was upgraded from **once daily (3AM UTC)** to **twice daily (3AM & 3PM UTC)** to accelerate time-based cleanup of historical game data.

- **Schedule**: `0 3,15 * * *` (3AM and 3PM UTC) — roughly 12 hours apart.
- **Behavior unchanged**: deletes all games from the oldest month in the DB (e.g. September 2016), logs the count and remaining years.
- **Tests updated**: `cronJob.service.spec.ts` describe block renamed to `purgeOldestMonth (twice-daily time-based purge)`.

### Files changed

- `backend/src/cronJob/cronJob.service.ts` — cron expression `0 3 * * *` → `0 3,15 * * *`.
- `backend/src/cronJob/tests/cronJob.service.spec.ts` — renamed describe block.
- `backend/docs/cronJob/cronJob.service.ts.md` — documented new schedule.

---

## Changed: Single league rotation cron (`cronJob.service.ts`)

The six fixed daily per-league crons (`updateMLBGames` 2 AM → `updateWNBAGames` 7 AM)
are replaced by ONE 10-minute cron, `refreshLeaguesOneByOne()`:

- **One league per 10-minute tick**, walking the whole `League` enum in order —
  covers every league daily (college/NWSL/Olympics included, which the fixed crons
  never refreshed), and bounds each third-party cycle to a single league.
- **Window 4 AM-11 AM New York** (`America/New_York`) — ticks outside the window
  are no-ops; 17 leagues × 10 min = the full list completes ~2 h50 after opening
  (~6 h50 AM NY), well inside the window. The cursor resets when the 4 AM window
  of a new NY calendar day opens (day key from the NY-converted clock).
- **Season-gated**: `isCurrentSeason` / `isPlayoffsPeriod` (10-day cached dates)
  skip off-season leagues without any third-party fetch; the slot is still consumed.
- **Slot consumed before awaiting**: a slow refresh never double-runs the same
  league; a restart resets the cursor and re-walks fresh leagues (skipped by the
  1-hour timestamp / staleness gates in `getLeagueGames`).
- **No overlap with the fast crons**:
  - schedules are offset — rotation `*/10` (:00,:10,…), scores `2-59/10`
    (:02,:12,…), availability `7-59/12` (:07,:19,…): no shared fire minute;
  - `GameService.isScoreRecoveryRunning` (new getter) lets the rotation postpone
    its tick while a score recovery cycle runs (slot not consumed, retried next tick);
  - conversely `CronService.isHeavyRefreshRunning` (rotation OR oldies) makes the
    scores and availability crons skip their tick.

### Files changed

- `backend/src/cronJob/cronJob.service.ts` — `refreshLeaguesOneByOne()` + removed `update{MLB,NBA,NFL,NHL,PWHL,WNBA}Games`; offset schedules + `isHeavyRefreshRunning` guards.
- `backend/src/games/games.service.ts` — `isScoreRecoveryRunning` getter.
- `backend/src/cronJob/tests/cronJob.service.spec.ts` — rotation tests (window, order, season skip, next-day idle, overlap postponement, fast-cron skip).
- `backend/docs/cronJob/cronJob.service.ts.md` — updated job table.

---

## Added: Season-gated recovery games fetch at startup (`cronJob.service.ts`)

Since the read-only routes change (`findAll` / `findByDate` / `findByDateHour` no longer
refresh on empty), a **cold or stale DB** would stay empty until the next daily/monthly
cron (up to ~24 h) — e.g. a deploy/restart in the evening, or a wiped games volume.

`CronService.onModuleInit` now schedules (2 min after boot, after the existing 30 s
score recovery) a one-shot `getAllGames(false, new Date())`:

- **Season-gated per league**: the `date` boundary makes `getAllGames` skip leagues
  where `isCurrentSeason(league, today)` / `isPlayoffsPeriod(league, today)` are false —
  off-season leagues are never fetched.
- **Warm restarts stay cheap**: `getLeagueGames`'s internal 1-hour timestamp freshness
  and `needRefresh` staleness gates skip already-fresh leagues; each attempt stamps the
  league (`'auto'` timestamp) so a crash/restart loop makes progress instead of
  re-fetching completed leagues.
- **Fresh-deploy gap closed**: `getAllGames` fetches teams first when the teams
  collection is empty — `checkLeagueGamesAvailability` cannot (its 30 % threshold
  compares against a zero team count, so it never triggers).

Why not piggyback on `fetchGamesScores`: it only updates scores of games **already in
the DB** (`fetchGamesForLiveScoreUpdate(2)`) and never inserts new scheduled games.
`checkLeagueGamesAvailability` does insert schedules but is window-limited (0–11 LA)
and has the zero-team edge above.

### Files changed

- `backend/src/cronJob/cronJob.service.ts` — recovery `getAllGames(false, new Date())` scheduled in `onModuleInit`.
- `backend/src/cronJob/tests/cronJob.service.spec.ts` — fake-timer test for the scheduled recovery.
- `backend/docs/cronJob/cronJob.service.ts.md` — documented the startup recovery job.

---

## Changed: Read-only game routes — no refresh-on-empty (`games.service.ts`)

The date-view routes (`GET /games/hour/:gameDate` → `findByDateHour`,
`GET /games/date/:gameDate` → `findByDate`, `GET /games` → `findAll`) no longer
trigger league refreshes:

- **Empty result** → returns `{}` / `[]` immediately. Previously, on a totally empty
  DB these paths awaited `getAllGames(false, gameDate, ...)` — and `findAll()` even
  called `getAllGames()` with **no date and no league filter**, refreshing every
  league from third-party APIs directly inside a user request.
- **Games found for today** → the `needRefresh`-gated background loop (one
  `getLeagueGames` per stale league seen in the day's games, chained on
  `refreshChain`) has been removed from `findByDate` / `findByDateHour`.
- `refreshChain` (the last chained-refresh mechanism in read paths) is deleted.

Why: these call-time refreshes blocked the backend during sequential third-party
schedule fetches and, combined with the 460 MB heap budget
(`NODE_OPTIONS=--max-old-space-size=460`), caused memory-pressure blocks and server
restarts. An empty day is a legitimate result (off-season); the frontend already
handles it (`NoResults` + bounded auto-retry + cooldown).

Data freshness is now entirely the cron jobs' responsibility, unchanged:

- monthly `getAllGames` (1st of month, 1 AM) + monthly teams (1st, 0:30 AM),
- daily per-league refreshes 2 AM–7 AM (MLB, NBA, NFL, NHL, PWHL, WNBA),
- `fetchGamesScores` every 10 minutes (11 AM–2 AM NY) + once at server restart,
- `checkLeagueGamesAvailability` every 12 minutes (0 AM–11 AM LA) — re-triggers a
  league refresh when too few upcoming games are stored,
- `getOldGames` daily at 10 AM (oldies history, one league+year per run).

Manual levers unchanged: `POST /games/refresh/:league` (single league, `forceUpdate`),
`POST /games/refresh/all`, `POST /games/refresh/oldies`. `findByTeam` keeps its
existing refresh, already gated to leagues in season or playoffs.

### Files changed

- `backend/src/games/games.service.ts` — removed empty-path refreshes and today-branch `refreshChain` loops in `findAll` / `findByDate` / `findByDateHour`; deleted `refreshChain`.
- `backend/src/games/tests/games.service.spec.ts` — added read-only route tests (empty result returns without calling `getAllGames`).
- `backend/docs/games/games.service.ts.md` — documented read-only behavior.

---

## Added: Read-only capacity status endpoint

- **New endpoint** `GET /games/capacity/status` (requires API key) — returns a read-only snapshot of the MongoDB storage footprint **without performing any purge**.
- Response fields:
  - `diskUsage`: `{ usedMB, totalMB, percentage }` computed via the same `df` + `$collStats` fallback used by the existing capacity manager.
  - `years[]`: per-year game count (`{ year, count, oldestDate, newestDate }`), oldest → newest.
  - `teamCount`: total number of stored teams.
  - `gameCount`: total number of game documents.
  - `threshold` (0.9 by default) and `actionNeeded` (boolean) for an at-a-glance decision signal before triggering the destructive `POST /games/capacity/check`.
- New `GameService.getCapacityStatus()` and `TeamService.countAllTeams()` helpers.
- Test added in `games.controller.spec.ts`.

### Files changed

- `backend/src/games/games.service.ts` — `getCapacityStatus()` (read-only; wraps `getDiskUsage()`, `getAvailableYears()`, `countDocuments()`, and the new `TeamService.countAllTeams()`; returns safe defaults on any error).
- `backend/src/teams/teams.service.ts` — `countAllTeams()`.
- `backend/src/games/games.controller.ts` — `GET /games/capacity/status` route.
- `backend/src/games/tests/games.controller.spec.ts` — mock + test for `getCapacityStatus`.
- `backend/docs/games/games.controller.ts.md` / `games.service.ts.md` — documented the new endpoint and method.

---

The response message from `POST /games/refresh/oldies` used to list all requested years (e.g. "2026, 2025, 2024, ...") regardless of whether any games were inserted. Years where `added: 0` (all games already existed) cluttered the response.

Now:

- `getLeagueGames` returns `{ added, skippedExisting, skippedMissingTeamData }` when `addMissingOnly: true` (instead of the games array — only the oldies path uses this flag).
- `getOldiesGames` tracks which years had `added > 0` and only includes those in the message.
- When no years had additions, the message reads "completed — no new games were added (all years already up to date)".
- The response also includes `yearsWithAdditions: number[]` for programmatic use.

### Files changed

- `backend/src/games/games.service.ts` — `getLeagueGames` returns stats object when `addMissingOnly`; `getOldiesGames` filters message by years with additions.
- `backend/src/games/tests/games.service.spec.ts` — added tests for filtered message and "already up to date" case.
- `backend/docs/games/games.service.ts.md` — documented new return type.

---

## Added: Timeout + retry on ESPN schedule fetches (`espnAllData.ts`)

ESPN requests inside `getEachTeamSchedule` used raw `fetch` with undici's (very long)
default timeout, so a connect-timeout could block the schedule/oldies refresh for an
unbounded time and produce noisy errors.

- `fetchWithTimeout(url, timeoutMs, options?)` — aborts the request after 15 s using
  the global `AbortController`.
- `fetchWithRetry(url, retries = 1)` — retries once (500 ms backoff) on transient
  errors, then throws so the existing per-saison-type try/catch still captures it.
- The two `fetch` calls in `getEachTeamSchedule` (scoreboard + per-season-type
  schedule) now use `fetchWithRetry`.

- `fetchJsonOrNull(url)` (exported) — wraps the fetch→JSON step with a **fail-open** guarantee: returns parsed JSON for a 2xx JSON response, retries once on `429` (honouring `Retry-After`), and otherwise logs a `[ESPN]` warning with a body preview and returns `null` instead of throwing `SyntaxError` on an HTML/body page. A single bad ESPN response (rate-limit, bot-block, or team-not-found) therefore no longer aborts the whole refresh.


## Added: Closest past/upcoming game dates endpoint (`games.service.ts`, `games.controller.ts`)

New `GET /games/dates/closest` returns `{ previousDate, nextDate }` — the closest
past and upcoming game dates — optionally scoped by `leagues` and/or
`teamSelectedIds`. Implemented with **dedicated helpers** so the endpoint flow is
easy to follow:

- `GameService.getClosestDates({ leagues, teamSelectedIds })` — orchestrator.
- `GameService._buildClosestDatesFilter(leagues, teamSelectedIds)` — builds the
  Mongo filter (comma/space/plus leagues, comma-separated teams, both `$in`).
- `GameService._findClosestGameDate(filter, '$min'|'$max')` — single aggregation
  returning the boundary date or `null`.

Boundary: past is strictly `<` boundary, upcoming is `>=` boundary. The boundary
is the optional `date` query param (`YYYY-MM-DD`); if omitted it defaults to today
(UTC `readableDate`). `previousDate`/`nextDate` are returned as `YYYY-MM-DD` strings.

- `backend/src/games/games.controller.ts` — added `GET /dates/closest`.
- `backend/src/games/games.service.ts` — added `getClosestDates` + 2 private helpers.
- `backend/src/games/tests/games.controller.spec.ts` — controller forwards params.
- `backend/src/games/tests/games.service.spec.ts` — unit tests for `getDateRange`
  and `getClosestDates` (filters, boundary date, source & team scoping, fallbacks).

## Added: League-scoped date range limits (`games.service.ts`, `games.controller.ts`)

`GET /games/dates/range` now accepts an optional `leagues` query param
(comma/space/plus separated, uppercased). When provided, the min/max dates returned
by `GameService.getDateRange(leagues)` are scoped to those leagues via
`league: { $in }` instead of spanning every league.

- `backend/src/games/games.controller.ts` — added `@Query('leagues')` to `getDateRange`.
- `backend/src/games/games.service.ts` — `getDateRange(leagues?)` builds a league-scoped `$match`.
- `backend/src/games/tests/games.controller.spec.ts` — forwards the `leagues` param.

## Added: Progress logging during full league refresh (`games.service.ts`)

`getAllGames` now emits a `console.info` line at every 20 % of leagues processed
(`[getAllGames] progress: 20% (2/10)`), plus the initial list of leagues and a final
`[getAllGames] done`. If a league blocks mid-refresh, the last log line points
directly to it.

## Changed: Season-aware refresh gating for on-demand endpoints (`games.service.ts`)

Avoids calling third-party APIs (ESPN, PWHL) for leagues that are off-season:

- **`GET /games/team/:teamSelectedId` (`findByTeam`)**: when the team has no games, the
  league refresh now only runs if `isCurrentSeason(league, new Date())` or
  `isPlayoffsPeriod(league, new Date())` is true (league dates come from a 10-day cache).
- **`GET /games/date/:gameDate` (`findByDate`)**: on a totally empty DB, it now calls
  `await this.getAllGames(false, new Date(gameDate))` instead of `this.getAllGames()`,
  so `getAllGames` only refreshes leagues whose season/playoffs cover that date (same
  pattern as `findByDateHour`).
- **Cron jobs unchanged**: `cronJob.service.ts` calls `getAllGames()` without a date, so
  no season check applies and monthly/daily crons keep running all year round.
- **`getLeagueGames` no longer propagates provider errors**: the `try/finally` now has a
  `catch` that logs and returns. Without it, a single failing third-party API call
  (timeout / malformed response, common off-season) made `getAllGames` reject and turned
  every dependent route (`/games`, `/games/date/...`, `/games/hour/...`, `/games/team/...`)
  into a 500 — very visible when the frontend config contains a single off-season league.

### Files changed

- `backend/src/games/games.service.ts` — season gate in `findByTeam`; dated refresh in `findByDate`; error swallowing in `getLeagueGames`.
- `backend/docs/games/games.service.ts.md` — documentation updated.

---

## Added: Historical teams fallback for enrichment (`HistoricalTeams.ts`)

Old ("oldies") games involving defunct, relocated or renamed franchises previously
rendered with empty team data because those teams no longer have a living record in the
database. We now provide a **static fallback map** (same pattern as `UniversityLogos`)
keyed by the full `uniqueId` (`'{LIGUE}-{ABBREV}'`, e.g. `'NBA-SEA'`) that carries the
team `label`, `abbrev`, logo, dark logo, colors and optional `record`.

### Behavior

- `GameService._enrichGameWithTeamData` falls back to `HistoricalTeams[id]` when a
  game's `homeTeamId` / `awayTeamId` is not found in the DB `teamsMap`, so old games
  render correct name / logo / colors again.
- This file resolves **enrichment only**. Fetching _new_ historical games still needs the
  numeric ESPN team `id` (a Core API `seasons/{year}/teams` sync) and is out of scope.

### Guards / non-regression

- `GameService._deleteUnlinkedTeams` never deletes teams referenced by `HistoricalTeams`,
  nor teams marked `isActive === false` (they are required to enrich old games).
- `TeamService.generateLeaguesTeamsAndColorsFiles` excludes `HistoricalTeams` keys and
  `isActive === false` teams from `Teams.tsx`, keeping the frontend filter/favorites clean.
- The `Team` schema / `TeamType` / DTOs now expose `isActive?: boolean` (default `true`)
  to support future Core-API import of inactive teams with the same protections.

### Files changed

- `backend/src/utils/HistoricalTeams.ts` — new static fallback map + `HistoricalTeamEntry`.
- `backend/src/games/games.service.ts` — enrichment fallback; `_deleteUnlinkedTeams` guard.
- `backend/src/teams/teams.service.ts` — `Teams.tsx` generation excludes inactive/historical.
- `backend/src/teams/schemas/team.schema.ts`, `backend/src/teams/dto/*.ts`,
  `backend/src/utils/interface/team.ts` — added `isActive?: boolean`.
- `backend/docs/utils/HistoricalTeams.ts.md` — documentation of the new module.

---

Future playoff games that temporarily disappear from an external schedule source are
now protected from flickering. `getLeagueGames()` records the first missing time in
`missingSince`, keeps the game active for 48 hours, and deactivates it only when it
remains absent beyond that period. When the game reappears, the refresh confirms it,
restores `isActive: true`, and clears `missingSince`.

The behavior is limited to current-season refreshes with a successful non-empty fetch;
empty or historical fetches do not deactivate future games.

### Files changed

- `backend/src/games/schemas/game.schema.ts` — added the internal `missingSince` field.
- `backend/src/games/games.service.ts` — added delayed deactivation and reappearance handling.
- `backend/src/games/tests/games.service.spec.ts` — added lifecycle regression tests.
- `backend/docs/games/games.service.ts.md` — documented the grace-period behavior.

## Fixed: PWHL oldies lost shutout scores

PWHL historical imports inferred `FINISHED` only when both scores were different from `0`.
That incorrectly treated valid results such as `0-4` as unfinished and stored null scores.
The importer now uses HockeyTech's official final indicators (`final`, status `4`, or a `Final`
game status), so shutouts and overtime results retain their scores.

---

## Fixed: Oldies refresh crashed on team cleanup (CastError on ObjectId \_id)

### Problem

During the historical oldies refresh, `_deleteUnlinkedTeams` called `teamService.deleteManyByIds` with a
list of textual `uniqueId`s such as `"PWHL-DET"`. The query built `$or: [{ uniqueId: { $in: ids } }, { _id: { $in: ids } }]`,
so those plain strings were also pushed into `$in` on the ObjectId `_id` field. Mongoose then threw
`CastError: Cast to ObjectId failed for value "PWHL-DET" at path "_id" for model "Team"`, aborting the
cleanup right after teams were detected as unlinked (reproduced on every season 2026 down to 2019 in the logs).

### Solution

`deleteManyByIds` now only includes the `_id` branch for ids that are valid 24-char hex ObjectIds.
Plain textual uniqueIds (`"PWHL-DET"`, `"NHL-BOS"`, ...) are matched via `uniqueId` only, so the query
never casts a non-hex string into an ObjectId.

### Files changed

- `backend/src/teams/teams.service.ts` — filter valid ObjectIds before adding the `_id` branch in `deleteManyByIds`.
- `backend/src/teams/tests/teams.service.spec.ts` — updated `deleteManyByIds` tests + new regression test for textual ids.

---

## Fixed: MLB/MLS future games disappeared after the data update (crash between deactivating and re-writing)

### Problem

When refreshing a league (MLB, MLS, ...), the `getLeagueGames` service first **deactivated all future games** (`isActive:false`)and _then_ re-fetched/re-wrote the season. If the server **crashed/restarted** between these two steps (the very large oldies refreshes could trigger one), every upcoming game of that league was left `isActive:false` and never re-inserted. Result:the **Programme du jour** tab showed **No results** for 2026 in both MLB and MLS, until a manual league refresh succeeded.

### Solution

1. **Reordered the refresh**:the season is now fetched and the future games re-inserted `isActive:true` **before** any deactivation runs.
2. **Selective deactivation** (safe-replace): only the stale future games absent from the fresh season (matched by `uniqueId`) are deactivated, never blindly per date range.

3. **Empty-fetch guard**:if the fetch returns zero games, no deactivation happens (the league is never blanked on a crash or failed fetch..

4. **Bound the oldies cron**:the daily oldies refresh now processes **one random year per tick** (instead of up to 11 years at once) and has an **anti-reentrancy guard**,cutting the per-tick work volume that could trigger Render restarts during the data update.

### Files changed

- `backend/src/games/games.service.ts` — crash-safe reordered / selective / empty-guarded deactivation in `getLeagueGames`.
- `backend/src/cronJob/cronJob.service.ts` — one-random-year-per-tick oldies refresh + anti-reentrancy guard.

---

## Fixed: Oldies historical import now allows null scores for past games (cron fills them later)

### Problem

When recovering historical data via `POST /games/refresh/oldies?year=...&league=...`, games with null scores were rejected
even though they were valid completed matches. The strict validation required both home and away scores to be present, which
prevented leagues like MLS, NWSL, and Olympic games from being imported when score data was initially unavailable.
The log showed: `[Oldies] Skipping MLS-TOR-693036 ... because team/score data is incomplete...`.

### Solution

Split the validation into two concerns:

1. **Team requirement** (strict): Both home and away teams must be present. Games without proper team data are still rejected.
2. **Score requirement** (flexible for past games):
   - **Past games** (startTimeUTC < now): Null scores are allowed. The cron's `fetchGamesScores()` will fill them in later.
   - **Future games** (startTimeUTC ≥ now): Rejected to prevent scheduled games from polluting historical data.

### Changes

- **`GameService.getLeagueGames(params)` with `addMissingOnly: true`** (`backend/src/games/games.service.ts`, lines 485–510):
  - Removed strict score validation for past games;
  - Added date-based filtering to reject future scheduled games;
  - Allows historical matches with pending scores to be persisted and filled by the cron later.
- **Unit tests** (`backend/src/games/tests/games.service.spec.ts`):
  - Added regression test: past games with null scores are inserted;
  - Added regression test: future scheduled games are rejected.
- **Documentation** (`backend/docs/games/games.service.ts.md`):
  - Updated `getLeagueGames()` section to document the new validation logic.

### Result

Historical oldies recovery now successfully imports valid matches from all leagues, even when score data is initially pending.
The cron's `fetchGamesScores()` subsequently fills in the scores in a separate pass, eliminating the skip warnings.

### Verification

- Unit tests pass: 2 new regression tests confirm past-game insertion and future-game rejection.
- `npm run test -- --testPathPattern=games.service.spec` passes all tests.

---

## Changed: ColorsTeam / UniversityLogos regeneration is now additive-only (no deleted lines)

### Purpose

`generateLeaguesTeamsAndColorsFiles()` in `backend/src/teams/teams.service.ts` rewrote the
`ColorsTeam.tsx`/`ColorsTeam.ts` and `UniversityLogos.tsx`/`UniversityLogos.ts` files from scratch,
**overwriting** the whole file and therefore **deleting** any entry that was no longer produced by the
current team data. The requirement is that updating either of these two files must never remove a line —
only **add** new entries or **update** existing ones.

### Changes

- `backend/src/teams/teams.service.ts`:
  - added small helpers `readExistingFile()`, a block parser, and `mergeGeneratedEntries()`;
  - the ColorsTeam and UniversityLogos generation now merges freshly generated entries with the existing
    file content (additive/update-only) instead of replacing the file wholesale;
  - the same merge is applied to both the frontend mirrors (`frontend/constants/*.tsx`) and the backend
    mirrors (`backend/src/utils/*.ts`).
- `updateLeagues.js` (root): the `UniversityLogos.tsx` update now also merges with existing content so it
  does not delete previously stored logos, only adding or updating entries.
- Restored the previously-dropped `ColorsTeam` entries (`NCAAB-BUT`, `NCAAF-SIU`, `NCAAF-UND`) in both
  `backend/src/utils/ColorsTeam.ts` and `frontend/constants/ColorsTeam.tsx`.

### Result

Regenerating `ColorsTeam` or `UniversityLogos` (from the backend generator or the `updateLeagues.js` script)
no longer deletes lines: existing entries are preserved (or updated), and only new entries are added.

### Verification

- `tsc --noEmit` clean; Jest backend suite passes.
- `git diff` confirms ColorsTeam has no removed entries (only adds/updates) and UniversityLogos contains no
  truly-deleted keys (every removed line is an update).

---

## Added: oldies recovery never overwrites existing matches (only adds missing ones)

### Purpose

When re-running `POST /games/refresh/oldies?year=...&league=...` (or the historical cron), the oldies
path previously went through `getLeagueGames` → `create()`, which **overwrites** every already-stored game
whose `uniqueId` already exists in the DB. We now make oldies updates **additive only**: already-present matches
are left untouched, and only genuinely missing matches are inserted.

### Changes

- **`GameService.getLeagueGames(params)`** (`backend/src/games/games.service.ts`) — new `addMissingOnly: boolean = false` option:
  when `true` (oldies path only), the normal refresh path is unchanged:
  - the set of fetched `uniqueId`s already present in the DB is queried once;
  - games that already exist are **skipped** (never overwritten) when they are the **same match** — i.e. the
    `uniqueId` matches **AND** both the home score and the away score equal the stored ones;
  - if the `uniqueId` exists butt the scores differ (or are missing**, the game is treated as a stale/different result and
    **refreshed\*\* via `create()` instead of being skipped;
  - games missing a well-defined **home and away team** data (`homeTeamId`/`homeTeamShort`/`homeTeam`
    and `awayTeamId`/`awayTeamShort`/`awayTeam`) or missing a home/away score are skipped with a warning log;
  - only complete, missing games are created.
    Logs added / skipped counts.
- **`GameService.getOldiesGames(...)`** now passes `addMissingOnly: true` when calling `getLeagueGames`.
- Added unit tests in `backend/src/games/tests/games.service.spec.ts` (only-create-missing behavior; same-id+score guard; home/away data + score guard; flag passthrough).

### Result

Updating a year for a league never wipes or degrades existing match data anymore; it purely fills the
gaps by adding only the missing (complete) matches.

### Verification

`tsc --noEmit` clean; Jest suites pass (84 tests).

---

## Fixed: stale active PWHL game keeps triggering the scores fetch cycle on every start

### Problem

The backend logged `[fetchGamesScores] Fetching scores for PWHL on 2026-05-11...` at every server
start / cron run. A PWHL game stuck in the DB (`isActive: true`, non‑terminal status, started months
ago) matched `fetchGamesForLiveScoreUpdate(2)` forever, and since its final result can no longer be
recovered from the source, the recovery cycle re‑detected it each time.

### Changes

- **`GameService.removeStaleUnresolvedGames(maxAgeDays?)`** (`backend/src/games/games.service.ts`, new):
  purges games that are still `isActive: true`, started more than the max age ago (default 90 days),
  and whose `gameStatus` is not `FINISHED`/`FINAL`/`CANCELLED`/`POSTPONED`.
- New configurable `GameService.staleGameMaxAgeDays = 90`.
- `fetchGamesScores()` now calls `removeStaleUnresolvedGames()` at the end of the cycle, next to the
  existing `removeOldGamesWithoutScore()`.
- Added unit tests in `backend/src/games/tests/games.service.spec.ts`.

### Result

Stale, unresolvable active games are purged after ~3 months; the recurring `Fetching scores...` log
for those games disappears.

---

## Added: unit tests for the season-aware recovery features

### Purpose

Prevent regressions on the PWHL historical recovery, the `getOldiesGames` multi-year loop,
and the season-aware oldies cron.

### Added

- **`backend/src/games/tests/games.service.spec.ts`** — new `describe` blocks:
  - `getSeasonStatus`: past complete/incomplete seasons, current season always `complete`,
    PWHL pre-2024 short-circuit (no fetch / no DB count).
  - `getOldiesGames`: throws on out-of-range explicit year, loops over the last 5 seasons when
    no year is given, and processes a single explicit year with a league filter.
  - The `mockGameModel` now also exposes `countDocuments`.
- **`backend/src/cronJob/tests/cronJob.service.spec.ts`** (new file) — `CronService.getOldGames`:
  refreshes the current season even when `complete`, skips a past complete season without
  refreshing, and refreshes a past incomplete season. Uses a deterministic `Math.random`.

### Verification

`tsc --noEmit` clean; ESLint clean on the new/edited spec files; Jest suites pass.

---

## Added: cron oldies refresh is season-aware (dry-run comparison, no-op when complete)

### Purpose

The daily `getOldGames` cron used to pick a random year+league and unconditionally refresh
that season, even when the DB already had every game. It is now aware of what it still lacks.

### Changes

- **`GameService.getSeasonStatus(league, season?)** (`backend/src/games/games.service.ts`):
  does a **dry run** — it fetches a league+season's games from the source (same pipeline as a
  real refresh) **without saving anything** — then compares the number of obtained games against
  how many of those `uniqueId`s are already stored in the DB. Returns
  `{ league, season, obtained, stored, complete }`. It also reports `isCurrentSeason`:
  a season is the current/upcoming one when no `season`is given, or when`isCurrentSeason`
  matches for a representative date in that season (June 30). **For the current season the
  comparison is not trusted** (`complete`is always`true`) because a partial live DB is normal.
- **`GameService.\_fetchUniqueGames(league, season?)** (new private helper): extracts the
  fetch + flatten + `uniqueId`deduplication logic previously inlined in`getLeagueGames`, and
  is now shared by `getLeagueGames`(which saves) and`getSeasonStatus` (which doesn't).
- **`CronService.getOldGames`** (`backend/src/cronJob/cronJob.service.ts`): now
  1. picks a **random league**;
  2. loops over the last `maxYearBeforeDelete` years, most recent first;
  3. for each year, calls `getSeasonStatus`:
     - **current/upcoming season** → always refreshed (it is still in progress);
     - **past season** and `complete` (obtained counts == DB counts) → **skipped without
       modifying anything**, move to the next year;
     - **past season** and not complete → that year is refreshed via `getOldiesGames`;
  4. **if every year was already complete, it finishes without any modification**.

### Result

The cron avoids re-fetching **past** seasons whose games are already fully stored, and only
refreshes the past years where some games are missing. The **current season is always
refreshed** (a partial DB is expected mid-season). The PWHL pre-2024 years are naturally
treated as "complete" (they are a no-op).

---

## Added: `refresh/oldies` without a year loops over the last N seasons

### Purpose

`GET`/`POST /games/refresh/oldies` previously required a mandatory `year` query parameter;
omitting it raised a `400` error (`NaN`). It is now optional.

### Changes

- In `GameService.getOldiesGames(yearStr?, leagueParam?)` (`backend/src/games/games.service.ts`),
  when `year` is omitted/blank the method loops over the last `maxYearBeforeDelete` seasons
  (5 years), from the most recent to the oldest allowed, instead of requiring a single year.
  An explicit `year` still triggers the historical limit validation and processes a single year.
- `GamesController.refreshOldies` now types `year` as optional (`@Query('year') year?: string`).

### Result

`POST /games/refresh/oldies?league=PWHL` (no year) now recovers PWHL data for the last 5 years,
while `POST /games/refresh/oldies?year=2024&league=PWHL` still targets a single year.

### Note: PWHL pre-2024 seasons are a no-op

The PWHL debuted in 2024. `getLeagueGames` now early-returns (logs + exits) when it is called
for `League.PWHL` with a `season` earlier than 2024, so looping over the last 5 years for PWHL
silently skips the years 2020-2023 instead of making pointless API calls.

---

## Fixed: PWHL previous-season results could never be recovered

### Problem

Requesting past seasons via the `refresh/oldies` endpoint (or the cron job) returned no
PWHL data. In `backend/src/utils/fetchData/hockeyData.ts`, the PWHL branch of
`fetchGamesData()` called the schedule API **without** a `season_id` query parameter, so the
API fell back to its default season. The current default is `season_id=10` (`2026-27
Pre-Season`) whose schedule is **empty**, and the `season` (year) parameter was never
translated into a HockeyTech `season_id` — so previous years produced zero games.

### Changes

- `fetchGamesData()` now resolves the requested year to the relevant PWHL `season_id`(s) and
  appends `&season_id=...` to the schedule request. Without a year, it resolves the season
  that is currently active (or the earliest upcoming season if we are between seasons) and
  fetches all of its phase‑specific `season_id`s (pre‑season, regular, playoffs), passing each
  `season_id` to the schedule request to avoid the empty default pre‑season feed.
- Added `HockeyData.getPWHLSeasons()` (fetches the PWHL seasons list) and
  `HockeyData.getPWHLSeasonIds(year?)` which maps:
  - a calendar `year` → every season whose date span overlaps that year (a PWHL season spans
    two years, e.g. `2024` → `2024 Regular` + `2024 Playoffs` + `2024-25 Regular`);
  - no year → resolve the current/upcoming season and fetch all its phase‑specific `season_id`s
    (pre‑season, regular, playoffs); if the current date falls between seasons, pick the earliest
    upcoming season and return all of its phases.
- In `getPWHLTeamschedule()`, team‑schedule queries now match `home_team_code` and
  `visiting_team_code` **case‑insensitively**, so `MTL` matches `mtl` and vice‑versa.
- In `getPWHLTeams()`, the standings request now uses the correct season: it picks the
  regular season covering today (or, for pre‑season dates, the most recent regular season
  that has already ended), instead of blindly using the season id that the teams feed
  advertises. This guarantees standings are always read from a season that actually has a
  result board.
- Game status classification now follows HockeyTech's official final markers:
  `final === '1'`, `status === '4'` or a `Final` status string, matching the checklist.

### Result

`POST /games/refresh/oldies?year=2024&league=PWHL` (and equivalent 2025/2026 requests) now
returns PWHL results, and normal refreshes no longer silently return an empty schedule during
the off-season / pre-season period. Team schedules now correctly resolve the covering
`season_id` (including pre-season), match team codes case-insensitively, and PWHL team
standings come from the regular season that actually has a result board.

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


## Final: end-to-end verification of D1 refresh, purge and game cascade

### End-to-end results

- **POST /teams/refresh (D1 only, first full run):** DB team count 0 → **1352**. Per-league drain verified against the ESPN roster: **NCAAF 763 → 239** and **NCAAB 445 → 14**; **NCCABB 431 teams** dropped (14 remain, true D1 clubs). Safety rules unchanged: no HistoricalTeams, never `isActive === false`.
- **`isD1Groups()`** filters only parent group ids (`NCAAF 80/81`, etc.); live probe confirmed Nashville, Buffalo and AppState are D1 and present.
- **Live probe (pre-POST):** game counts (NCAAF 797, NCAAB 2411, NCAAMH 945, NHL 1263, NWSL 16, MLS 90, NCAAWH 582) were captured for the cascade baseline.
- **POST /games/refresh/all:** completed (16/16 leagues); HTTP capture and backend log confirmed the full refresh ran with ESPN RPS back-off, then the cascade walked the purge queue and ended with `[getAllGames] done`.
- **Cascade outcome (post-run /games/league counts):** **NCAAF 797 → 898** (+273 fresh games − 172 games of the 524 purged NCAAF teams), i.e. the purged ids walked the cascade one league at a time (`takeLastPurgedNonD1Ids(league)`) with no cross-league leak to NHL/NWSL/SPLL/NCAAMH/NCAWH. NCCABB had no games (0) so nothing to cascade; NCAAMH/NCAWH/NHL/NWSL/MLS untouched.
- **Backend health:** `/teams/leagues` → HTTP 200; process still running (`backend4.log`).
- **Unit tests:** `npx jest --runInBand` → **250 passed, 10 suites** (incl. 20 cronJob tests + 8 /games/league tests).
- **Repo state:** only the intentional new files are modified (`backend/src/teams/teams.service.ts`, `backend/src/games/games.service.ts`, `backend/src/utils/fetchData/espnAllData.ts`) plus `backend/docs/...` and `backend/CHANGELOG_ARCHITECTURE.md`; old pending-file, logo and color refactor leftovers were reverted to HEAD; frontend untouched.

### Notes

- ESPN league-key resolution helpers (`resolveESPNLeagueKeys`, `getESPNLeagueKeyForTeamId`) were removed with the pending file; the cascade and tests were revalidated against this new path.
- External ESPN API key returns `403` from outside (credential/network constraint, not code): NCCABB D1 set (``14` teams) verified through backend API (`/teams/league/NCCABB`).
- Prettier formatting was aligned (`backend/src/games/games.service.ts`).
- `POST /games/refresh/all` is throttled to one run per hour; subsequent runs run `getLeagueGames` per league and cascade each league separately.

### Benefit

These docs explain the purpose of each backend module and its main responsibilities so AI assistants and future contributors can understand the architecture more quickly.
