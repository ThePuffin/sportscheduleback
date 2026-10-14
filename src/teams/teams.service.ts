import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DeleteResult } from 'mongodb';
import { Model } from 'mongoose';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Game } from '../games/schemas/game.schema';
import { CollegeLeague, League } from '../utils/enum';
import { D1_PARENT_IDS, getESPNTeams } from '../utils/fetchData/espnAllData';
import { HockeyData } from '../utils/fetchData/hockeyData';
import { HistoricalTeams } from '../utils/HistoricalTeams';
import { TeamType } from '../utils/interface/team';
import { UniversityLogos } from '../utils/UniversityLogos';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { Team } from './schemas/team.schema';

const DIVISION_ONE_LEAGUES = new Set<string>([
  ...Object.keys(D1_PARENT_IDS),
  CollegeLeague.NCAAMH,
  CollegeLeague.NCAAWH,
]);

/**
 * How long the per-team active-game counts stay valid.
 *
 * `GET /teams?minGames=…` needs one aggregation over the games collection. It
 * is served by a DISTINCT_SCAN on `{ isActive: 1, teamSelectedId: 1 }` so it
 * reads no game document at all, but the result is memoised anyway: the counts
 * only move when a refresh writes/deletes games, and a team crossing the
 * threshold mid-request is irrelevant next to the cron cadence. Five minutes
 * keeps a burst of parallel requests (the frontend fires `GET /teams` from
 * several screens) down to a single aggregation without ever serving counts
 * that are meaningfully stale.
 */
const ACTIVE_GAME_COUNT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * `recordSeasonType` value of a preseason game. Shared with the fetchers, which
 * write `1` = preseason, `2` = regular season, `3` = playoffs.
 *
 * Named here (instead of inlined as `1`) because the meaning is the whole point
 * of the filter: only regular-season and playoff games make a team "official"
 * and therefore selectable.
 */
const PRESEASON_RECORD_SEASON_TYPE = 1;

@Injectable()
export class TeamService {
  private isFetchingTeams: { [league: string]: boolean } = {};
  private lastPurgedNonD1Ids: string[] = [];
  /**
   * Memoised result of `countActiveGamesByTeam()`, or `null` when the cache is
   * empty/expired. Cleared by `clearActiveGameCountCache()`.
   */
  private activeGameCountCache: {
    counts: Map<string, number>;
    timestamp: number;
  } | null = null;
  constructor(
    @InjectModel(Team.name) public teamModel: Model<Team>,
    @InjectModel(Game.name) private readonly gameModel: Model<Game>,
  ) {}

  /**
   * Returns and clears the queued `uniqueId`s deleted by the last `getTeams()`
   * run via `purgeNonD1Teams()`, so `GameService` can cascade the deletion to
   * their games. Kept as pull (not push) to avoid a Team↔Game circular
   * dependency: `GameModule` imports `TeamModule`, never the reverse.
   *
   * When `league` is given, only the ids of that league (`<LEAGUE>-…` prefix)
   * are drained: each league's game refresh cascades its own purge, and the
   * ids of the other leagues stay queued instead of being consumed by the
   * first refresh (whose `league` filter would never match them).
   */
  takeLastPurgedNonD1Ids(league?: string): string[] {
    if (!league) {
      const ids = [...this.lastPurgedNonD1Ids];
      this.lastPurgedNonD1Ids = [];
      return ids;
    }
    const prefix = `${league.toUpperCase()}-`;
    const taken: string[] = [];
    const remaining: string[] = [];
    for (const id of this.lastPurgedNonD1Ids) {
      if (id.toUpperCase().startsWith(prefix)) taken.push(id);
      else remaining.push(id);
    }
    this.lastPurgedNonD1Ids = remaining;
    return taken;
  }

  async create(
    teamDto: CreateTeamDto | UpdateTeamDto | TeamType,
    skipGenerateFiles: boolean = false,
  ): Promise<any> {
    const { uniqueId } = teamDto;

    let saved: any;
    if (uniqueId) {
      saved = await this.teamModel
        .findOneAndUpdate(
          { uniqueId },
          { $set: teamDto },
          { new: true, upsert: true },
        )
        .lean()
        .exec();
    } else {
      const newTeam = new this.teamModel(teamDto);
      saved = await newTeam.save();
      saved = saved.toObject ? saved.toObject() : saved;
    }

    const record = this.addRecord({ ...saved, ...teamDto });

    // Skip regenerating files during batch imports for performance
    // Files will be regenerated once at the end of the batch
    if (process.env.NODE_ENV === 'development') {
      if (!skipGenerateFiles) {
        try {
          await this.generateLeaguesTeamsAndColorsFiles();
        } catch (err) {
          console.error('Failed to regenerate league/team files:', err);
        }
      }
    }

    return record;
  }

  async getTeams(leagueParam?: string): Promise<any> {
    const leagueKey = leagueParam ? leagueParam.toUpperCase() : 'ALL';
    if (this.isFetchingTeams[leagueKey]) {
      console.info(`getTeams is already running.`);
      return;
    }
    try {
      this.isFetchingTeams[leagueKey] = true;
      const allActivesTeams: any[] = [];
      let leagues: string[] = [];
      if (leagueParam) {
        leagues = [leagueParam.toUpperCase()];
      } else {
        leagues = Object.values(League);
      }
      for (const league of leagues) {
        const activeTeams: TeamType[] = [];
        let teams: TeamType[] = [];
        try {
          if (league === League.PWHL) {
            const hockeyData = new HockeyData();
            teams = await hockeyData.getPWHLTeams();
          } else {
            teams = await getESPNTeams(league);
          }
        } catch (error) {
          console.error(`Error fetching teams for league ${league}:`, error);
          if (league === League.NHL) {
            const hockeyData = new HockeyData();
            teams = await hockeyData.getNHLTeams();
          }
        }
        if (teams.length) {
          activeTeams.push(...teams);
        }

        const savedTeams = [];
        let updateNumber = 0;
        for (const activeTeam of activeTeams) {
          activeTeam.updateDate = new Date().toISOString();
          activeTeam.isActive = true;
          // if ESPN didn't give us a logo, try our manual mapping before saving
          if (!activeTeam.teamLogo) {
            const parts = activeTeam.uniqueId?.split('-') || [];
            const abbrev = parts[1] || activeTeam.abbrev || '';
            if (abbrev && UniversityLogos[abbrev]) {
              activeTeam.teamLogo = UniversityLogos[abbrev];
            }
          }
          // Skip file generation during batch import for performance
          const saved = await this.create(activeTeam, true);
          savedTeams.push(saved);
          updateNumber++;
          console.info(
            'updated:',
            activeTeam?.label,
            '(',
            updateNumber,
            '/',
            activeTeams.length,
            ')',
          );
        }
        allActivesTeams.push(...savedTeams);

        // Remove stored teams ESPN no longer lists as Division 1. Only runs
        // when ESPN returned a non-empty D1 roster (empty = outage, nothing is
        // deleted — see `purgeNonD1Teams`). The just-fetched roster is passed
        // along so ESPN is not queried a second time; the deleted ids are
        // queued so `GameService` can cascade the deletion to their games.
        if (activeTeams.length > 0 && DIVISION_ONE_LEAGUES.has(league)) {
          const purged = await this.purgeNonD1Teams(league, activeTeams);
          if (purged.length > 0) {
            this.lastPurgedNonD1Ids.push(...purged);
          }
        }
      }

      // Generate files once after all teams have been imported
      if (process.env.NODE_ENV === 'development') {
        await this.generateLeaguesTeamsAndColorsFiles();
      }
      return allActivesTeams;
    } catch (error) {
      console.error(error);
      throw new Error('Error fetching teams: ' + error.message);
    } finally {
      this.isFetchingTeams[leagueKey] = false;
    }
  }

  /**
   * Deletes the stored teams of `league` that ESPN no longer lists as
   * Division 1. ESPN parent markers are used where available; NCAAMH and
   * NCAAWH use explicit allowlists in `getESPNTeams()`.
   *
   * Safety rules:
   * - never deletes when the ESPN fetch returns an empty list (outage guard);
   * - never deletes `HistoricalTeams` entries or `isActive === false` teams;
   * - returns the deleted `uniqueId`s so the caller can cascade the deletion
   *   to the games collection (teams and games live in different modules, so
   *   the game deletion itself happens in the caller, never here).
   *
   * `espnTeams` may pass the roster the caller just fetched, so a refresh does
   * not hit ESPN twice for the same league.
   */
  async purgeNonD1Teams(
    league: string,
    espnTeams?: TeamType[],
  ): Promise<string[]> {
    if (!DIVISION_ONE_LEAGUES.has(league)) return [];
    const roster = espnTeams ?? (await getESPNTeams(league));
    if (!roster?.length) {
      console.info(
        `[purgeNonD1] ${league}: ESPN returned no teams — purge skipped.`,
      );
      return [];
    }

    const d1Ids = new Set(
      (roster || []).map((team) => team?.uniqueId).filter(Boolean),
    );
    const stored = await this.teamModel
      .find({ league })
      .select({ uniqueId: 1, isActive: 1, _id: 0 })
      .lean()
      .exec();
    const toDelete = (stored || [])
      .map((team: any) => team?.uniqueId)
      .filter(
        (uniqueId: string) =>
          uniqueId &&
          !d1Ids.has(uniqueId) &&
          !HistoricalTeams[uniqueId] &&
          (stored || []).find((team: any) => team?.uniqueId === uniqueId)
            ?.isActive !== false,
      );
    if (toDelete.length === 0) return [];

    const result = await this.deleteManyByIds(toDelete);
    console.info(
      `[purgeNonD1] ${league}: deleted ${result.deletedCount ?? 0} non-D1 team(s): ${toDelete.join(', ')}.`,
    );
    return toDelete;
  }

  async updateRecords(updates: { uniqueId: string; record: string }[]) {
    for (const { uniqueId, record } of updates) {
      await this.updateRecord(uniqueId, record);
    }
  }

  /**
   * Number of ACTIVE **regular-season or playoff** games per team, keyed by
   * `uniqueId`. This is what backs the `minGames` filter, so it decides which
   * teams a user may pick as a favorite / Calendar team / Schedule filter.
   *
   * Counting is done on `teamSelectedId` — the team whose upstream feed created
   * the document — and NOT on `homeTeamId`/`awayTeamId`: a match is stored
   * **twice** (one document per participating feed, `uniqueId` prefixed with
   * that team, e.g. `NHL-ANA-…` and `NHL-VGK-…`) and both copies carry the same
   * `homeTeamId`/`awayTeamId`, so counting either of those would double every
   * total. `teamSelectedId` yields exactly one document per team per match.
   *
   * **Preseason games are excluded** (`recordSeasonType: { $ne: 1 }`). Without
   * that, a team appearing only in exhibitions — a franchise that never plays
   * the regular season, or a preseason-only opponent — would reach the
   * threshold on friendlies alone and become selectable as an "official" team.
   * Phases are `1` = preseason, `2` = regular season, `3` = playoffs, written by
   * every provider (ESPN `seasontype`, NHL `gameType`).
   *
   * The exclusion is deliberately a `$ne` rather than an `$in: [2, 3]`, so it
   * only drops games **positively known** to be preseason:
   * - documents stored before `recordSeasonType` was persisted have no phase,
   *   and an `$in` would silently discard them and hide real teams (the same
   *   reasoning as `_propagateTeamRecordToSeasonGames()`, which matches
   *   `{ $in: [2, null] }`);
   * - the PWHL feed does not report a phase at all, so its games must keep
   *   counting rather than dropping every PWHL team.
   * A stale `0` phase is never written, so `$ne: 1` cannot misclassify one.
   *
   * Inactive games (decided series, expired grace period, stale unresolved
   * fixtures) are excluded too, so the count matches what the app actually
   * shows. Teams with no countable game are simply absent from the map.
   *
   * Served from the `{ isActive, teamSelectedId, recordSeasonType }` index
   * (`game.schema.ts`), which covers every field used here, so no game document
   * is read. Memoised for `ACTIVE_GAME_COUNT_CACHE_TTL_MS` — see the constant.
   */
  async countActiveGamesByTeam(): Promise<Map<string, number>> {
    const now = Date.now();
    if (
      this.activeGameCountCache &&
      now - this.activeGameCountCache.timestamp < ACTIVE_GAME_COUNT_CACHE_TTL_MS
    ) {
      return this.activeGameCountCache.counts;
    }

    const rows = (await this.gameModel
      .aggregate<{ _id: string; count: number }>([
        {
          $match: {
            isActive: true,
            // Only games positively identified as preseason are dropped: `$ne`
            // keeps the regular season, the playoffs AND the legacy documents
            // that carry no phase (see the JSDoc above).
            recordSeasonType: { $ne: PRESEASON_RECORD_SEASON_TYPE },
          },
        },
        { $group: { _id: '$teamSelectedId', count: { $sum: 1 } } },
      ])
      .exec()) as Array<{ _id: string; count: number }>;

    const counts = new Map<string, number>();
    for (const row of rows || []) {
      // `teamSelectedId` is `''` on the synthetic placeholder rows built by
      // `findByDateHour()`, and absent on legacy documents: both must not
      // become a phantom "team" in the map.
      if (typeof row?._id === 'string' && row._id.length > 0) {
        counts.set(row._id, row.count ?? 0);
      }
    }

    this.activeGameCountCache = { counts, timestamp: now };
    console.info(
      `[countActiveGamesByTeam] ${counts.size} team(s) with at least one active regular-season/playoff game.`,
    );
    return counts;
  }

  /**
   * Drops the memoised per-team game counts so the next
   * `countActiveGamesByTeam()` re-runs the aggregation. Called by `GameService`
   * after a refresh writes or deletes games.
   */
  clearActiveGameCountCache(): void {
    this.activeGameCountCache = null;
  }

  async findAll(
    leagues?: string[],
    options?: { minGames?: number | string },
  ): Promise<any[]> {
    const minGames = TeamService.normalizeMinGames(options?.minGames);
    const filter: any = {};
    if (leagues && leagues.length > 0) {
      filter.league = { $in: leagues };
    }
    if (minGames > 0) {
      // The game-count threshold only ever builds the SELECTION list, so teams
      // retired from the provider (`isActive === false`: historical franchises,
      // records imported from old games) are dropped here too and can never be
      // picked. `$ne: false` keeps documents written before the field existed
      // (same reasoning as `recordSeasonType: { $ne: 1 }` in the count), and
      // the unfiltered catalog — `GET /teams` with no `minGames` — still
      // returns them: display and opponents must never be filtered.
      filter.isActive = { $ne: false };
    }
    const allTeams = await this.teamModel
      .find(filter)
      .sort({ label: 1 })
      .lean()
      .exec();
    if (!allTeams?.length) {
      // Bootstrap only when no league was requested at all. When the caller DID
      // ask for specific league(s), re-fetching with no argument would return
      // the teams of EVERY league, which then got processed under the single
      // requested `leagueName` (e.g. an NWSL fetch iterating `NCAAMH-BRWN`), and
      // built URLs from a league those teams do not belong to.
      const teams = leagues?.length
        ? await this.getTeams(leagues[0])
        : await this.getTeams();
      const bootstrapTeams = teams.filter(
        (team) => !leagues?.length || leagues.includes(team.league),
      );
      return (await this.filterByMinGames(bootstrapTeams, minGames)).map(
        (team) => this.addRecord(team),
      );
    }

    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    const leaguesToCheck = new Set(allTeams.map((t) => t.league));
    for (const league of leaguesToCheck) {
      const teamsInLeague = allTeams.filter((t) => t.league === league);
      const mostRecentUpdate = teamsInLeague.reduce((max, team) => {
        const d = new Date(team.updateDate || 0);
        return new Date(Math.max(d.getTime(), max.getTime()));
      }, new Date(0));

      if (mostRecentUpdate < lastMonth) {
        console.info(
          `Teams in ${league} are older than 1 month. Refreshing in background...`,
        );
        this.getTeams(league).catch((err) =>
          console.error(`Error refreshing ${league}:`, err),
        );
      }
    }

    if (process.env.NODE_ENV === 'development') {
      await this.generateLeaguesTeamsAndColorsFiles();
    }
    return (await this.filterByMinGames(allTeams, minGames)).map((team) =>
      this.addRecord(team),
    );
  }

  /**
   * Keeps only the teams that may be newly **selected**: at least `minGames`
   * active games AND still active (`isActive !== false` — retired/historical
   * teams are never pickable, whatever their game count).
   *
   * `minGames` comes from `normalizeMinGames()`, so `0` means "no filter" and
   * short-circuits before any aggregation runs — this is what every internal
   * caller of `findAll()` gets, so the game counting costs them nothing. The
   * full catalog returned without `minGames` keeps its inactive teams: they
   * are still needed to display old games and opponent metadata.
   *
   * A team with no game at all is absent from the counts map, which reads as
   * `0` and is therefore filtered out like any team below the threshold.
   *
   * The `isActive` guard covers the bootstrap branch (`getTeams()`), which
   * bypasses the Mongo filter `findAll()` builds above.
   */
  private async filterByMinGames(
    teams: any[],
    minGames: number,
  ): Promise<any[]> {
    if (minGames <= 0 || !teams?.length) return teams;
    const counts = await this.countActiveGamesByTeam();
    return teams.filter(
      (team) =>
        team?.isActive !== false &&
        (counts.get(team?.uniqueId) ?? 0) >= minGames,
    );
  }

  /**
   * Normalizes the `minGames` query parameter into a usable threshold.
   *
   * - `undefined` / `''` / non-numeric / negative → `0` (no filter, the
   *   historical behavior of `GET /teams`).
   * - `'0'` → `0` as well: asking for "at least 0 games" is the unfiltered
   *   list, so there is no point running the aggregation.
   * - `'1.9'` → `1` (the value is truncated, never rounded up, so a fractional
   *   input can never silently raise the threshold).
   */
  private static normalizeMinGames(minGames?: number | string): number {
    const parsed =
      typeof minGames === 'number'
        ? minGames
        : Number.parseInt(String(minGames ?? '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed);
  }

  async findAllLeagues(): Promise<string[]> {
    const allTeams = await this.teamModel.find().exec();
    const leagues = allTeams.map((team) => team.league);
    const uniqueLeagues = Array.from(new Set(leagues));
    return uniqueLeagues.sort((a, b) => a.localeCompare(b));
  }

  async findOne(uniqueId: string) {
    const filter = { uniqueId: uniqueId };
    const team = await this.teamModel.findOne(filter).lean().exec();
    return team ? this.addRecord(team) : null;
  }

  async findByLeague(league: string) {
    const filter = { league: league };
    const teams = await this.teamModel.find(filter).lean().exec();
    return teams.map((team) => this.addRecord(team));
  }

  async update(uniqueId: string, updateTeamDto: UpdateTeamDto) {
    const filter = { uniqueId: uniqueId };
    const res = await this.teamModel.updateOne(filter, updateTeamDto).exec();

    // regenerate the frontend/back mapping files after any update.
    if (process.env.NODE_ENV === 'development') {
      try {
        await this.generateLeaguesTeamsAndColorsFiles();
      } catch (err) {
        console.error('Failed to regenerate league/team files:', err);
      }
    }

    return res;
  }

  async updateRecord(uniqueId: string, record: string) {
    if (!record) return;
    const parts = record.split('-');
    const wins = Number.parseInt(parts[0], 10);
    const losses = Number.parseInt(parts[1], 10);
    const ties = parts[2] ? Number.parseInt(parts[2], 10) : null;

    const updateData: any = {
      wins,
      losses,
      updateDate: new Date().toISOString(),
    };
    if (ties !== null) {
      const league = uniqueId.split('-')[0];
      if (league === League.NHL || league === League.PWHL) {
        updateData.otLosses = ties;
      } else {
        updateData.ties = ties;
      }
    }
    await this.teamModel.updateOne({ uniqueId }, { $set: updateData }).exec();
  }

  /**
   * Resets the current-season tally (`wins` / `losses` / `ties` / `otLosses`) of
   * every team of a league back to zero.
   *
   * Called once a league's season — regular season **and** playoffs — is over
   * (no game started for two months, see `GameService.finalizeFinishedSeasonRecords()`),
   * right after the end-of-season tally has been frozen onto that league's games.
   * Because upcoming games have no per-game record and therefore display
   * `team.record` (the `_enrichGameWithTeamData()` fallback), zeroing it makes the
   * next season's fixtures start from a blank tally again instead of showing the
   * previous season's final record.
   *
   * Returns the number of team documents modified.
   */
  async resetLeagueRecords(league: string): Promise<number> {
    const res = await this.teamModel
      .updateMany(
        { league },
        { $set: { wins: 0, losses: 0, ties: 0, otLosses: 0 } },
      )
      .exec();
    return (res as any)?.modifiedCount ?? 0;
  }

  private addRecord(team: any) {
    const ties = team.otLosses ?? team.ties;
    const record = `${team.wins ?? 0}-${team.losses ?? 0}${
      ties !== undefined && ties !== null ? '-' + ties : ''
    }`;
    return { ...team, record };
  }

  async remove(uniqueId: string) {
    const filter = { uniqueId: uniqueId };
    const deleted = await this.teamModel.findOneAndDelete(filter).exec();
    return deleted;
  }

  /**
   * Age threshold (in days) before a team without any game can be purged.
   * Fixed at 60 days (~2 months).
   */
  private readonly staleTeamMaxAgeDays = 60;

  /**
   * Returns purge candidates: teams whose `updateDate` is older than 2 months
   * (or missing/empty) and still considered active.
   *
   * - `updateDate` is refreshed on every monthly `getTeams()`, so a team no
   *   longer returned by the provider (renamed, removed, defunct) becomes
   *   stale after ~2 months.
   * - `HistoricalTeams` entries and `isActive === false` teams are excluded:
   *   they are already handled (soft-delete, oldies display fallback) and must
   *   never be physically deleted.
   */
  async findStaleTeamCandidates(): Promise<any[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.staleTeamMaxAgeDays);
    const cutoffIso = cutoff.toISOString();

    const stale = await this.teamModel
      .find({
        isActive: { $ne: false },
        $or: [
          { updateDate: { $lt: cutoffIso } },
          { updateDate: { $exists: false } },
          { updateDate: null },
          { updateDate: '' },
        ],
      })
      .lean()
      .exec();

    return (stale || []).filter(
      (team: any) => team?.uniqueId && !HistoricalTeams[team.uniqueId],
    );
  }

  /**
   * Deletes stale candidates (see `findStaleTeamCandidates`) that are not
   * referenced by any active game (`usedTeamIds` is provided by `GameService`).
   */
  async purgeStaleTeamsWithoutGames(
    usedTeamIds: string[] | Set<string>,
  ): Promise<{
    action: 'purged' | 'none';
    candidates: number;
    deletedCount: number;
    deletedIds: string[];
  }> {
    const used =
      usedTeamIds instanceof Set ? usedTeamIds : new Set(usedTeamIds ?? []);
    const candidates = await this.findStaleTeamCandidates();
    const toDelete = candidates.filter((team: any) => !used.has(team.uniqueId));

    const deletedIds = toDelete.map((team: any) => team.uniqueId);
    console.info(
      `[purgeStaleTeams] ${candidates.length} stale candidate(s), ${toDelete.length} without active games to delete.`,
    );

    if (toDelete.length === 0) {
      return {
        action: 'none',
        candidates: candidates.length,
        deletedCount: 0,
        deletedIds,
      };
    }

    const result = await this.deleteManyByIds(deletedIds);
    console.info(
      `[purgeStaleTeams] Deleted ${result.deletedCount} stale team(s) without active games: ${deletedIds.join(', ')}.`,
    );
    return {
      action: 'purged',
      candidates: candidates.length,
      deletedCount: result.deletedCount ?? 0,
      deletedIds,
    };
  }

  async deleteManyByIds(ids: string[]): Promise<DeleteResult> {
    if (!ids || ids.length === 0) {
      return { acknowledged: true, deletedCount: 0 };
    }

    // Only include the `_id` (Mongo ObjectId) branch for ids that are actually valid
    // 24-char hex ObjectIds. Passing plain strings like "PWHL-DET" into $in on the
    // `_id` field makes Mongoose throw a CastError ("Cast to ObjectId failed ... at
    // path \"_id\""). The textual key is handled by `uniqueId` below.
    const validObjectIds = ids.filter(
      (id) => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id),
    );

    const conditions: Array<Record<string, unknown>> = [
      { uniqueId: { $in: ids } },
    ];
    if (validObjectIds.length > 0) {
      conditions.push({ _id: { $in: validObjectIds } });
    }

    return this.teamModel.deleteMany({ $or: conditions }).exec();
  }

  async removeByLeague(league: string): Promise<DeleteResult> {
    const filter = { league: league };
    console.log(`Removing teams with league: ${league}`);
    const deleted = await this.teamModel.deleteMany(filter).exec();
    console.log(`Removed ${deleted.deletedCount} teams`);
    return deleted;
  }

  async removeAll(): Promise<DeleteResult> {
    return this.teamModel.deleteMany({}).exec();
  }

  async countByLeague(league: string): Promise<number> {
    return this.teamModel.countDocuments({ league }).exec();
  }

  async countAllTeams(): Promise<number> {
    return this.teamModel.countDocuments({}).exec();
  }

  private async readExistingFile(relPath: string): Promise<string> {
    const p = path.join(process.cwd(), relPath);
    try {
      return await fs.promises.readFile(p, 'utf8');
    } catch {
      return '';
    }
  }

  private parseExistingColorBlocks(
    content: string,
  ): Map<string, { color: string; backgroundColor: string }> {
    const map = new Map<string, { color: string; backgroundColor: string }>();
    if (!content) return map;

    const re =
      /['"]([^'"]+)['"]\s*:\s*\{\s*color\s*:\s*['"]([^'"]*)['"]\s*,\s*backgroundColor\s*:\s*['"]([^'"]*)['"]\s*,?\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      map.set(m[1], { color: m[2], backgroundColor: m[3] });
    }
    return map;
  }

  private parseExistingLogoBlocks(content: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!content) return map;

    const re = /['"]([^'"]+)['"]\s*:\s*['"]((?:[^'\\]|\\.)*)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      map.set(m[1], m[2]);
    }
    return map;
  }

  private teamColorLuminance(hex: string): number {
    let h = hex.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(h)) {
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return NaN;
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const linear = (c: number) =>
      c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  }

  private mergeColorsContent(
    existingContent: string,
    newEntries: Array<{
      uniqueId: string;
      color?: string;
      backgroundColor?: string;
    }>,
  ): string {
    const map = this.parseExistingColorBlocks(existingContent);

    for (const item of newEntries) {
      // Placeholder = the exact default PAIR (`#ffffff` on `#000000`),
      // a degenerate pair (both sides identical), or two empty sides —
      // all mean "no information". A lone `#000000` (or lone `#ffffff`)
      // next to a real color CAN be a genuine team color (e.g. Boston gold
      // on black), so only the full default pair — or two empty sides —
      // means "no information" for a NEW team.
      const normSide = (side?: string): string =>
        !!side && side.trim().length > 0 ? side.trim().toLowerCase() : '';
      const isMissingSide = (side?: string): boolean => {
        const n = normSide(side);
        return n === '' || n === '#null' || n === 'null';
      };
      const isNonEmptySide = (side?: string): boolean => !isMissingSide(side);
      const isDefaultPair = (color?: string, bg?: string): boolean => {
        if (!isNonEmptySide(color) && !isNonEmptySide(bg)) return true;
        if (!isNonEmptySide(color) || !isNonEmptySide(bg)) return false;
        return (
          color!.trim().toLowerCase() === '#ffffff' &&
          bg!.trim().toLowerCase() === '#000000'
        );
      };
      const newColorRaw = isNonEmptySide(item.color) ? item.color!.trim() : '';
      const newBackgroundRaw = isNonEmptySide(item.backgroundColor)
        ? item.backgroundColor!.trim()
        : '';
      const generatedColorsArePlaceholder = isDefaultPair(
        newColorRaw || undefined,
        newBackgroundRaw || undefined,
      );
      // NOTE: `isDefaultPair` requires both sides non-empty for the exact
      // comparison, so pass the raw stored values ('' when missing).
      const existingColors = map.get(item.uniqueId);
      const existingColorRaw = existingColors?.color?.trim() ?? '';
      const existingBackgroundRaw =
        existingColors?.backgroundColor?.trim() ?? '';
      const existingColorsArePlaceholder =
        !existingColors ||
        (!existingColorRaw && !existingBackgroundRaw) ||
        (existingColorRaw.toLowerCase() === '#ffffff' &&
          existingBackgroundRaw.toLowerCase() === '#000000');

      if (generatedColorsArePlaceholder && !existingColorsArePlaceholder) {
        continue;
      }

      // Positional defaults must never overwrite a real stored side: an
      // incoming '#ffffff' color (resp. '#000000' background) next to a
      // stored non-default side is the "no information" marker, not a
      // genuine team color — keep the stored side. Symmetrically, a
      // '#ffffff' background (the default *foreground* value showing up in
      // the background slot) or a '#000000' color (default *background*
      // value in the color slot — the fetch pipeline always swaps the
      // darkest side to the background, so a genuine '#000000' foreground
      // never survives it) is also "no information": ESPN emits those when
      // it only knows one of the two colors. A lone '#000000' background
      // or '#ffffff' color next to a real color CAN still be genuine
      // (Boston gold on black), so only these "no information" markers are
      // filtered, and only when a real stored side exists to preserve.
      let newColorEff = newColorRaw;
      let newBackgroundEff = newBackgroundRaw;
      if (
        normSide(newColorEff) === '#ffffff' &&
        normSide(existingColorRaw) !== '' &&
        normSide(existingColorRaw) !== '#ffffff'
      ) {
        newColorEff = '';
      }
      if (
        normSide(newColorEff) === '#000000' &&
        normSide(existingColorRaw) !== '' &&
        normSide(existingColorRaw) !== '#000000'
      ) {
        newColorEff = '';
      }
      if (
        // Only strip a '#000000' background when the stored color is not
        // pure black too — otherwise ESPN's "background known, color
        // unknown" marker would wipe a genuine black background that the
        // caller explicitly sent (e.g. updating BOS to gold on black).
        normSide(newBackgroundEff) === '#000000' &&
        normSide(existingColorRaw) !== '#000000' &&
        normSide(existingColorRaw) !== '' &&
        normSide(existingBackgroundRaw) !== '#000000'
      ) {
        newBackgroundEff = '';
      }
      if (
        normSide(newBackgroundEff) === '#ffffff' &&
        normSide(existingBackgroundRaw) !== '' &&
        normSide(existingBackgroundRaw) !== '#ffffff'
      ) {
        newBackgroundEff = '';
      }

      // Merge per side: a non-empty incoming side wins (even `#000000` /
      // `#ffffff` — next to a real color they can be genuine team colors,
      // e.g. Boston gold on black); a missing side keeps the stored value.
      // Only the exact default pair is ever treated as "no information".
      let color = newColorEff || existingColorRaw;
      let backgroundColor = newBackgroundEff || existingBackgroundRaw;

      // Never write the default placeholder: fill a still-empty side from
      // the other side of the pair when possible.
      if (!color && backgroundColor) color = backgroundColor;
      if (!backgroundColor && color) backgroundColor = color;
      if (!color && !backgroundColor) {
        if (existingColors) continue;
        color = '#ffffff';
        backgroundColor = '#000000';
      }

      // Darkest side is always the background.
      const colorLum = this.teamColorLuminance(color);
      const backgroundLum = this.teamColorLuminance(backgroundColor);
      if (
        Number.isFinite(colorLum) &&
        Number.isFinite(backgroundLum) &&
        colorLum < backgroundLum
      ) {
        [color, backgroundColor] = [backgroundColor, color];
      }

      map.set(item.uniqueId, { color, backgroundColor });
    }

    const sortedKeys = Array.from(map.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
    const blocks = sortedKeys.map((key) => {
      const val = map.get(key)!;
      return `  '${key}': {\n    color: '${val.color}',\n    backgroundColor: '${val.backgroundColor}',\n  },`;
    });

    return blocks.join('\n');
  }

  private mergeLogosContent(
    existingContent: string,
    newEntries: Map<string, string>,
  ): string {
    const map = this.parseExistingLogoBlocks(existingContent);

    for (const [id, newLogo] of newEntries.entries()) {
      const existingLogo = map.get(id);
      if (newLogo || !existingLogo) {
        map.set(id, newLogo);
      }
    }

    const sortedKeys = Array.from(map.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
    const blocks = sortedKeys.map((id) => {
      const logo = map.get(id) || '';
      return `  '${id}': '${logo}',`;
    });

    return blocks.join('\n');
  }

  private async generateLeaguesTeamsAndColorsFiles() {
    try {
      // --- 1. Enums Leagues & Teams ---
      const AllLeagues = await this.findAllLeagues();
      const leaguesLines = AllLeagues.map(
        (league) => `  '${league}': '${league}',`,
      );
      const leaguesFileContent = `export const LeaguesEnum: Record<string, string> = {\n${leaguesLines.join(
        '\n',
      )}\n};\n`;
      await fs.promises.writeFile(
        path.join(process.cwd(), '../frontend/constants/Leagues.tsx'),
        leaguesFileContent,
      );

      const allTeams = await this.teamModel
        .find()
        .sort({ uniqueId: 1 })
        .lean()
        .exec();
      // Never expose inactive/historical teams in the frontend selection
      // file: only active teams appear in Teams.tsx (filters / favorites).
      const visibleTeams = allTeams.filter(
        (team: any) =>
          team.isActive !== false && !HistoricalTeams[team.uniqueId],
      );
      const lines = visibleTeams.map(
        (team) => `  '${team.uniqueId}': '${team.label.replace(/'/g, "\\'")}',`,
      );
      const fileContent = `export const TeamsEnum: Record<string, string> = {\n${lines.join(
        '\n',
      )}\n};\n`;
      await fs.promises.writeFile(
        path.join(process.cwd(), '../frontend/constants/Teams.tsx'),
        fileContent,
      );

      // --- 2. ColorsTeam (Front & Back) ---
      const colorEntries = allTeams.map((team: any) => ({
        uniqueId: team.uniqueId,
        color: team.color,
        backgroundColor: team.backgroundColor,
      }));

      // Front
      const colorsPathFront = path.join(
        process.cwd(),
        '../frontend/constants/ColorsTeam.tsx',
      );
      const existingColorsFront = await this.readExistingFile(
        '../frontend/constants/ColorsTeam.tsx',
      );
      const mergedColorsFront = this.mergeColorsContent(
        existingColorsFront,
        colorEntries,
      );
      await fs.promises.writeFile(
        colorsPathFront,
        `export const ColorsTeamEnum: Record<string, { color: string; backgroundColor: string }> = {\n${mergedColorsFront}\n};\n`,
      );

      // Back
      const colorsPathBack = path.join(
        process.cwd(),
        'src/utils/ColorsTeam.ts',
      );
      const existingColorsBack = await this.readExistingFile(
        'src/utils/ColorsTeam.ts',
      );
      const mergedColorsBack = this.mergeColorsContent(
        existingColorsBack,
        colorEntries,
      );
      await fs.promises.writeFile(
        colorsPathBack,
        `export const ColorsTeamEnum: Record<string, { color: string; backgroundColor: string }> = {\n${mergedColorsBack}\n};\n`,
      );

      // --- 3. UniversityLogos (Front & Back) ---
      const logoMap = new Map<string, string>();
      allTeams
        .filter((team: any) =>
          Object.values(CollegeLeague).includes(team.league),
        )
        .forEach((team: any) => {
          const parts = team.uniqueId ? team.uniqueId.split('-') : [];
          let id = parts.length > 1 ? parts[1] : team.abbrev || '';
          id = id.trim().toUpperCase();
          if (!id) return;

          const logo = team.teamLogo || '';
          if (!logoMap.has(id) || logo) {
            logoMap.set(id, logo);
          }
        });

      // Front
      const logosPathFront = path.join(
        process.cwd(),
        '../frontend/constants/UniversityLogos.tsx',
      );
      const existingLogosFront = await this.readExistingFile(
        '../frontend/constants/UniversityLogos.tsx',
      );
      const mergedLogosFront = this.mergeLogosContent(
        existingLogosFront,
        logoMap,
      );
      await fs.promises.writeFile(
        logosPathFront,
        `export const UniversityLogos: Record<string, string> = {\n${mergedLogosFront}\n};\n`,
      );

      // Back
      const logosPathBack = path.join(
        process.cwd(),
        'src/utils/UniversityLogos.ts',
      );
      const existingLogosBack = await this.readExistingFile(
        'src/utils/UniversityLogos.ts',
      );
      const mergedLogosBack = this.mergeLogosContent(
        existingLogosBack,
        logoMap,
      );
      await fs.promises.writeFile(
        logosPathBack,
        `export const UniversityLogos: Record<string, string> = {\n${mergedLogosBack}\n};\n`,
      );
    } catch (error) {
      console.error(
        'Error generating TeamsEnum or ColorsTeamEnum file:',
        error,
      );
    }
  }
}
