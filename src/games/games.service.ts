import { HttpException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DeleteResult } from 'mongodb';
import * as mongoose from 'mongoose';
import { Model } from 'mongoose';
import { TeamService } from '../teams/teams.service';
import { addHours, readableDate } from '../utils/date';
import {
  getTeamColors,
  isDefaultTeamColors,
  isDegenerateTeamColors,
} from '../utils/Colors';
import { CollegeLeague, League } from '../utils/enum';
import {
  getESPNGameScore,
  getESPNScores,
  getTeamsSchedule,
} from '../utils/fetchData/espnAllData';
import { HockeyData } from '../utils/fetchData/hockeyData';
import { HistoricalTeams } from '../utils/HistoricalTeams';
import { TeamType } from '../utils/interface/team';
import { UniversityLogos } from '../utils/UniversityLogos';
import {
  doesDateRangeOverlapLeaguePeriod,
  isCurrentSeason,
  isPlayoffsPeriod,
  needRefresh,
} from '../utils/utils';
import { CreateGameDto } from './dto/create-game.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { RefreshTimestampService } from './refresh-timestamps.service';
import { Game } from './schemas/game.schema';

@Injectable()
export class GameService {
  private isFetchingGames: { [league: string]: boolean } = {};
  private manualRefreshInProgress: { [league: string]: boolean } = {};
  private isFetchingScores: boolean = false;
  private isCheckingAvailability: boolean = false;
  constructor(
    @InjectModel(Game.name) public gameModel: Model<Game>,
    private readonly teamService: TeamService,
    private readonly refreshTimestampService: RefreshTimestampService,
  ) {}

  maxYearBeforeDelete = 10;
  // Purge games that are still active/resolved-less several months after their start
  // (e.g. a PWHL game stuck on 2026-05-11 whose final result can never be fetched).
  staleGameMaxAgeDays = 90;

  // Grace period before a *future* game that disappears from the external source (e.g. a
  // playoff game 5/6/7 that is "if necessary") is deactivated. Prevents flicker when the
  // source data is transient: the game is marked `missingSince` and only deactivated after
  // it has been continuously missing for this many hours (default 48h, ~2 daily refresh cycles).
  gracePeriodHours = 48;

  // Capacity-based purge configuration
  private readonly DISK_USAGE_THRESHOLD = 0.9; // 90%
  private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly DISK_USAGE_CACHE_TTL_MS = 60 * 1000; // 60 seconds cache for disk usage stats
  private readonly CLUSTER_TOTAL_MB = 512; // Total cluster storage in MB (adjust to your Atlas plan)
  private lastDiskCheck = 0;

  // In-memory cache for disk usage to avoid spamming dbStats on every call
  private diskUsageCache: {
    data: { usedMB: number; totalMB: number; percentage: number };
    timestamp: number;
  } | null = null;

  getTeams = (teamSelectedIds, games) => {
    if (teamSelectedIds) {
      return teamSelectedIds.split(',');
    }
    return games.reduce((accumulator, currentItem) => {
      if (!accumulator.includes(currentItem.teamSelectedId)) {
        accumulator.push(currentItem.teamSelectedId);
      }
      return accumulator;
    }, []);
  };

  async getTeamsLogo(teams: TeamType[]): Promise<{ [key: string]: string }> {
    const logos: { [key: string]: string } = {};
    for (const { abbrev, teamLogo } of teams) {
      logos[abbrev] = teamLogo || UniversityLogos[abbrev] || '';
    }

    return logos;
  }

  /**
   * Resolves a team's display colors. Stored colors are kept as-is unless they
   * are the generic placeholder (`#ffffff` on `#000000`): in that case the
   * shared resolver borrows the colors of the same university in another
   * college league (non-college leagues simply keep the default placeholder).
   */
  private _resolveTeamColors(
    team: any,
    fallbackUniqueId?: string,
  ): { color?: string; backgroundColor?: string } {
    const storedColors = {
      color: team?.color,
      backgroundColor: team?.backgroundColor,
    };

    if (
      !isDefaultTeamColors(storedColors) &&
      !isDegenerateTeamColors(storedColors)
    ) {
      return storedColors;
    }

    const uniqueId = team?.uniqueId ?? fallbackUniqueId;
    return uniqueId ? getTeamColors(uniqueId) : storedColors;
  }

  private _enrichGameWithTeamData(game: any, teamsMap: Map<string, TeamType>) {
    // Fallback to the static `HistoricalTeams` file for teams that
    // disappeared/moved/renamed and are missing from the database (old games).
    const homeTeam =
      teamsMap.get(game.homeTeamId) ?? HistoricalTeams[game.homeTeamId];
    const awayTeam =
      teamsMap.get(game.awayTeamId) ?? HistoricalTeams[game.awayTeamId];
    const isPlayoffs =
      (game.seriesSummary || game.seriesStatus) &&
      !game.seriesSummary?.toLowerCase().includes('regular season');

    const homeTeamColors = this._resolveTeamColors(homeTeam, game.homeTeamId);
    const awayTeamColors = this._resolveTeamColors(awayTeam, game.awayTeamId);

    return {
      ...game,
      homeTeamRecord:
        (isPlayoffs ? game.seriesSummary : null) ||
        game.homeTeamRecord ||
        homeTeam?.record ||
        '',
      awayTeamRecord:
        (isPlayoffs ? game.seriesStatus || game.seriesSummary : null) ||
        game.awayTeamRecord ||
        awayTeam?.record ||
        '',
      homeTeam: homeTeam?.label || game.homeTeam,
      homeTeamShort: homeTeam?.abbrev || game.homeTeamShort,
      homeTeamLogo:
        homeTeam?.teamLogo ||
        game.homeTeamLogo ||
        UniversityLogos[homeTeam?.abbrev || game.homeTeamShort || ''] ||
        '',
      homeTeamLogoDark:
        homeTeam?.teamLogoDark ||
        game.homeTeamLogoDark ||
        UniversityLogos[homeTeam?.abbrev || game.homeTeamShort || ''] ||
        '',
      homeTeamColor: homeTeamColors.color,
      homeTeamBackgroundColor: homeTeamColors.backgroundColor,
      awayTeam: awayTeam?.label || game.awayTeam,
      awayTeamShort: awayTeam?.abbrev || game.awayTeamShort,
      awayTeamLogo: awayTeam?.teamLogo || game.awayTeamLogo,
      awayTeamLogoDark: awayTeam?.teamLogoDark || game.awayTeamLogoDark,
      awayTeamColor: awayTeamColors.color,
      awayTeamBackgroundColor: awayTeamColors.backgroundColor,
    };
  }

  async create(gameDto: CreateGameDto | UpdateGameDto): Promise<Game> {
    return this.executeWithCapacityGuard(async () => {
      const { uniqueId } = gameDto;

      if (uniqueId) {
        const existingGame = await this.findOne(uniqueId);
        if (existingGame) {
          if (
            gameDto.homeTeamScore === null &&
            existingGame.homeTeamScore !== null
          ) {
            delete gameDto.homeTeamScore;
          }

          if (
            gameDto.awayTeamScore === null &&
            existingGame.awayTeamScore !== null
          ) {
            delete gameDto.awayTeamScore;
          }

          // Protect game status and live info from being overwritten by null/default values
          const fieldsToProtect = ['gameStatus', 'gameClock', 'gamePeriod'];

          fieldsToProtect.forEach((field) => {
            if (
              (gameDto[field] === null || gameDto[field] === undefined) &&
              existingGame[field] !== null
            ) {
              delete gameDto[field];
            }
          });

          Object.assign(existingGame, gameDto);

          return await existingGame.save();
        }
      }

      const newGame = new this.gameModel(gameDto);
      return await newGame.save();
    }, 'create');
  }

  /**
   * Fetch a league's games for a given season (or current when no season) and
   * return them flattened + deduplicated by `uniqueId`, WITHOUT persisting them.
   * Used by `getLeagueGames` (which saves) and by the "dry run" season counting
   * for the oldies cron job.
   */
  private async _fetchUniqueGames(normalizedLeague: string, season?: number) {
    const leagueTeams = await this.teamService.findAll([normalizedLeague]);
    const leagueLogos = await this.getTeamsLogo(leagueTeams);

    let gamesObj = {};
    if (normalizedLeague === League.PWHL) {
      const hockeyData = new HockeyData();
      gamesObj = await hockeyData.getHockeySchedule(
        leagueTeams,
        leagueLogos,
        normalizedLeague,
        true,
        season,
      );
    } else {
      gamesObj = await getTeamsSchedule(
        leagueTeams,
        normalizedLeague,
        leagueLogos,
        true,
        season,
      );
    }

    const games = Object.values(gamesObj).flat() as any[];
    const uniqueGamesMap = new Map<string, any>();

    for (const game of games) {
      if (!game) continue;

      // 1. Fallback unique key if uniqueId is missing from the API response
      const fallbackKey = `${game.homeTeamId || game.homeTeam}-${game.awayTeamId || game.awayTeam}-${game.startTimeUTC || game.gameDate}`;
      const uniqueKey = game.uniqueId || fallbackKey;

      if (uniqueGamesMap.has(uniqueKey)) {
        const existingGame = uniqueGamesMap.get(uniqueKey);

        // Check if the already stored game has populated scores
        const existingHasScore =
          existingGame.homeTeamScore !== null &&
          existingGame.homeTeamScore !== undefined &&
          existingGame.awayTeamScore !== null &&
          existingGame.awayTeamScore !== undefined;

        const newHasScore =
          game.homeTeamScore !== null &&
          game.homeTeamScore !== undefined &&
          game.awayTeamScore !== null &&
          game.awayTeamScore !== undefined;

        // 2. Overwrite only if the new game record contains scores while the existing one does not
        if (!existingHasScore && newHasScore) {
          uniqueGamesMap.set(uniqueKey, game);
        }
        // Otherwise, retain the existing entry
      } else {
        uniqueGamesMap.set(uniqueKey, game);
      }
    }

    return Array.from(uniqueGamesMap.values());
  }

  /**
   * Compares the number of games the API would produce for a league+season
   * (dry run, nothing saved) against how many of those are already in the DB.
   * Returns `complete = true` when both counts match.
   *
   * Only meaningful for seasons BEFORE the current one: a current (or upcoming)
   * season is still in progress, so a partial DB is expected and should not be
   * treated as "missing". `isCurrentSeason` reflects that.
   */
  async getSeasonStatus(league: string, season?: number) {
    const normalizedLeague = league.toUpperCase().trim();

    // The PWHL debuted in 2024: prior years are a no-op (0 expected games).
    if (normalizedLeague === League.PWHL && season && season < 2024) {
      return {
        league: normalizedLeague,
        season,
        obtained: 0,
        stored: 0,
        complete: true,
        isCurrentSeason: false,
      };
    }

    const isCurrent =
      !season ||
      (await isCurrentSeason(normalizedLeague, new Date(`${season}-06-30`)));

    const obtainedGames = await this._fetchUniqueGames(
      normalizedLeague,
      season,
    );
    const uniqueIds = obtainedGames.map((g) => g.uniqueId);

    let stored = 0;
    if (uniqueIds.length > 0) {
      stored = await this.gameModel.countDocuments({
        league: normalizedLeague,
        uniqueId: { $in: uniqueIds },
      });
    }

    // For the current season, do not treat a partial DB as "incomplete".
    const complete = isCurrent ? true : uniqueIds.length === stored;

    return {
      league: normalizedLeague,
      season,
      obtained: uniqueIds.length,
      stored,
      complete,
      isCurrentSeason: isCurrent,
    };
  }

  async getLeagueGames(params): Promise<any> {
    const {
      league,
      forceUpdate = false,
      skipCascade = true,
      maxRecall = 3,
      startDate,
      endDate,
      season,
      addMissingOnly = false,
    } = params;
    const normalizedLeague = league.toUpperCase().trim();
    if (this.isFetchingGames[normalizedLeague]) {
      console.info(
        `getLeagueGames is already running for league ${normalizedLeague}.`,
      );
      return;
    }

    try {
      this.isFetchingGames[normalizedLeague] = true;
      if (skipCascade) {
        this.manualRefreshInProgress[normalizedLeague] = true;
      }

      // If a manual refresh is in progress for a different league, skip this refresh
      const otherManualRefresh = Object.keys(this.manualRefreshInProgress).some(
        (k) => this.manualRefreshInProgress[k] && k !== normalizedLeague,
      );
      if (otherManualRefresh) {
        console.info(
          `Skipping getLeagueGames for ${league} because another manual refresh is in progress.`,
        );
        return;
      }

      // The PWHL debuted in 2024 : there is nothing to recover for earlier
      // seasons. Early-return so earlier years are a no-op for this league.
      if (normalizedLeague === League.PWHL && season && season < 2024) {
        console.info(
          `Skipping PWHL refresh for season ${season} because the PWHL did not exist before 2024.`,
        );
        return;
      }

      const now = new Date();

      if (startDate && endDate) {
        const overlaps = await doesDateRangeOverlapLeaguePeriod(
          normalizedLeague,
          startDate,
          endDate,
        );
        if (!overlaps) {
          console.info(
            `Skipping refresh for ${normalizedLeague} because the requested range does not overlap the season or playoffs.`,
          );
          return;
        }
      }

      // Bypass freshness check if a specific past season is requested
      if (!forceUpdate && !season) {
        const lastRefresh =
          await this.refreshTimestampService.getLastRefresh(normalizedLeague);
        if (lastRefresh) {
          const lastUpdate = lastRefresh.timestamp;
          const oneHoursAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);
          if (lastUpdate > oneHoursAgo) {
            return; // Skip silently, this is normal behavior
          }
        }

        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);

        let gamesForLeague = await this.gameModel
          .find({
            league: normalizedLeague,
            isActive: true,
            gameDate: {
              $gte: readableDate(now),
              $lte: readableDate(nextWeek),
            },
          })
          .sort({ startTimeUTC: -1 })
          .limit(2)
          .lean()
          .exec();

        if (gamesForLeague.length === 0) {
          gamesForLeague = await this.gameModel
            .find({ league: normalizedLeague, isActive: true })
            .sort({ startTimeUTC: -1 })
            .limit(2)
            .lean()
            .exec();
        }

        if (
          gamesForLeague.length > 0 &&
          !(await needRefresh(normalizedLeague, { data: gamesForLeague }))
        ) {
          return; // Skip silently, data is fresh
        }
      }

      if (forceUpdate && !season) {
        const todayTimestamps =
          await this.refreshTimestampService.getTodayManualTimestamps(
            normalizedLeague,
          );
        if (todayTimestamps.length >= maxRecall) {
          throw new HttpException(
            `Refresh for league ${normalizedLeague} is limited to ${maxRecall} times per day.`,
            249,
          );
        }
      }

      console.info(
        `Data for ${normalizedLeague} is stale. Refreshing in background...`,
      );

      // Add current timestamp (only if not a historical season bulk fetch)
      if (!season) {
        await this.refreshTimestampService.addTimestamp(
          normalizedLeague,
          forceUpdate ? 'manual' : 'auto',
        );
      }

      const todayStr = readableDate(now);
      // Only deactivate future games (done AFTER the fetch but: never blank the league on a crash.)
      // (Details in the safe-replace guard below,the fetch, and empty-fetch guard.)

      // Fetch teams and logos for the league, then fetch + deduplicate the
      // season's games (same pipeline used by getSeasonStatus, without saving).
      const uniqueGames = await this._fetchUniqueGames(
        normalizedLeague,
        season,
      );
      const games = uniqueGames;
      // Only deactivate future games if we are not fetching an old season, and only the
      // ones that are absent from the freshly fetched season. This turns the previous
      // "deactivate everything, then rewrite" into a safe "replace" that cannot lose the
      // league's upcoming games if the process dies before saving (see empty fetch guard above).
      // A fetch returning 0 games never triggers a deactivation (guard below).
      if (!season && uniqueGames && uniqueGames.length > 0) {
        const freshIds = new Set(
          uniqueGames.map((g: any) => g?.uniqueId).filter((id: any) => !!id),
        );

        if (freshIds.size > 0) {
          const existingFuture = (await this.gameModel
            .find(
              {
                league: normalizedLeague,
                gameDate: { $gte: todayStr },
                isActive: true,
                startTimeUTC: { $gt: now.toISOString() },
              },
              { uniqueId: 1, missingSince: 1, _id: 0 },
            )
            .lean()
            .exec()) as Array<{ uniqueId?: string; missingSince?: string }>;

          const graceMs = this.gracePeriodHours * 60 * 60 * 1000;
          const nowIso = now.toISOString();
          const nowMs = now.getTime();

          const toMarkMissing: string[] = [];
          const toDeactivate: string[] = [];
          const toConfirm: string[] = [];

          for (const g of existingFuture) {
            const id = g.uniqueId;
            if (!id) continue;

            if (freshIds.has(id)) {
              // Game is back in the source data: clear any pending grace marker.
              if (g.missingSince) toConfirm.push(id);
              continue;
            }

            // Game absent from the freshly fetched source.
            if (!g.missingSince) {
              // First time it is seen missing: start the grace period, keep it active.
              toMarkMissing.push(id);
            } else {
              const missingMs = new Date(g.missingSince).getTime();
              if (!Number.isFinite(missingMs) || nowMs - missingMs >= graceMs) {
                toDeactivate.push(id);
              }
              // else: still within the grace period, leave it active (no flicker).
            }
          }

          if (toMarkMissing.length > 0) {
            await this.gameModel.updateMany(
              {
                league: normalizedLeague,
                uniqueId: { $in: toMarkMissing },
                isActive: true,
                startTimeUTC: { $gt: nowIso },
              },
              { $set: { missingSince: nowIso } },
            );
            console.info(
              `[Games] ${toMarkMissing.length} future game(s) missing from source for ${normalizedLeague}; grace period started (kept active pending confirmation).`,
            );
          }

          if (toDeactivate.length > 0) {
            await this.gameModel.updateMany(
              {
                league: normalizedLeague,
                uniqueId: { $in: toDeactivate },
                isActive: true,
                startTimeUTC: { $gt: nowIso },
              },
              { $set: { isActive: false }, $unset: { missingSince: 1 } },
            );
            console.info(
              `[Games] Deactivated ${toDeactivate.length} future game(s) for ${normalizedLeague} missing from source for more than ${this.gracePeriodHours}h.`,
            );
          }

          if (toConfirm.length > 0) {
            await this.gameModel.updateMany(
              {
                league: normalizedLeague,
                uniqueId: { $in: toConfirm },
              },
              { $unset: { missingSince: 1 } },
            );
            console.info(
              `[Games] ${toConfirm.length} future game(s) for ${normalizedLeague} reappeared in source; grace marker cleared.`,
            );
          }
        }
      }
      if (uniqueGames && uniqueGames.length > 0) {
        // Oldies recovery: only ever add missing games without overwriting an existing match.
        // A game is considered "already present" (same game) only when its uniqueId matches
        // AND both the home and the away scores match the stored ones.
        // Otherwise we refresh it with the fresh (more complete) data.
        const existingResults = new Map<
          string,
          { homeTeamScore?: number; awayTeamScore?: number }
        >();
        if (addMissingOnly) {
          const ids = uniqueGames.map((g) => g?.uniqueId).filter((id) => !!id);
          if (ids.length > 0) {
            const existing = await this.gameModel
              .find(
                { uniqueId: { $in: ids } },
                { uniqueId: 1, homeTeamScore: 1, awayTeamScore: 1, _id: 0 },
              )
              .lean()
              .exec();
            for (const g of existing) {
              existingResults.set(g?.uniqueId, {
                homeTeamScore: g?.homeTeamScore,
                awayTeamScore: g?.awayTeamScore,
              });
            }
          }
        }

        let added = 0;
        let skippedExisting = 0;
        let skippedMissingTeamData = 0;
        const totalToProcess = uniqueGames.length;
        let lastInsertMilestone = 0;
        const logInsertProgress = (processed: number) => {
          if (!addMissingOnly || totalToProcess === 0) return;
          const pct = Math.round((processed / totalToProcess) * 100);
          if (pct >= lastInsertMilestone + 20 || processed === totalToProcess) {
            lastInsertMilestone = Math.floor(pct / 20) * 20;
            console.info(
              `[Oldies] ${normalizedLeague} ${season ? `(season ${season})` : ''}: insert progress: ${pct}% (${processed}/${totalToProcess}) — added ${added}`,
            );
          }
        };
        for (let idx = 0; idx < uniqueGames.length; idx++) {
          const game = uniqueGames[idx];
          game.updateDate = new Date().toISOString();
          game.isActive = true;

          if (addMissingOnly) {
            // Treat as "already present" only ifthe stored game has the same result
            // (id AND home/away scores). Otherwise we refresh it with the fresh data.
            const stored = game?.uniqueId
              ? existingResults.get(game?.uniqueId)
              : undefined;
            const sameResult =
              stored &&
              (stored.homeTeamScore ?? null) ===
                (game?.homeTeamScore ?? null) &&
              (stored.awayTeamScore ?? null) === (game?.awayTeamScore ?? null);
            if (game?.uniqueId && sameResult) {
              skippedExisting++;
              logInsertProgress(idx + 1);
              continue;
            }

            // Oldies recovery: require home/away teams.
            // Scores can be null for past games (cron will fill them later);
            // future scheduled games are skipped (to avoid polluting oldies with scheduling).
            const hasHomeTeam =
              game?.homeTeamId || game?.homeTeamShort || game?.homeTeam;
            const hasAwayTeam =
              game?.awayTeamId || game?.awayTeamShort || game?.awayTeam;

            if (!hasHomeTeam || !hasAwayTeam) {
              skippedMissingTeamData++;
              console.warn(
                `[Oldies] Skipping ${game?.uniqueId} for ${normalizedLeague} because team data is incomplete (home: ${game?.homeTeamShort || game?.homeTeam || 'none'}, away: ${game?.awayTeamShort || game?.awayTeam || 'none'}).`,
              );
              logInsertProgress(idx + 1);
              continue;
            }

            // Reject future games (not yet played) to avoid storing scheduled games as historical
            const gameStartTime = game?.startTimeUTC
              ? new Date(game.startTimeUTC).getTime()
              : null;
            const isFutureGame = gameStartTime && gameStartTime > now.getTime();

            if (isFutureGame) {
              skippedMissingTeamData++;
              console.warn(
                `[Oldies] Skipping future game ${game?.uniqueId} for ${normalizedLeague} (scheduled for ${game?.startTimeUTC}, not yet played).`,
              );
              logInsertProgress(idx + 1);
              continue;
            }
            // Past games are accepted even with null scores; cron will fill them later via fetchGamesScores()
          }

          // Strip scores for future games to prevent polluting the DB with pre-game scores.
          // The ESPN/PWHL APIs may return scores for games that haven't started yet;
          // without this guard, scores would be written to the DB and then removed by
          // fixScoreIssue() on every fetchGamesScores() cycle, creating log spam.
          const gameStartTimeCreate = game?.startTimeUTC
            ? new Date(game.startTimeUTC).getTime()
            : null;
          if (gameStartTimeCreate && gameStartTimeCreate > now.getTime()) {
            game.homeTeamScore = null;
            game.awayTeamScore = null;
          }

          await this.create(game);
          added++;
          logInsertProgress(idx + 1);
        }

        if (addMissingOnly) {
          console.info(
            `[Oldies] ${normalizedLeague} ${season ? `(season ${season})` : ''}: added ${added}, skipped (existing identical) ${skippedExisting}, skipped (missing team/score data) ${skippedMissingTeamData}.`,
          );
          return { added, skippedExisting, skippedMissingTeamData };
        }
      }

      await this._deleteUnlinkedTeams(normalizedLeague);
      return games;
    } catch (err) {
      // Never let a failing third-party API (ESPN / PWHL) propagate to the
      // caller: routes that call this (getAllGames, findByTeam, empty-DB paths
      // of findByDate / findByDateHour) would otherwise return a 500 for a
      // single-league configuration whenever the provider hiccups, e.g. during
      // the off-season. Log and leave the DB untouched instead.
      console.error(
        `[getLeagueGames] Error refreshing ${normalizedLeague}:`,
        (err as any)?.message || err,
      );
      return;
    } finally {
      this.isFetchingGames[normalizedLeague] = false;
      if (skipCascade) {
        this.manualRefreshInProgress[normalizedLeague] = false;
      }
    }
  }

  async getAllGames(
    forceUpdate = false,
    date?,
    leagueList?: string[],
  ): Promise<Game[]> {
    let teams = await this.teamService.findAll();
    if (!teams.length) {
      console.info('No teams found in DB. Fetching teams...');
      teams = (await this.teamService.getTeams()) || [];
    }
    const leagues = Array.from(new Set(teams.map((team) => team.league)));
    const leaguesToRefresh =
      leagueList && leagueList.length > 0
        ? leagues.filter((l) => leagueList.includes(l))
        : leagues;

    const total = leaguesToRefresh.length;
    let lastMilestone = 0; // next 20% milestone to log (20, 40, 60, 80, 100)
    console.info(
      `[getAllGames] refreshing ${total} league(s): ${leaguesToRefresh.join(', ')}`,
    );
    for (let i = 0; i < total; i++) {
      const league = leaguesToRefresh[i];
      console.info(`[getAllGames] refreshing ${league} (${i + 1}/${total})`);
      let needRefresh = true;
      if (date) {
        needRefresh =
          (await isCurrentSeason(league, date)) ||
          (await isPlayoffsPeriod(league, date));
      }
      if (needRefresh) {
        await this.getLeagueGames({ league, forceUpdate, skipCascade: false });
      }
      const pct = Math.round(((i + 1) / total) * 100);
      if (pct >= lastMilestone + 20) {
        lastMilestone = Math.floor(pct / 20) * 20;
        console.info(
          `[getAllGames] progress: ${pct}% (${i + 1}/${total}) — last: ${league}`,
        );
      }
    }
    console.info('[getAllGames] done');
    // Read-only callers (GET /games) expect the in-memory active set, but the cron jobs
    // (monthly getAllGames, daily per-league refreshes, checkLeagueGamesAvailability) must
    // NOT materialise the entire historical collection here — that single `findAll()` scan
    // was loading every old game (2017→today) into the 460 MB heap right after the loop,
    // causing an OOM → Render restart → boot→recovery cycle. Cron callers only need to
    // know the refresh succeeded, so they get an empty array instead.
    return forceUpdate || date ? [] : this.findAll();
  }

  async findAll(): Promise<any[]> {
    const allGames = await this.gameModel
      .find({ isActive: true })
      .sort({ startTimeUTC: 1 })
      .lean()
      .exec();
    if (Object.keys(allGames).length === 0 || allGames?.length === 0) {
      // Read-only on empty DB: never trigger the heavy getAllGames() chain
      // from a read route (GET /games). It fetched ALL leagues with no season
      // gate and blocked the server (sequential third-party fetches under the
      // 460 MB heap budget → restarts). The cron jobs (monthly getAllGames,
      // daily per-league refreshes, checkLeagueGamesAvailability) fill the
      // DB; a manual one-league refresh stays available via
      // POST /games/refresh/:league.
      console.info(
        'No games found in DB. Returning [] — cron jobs will fill the DB.',
      );
      return [];
    }

    const teams = await this.teamService.findAll();
    const teamsMap = new Map(teams.map((t) => [t.uniqueId, t]));

    return allGames.map((game: any) =>
      this._enrichGameWithTeamData(game, teamsMap),
    );
  }

  async findOne(uniqueId: string) {
    const filter = { uniqueId: uniqueId };
    const game = await this.gameModel.findOne(filter).exec();
    return game;
  }

  async getDateRange(leagues?: string) {
    const match: any = {
      isActive: true,
      $expr: { $eq: ['$homeTeamId', '$teamSelectedId'] },
    };

    // Optionally scope the min/max dates to a specific set of leagues
    // (comma/space/plus separated, same convention as `findByDateHour`).
    if (leagues) {
      const leaguesList = leagues
        .split(/[ ,+]+/)
        .filter((l) => l.trim().length > 0)
        .map((l) => l.trim().toUpperCase());
      if (leaguesList.length > 0) {
        match.league = { $in: leaguesList };
      }
    }

    const result = await this.gameModel.aggregate([
      {
        $match: match,
      },
      {
        $group: {
          _id: null,
          minDate: { $min: '$gameDate' },
          maxDate: { $max: '$gameDate' },
        },
      },
    ]);

    if (result.length > 0) {
      return { minDate: result[0].minDate, maxDate: result[0].maxDate };
    }
    return { minDate: null, maxDate: null };
  }

  /**
   * Returns the closest past and future game dates, optionally scoped to one or
   * several leagues and/or teams.
   *
   * Flow (dedicated helpers make each step easy to follow):
   *   1. `_buildClosestDatesFilter` — turn the raw query params into a Mongo filter.
   *   2. `_findClosestGameDate` is called twice — once for the past (largest
   *      `gameDate` strictly before today) and once for the upcoming (smallest
   *      `gameDate` from today onwards).
   *
   * @returns `{ previousDate, nextDate }` as `YYYY-MM-DD` strings (or `null` when
   *          no active game matches).
   */
  async getClosestDates({
    leagues,
    teamSelectedIds,
    date,
  }: {
    leagues?: string;
    teamSelectedIds?: string;
    /** Reference date (`YYYY-MM-DD`). When omitted, `today` is used as the boundary. */
    date?: string;
  }) {
    const baseFilter = this._buildClosestDatesFilter(leagues, teamSelectedIds);
    const boundary = (date ?? '').trim() || readableDate(new Date());

    const previousDate = await this._findClosestGameDate(
      { ...baseFilter, gameDate: { $lt: boundary } },
      '$max',
    );
    const nextDate = await this._findClosestGameDate(
      { ...baseFilter, gameDate: { $gte: boundary } },
      '$min',
    );

    return { previousDate, nextDate };
  }

  /**
   * Builds the base Mongo filter for `getClosestDates`.
   * - `leagues`: comma/space/plus separated, uppercased → `league: { $in: [...] }`
   *   (same convention as `findByDateHour`).
   * - `teamSelectedIds`: comma separated → `teamSelectedId: { $in: [...] }`
   *   (same convention as `filterGames`).
   */
  _buildClosestDatesFilter(leagues?: string, teamSelectedIds?: string) {
    const filter: any = { isActive: true };

    if (leagues && leagues.length > 0) {
      const leaguesList = leagues
        .split(/[ ,+]+/)
        .filter((l) => l.trim().length > 0)
        .map((l) => l.trim().toUpperCase());
      if (leaguesList.length > 0) {
        filter.league = { $in: leaguesList };
      }
    }

    if (teamSelectedIds && teamSelectedIds.length > 0) {
      const teams = teamSelectedIds
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (teams.length > 0) {
        filter.teamSelectedId = { $in: teams };
      }
    }

    return filter;
  }

  /**
   * Runs a single aggregation that returns the `_id`-less min/max `gameDate`
   * matching `filter`. Returns the date string or `null` when nothing matches.
   */
  async _findClosestGameDate(
    filter: Record<string, unknown>,
    operator: '$min' | '$max',
  ) {
    const pipeline: any[] = [
      { $match: filter },
      { $group: { _id: null, date: { [operator]: '$gameDate' } } },
    ];
    const result = await this.gameModel.aggregate(pipeline);
    return result.length > 0 ? result[0].date : null;
  }

  async findByTeam(
    teamSelectedId: string,
    startDate?: string,
    clean?: boolean,
    needRefreshData = true,
  ) {
    const games = await this.filterGames({
      teamSelectedIds: teamSelectedId,
      startDate,
      clean,
    });
    for (const date in games) {
      games[date] = games[date].filter((game) => {
        return (
          game.homeTeamScore === null ||
          game.homeTeamScore === undefined ||
          game.awayTeamScore === null ||
          game.awayTeamScore === undefined
        );
      });
      if (games[date].length === 0) delete games[date];
    }

    const keys = Object.keys(games);
    if (
      needRefreshData &&
      (keys.length === 0 ||
        (keys.length === 1 && !games[keys[0]]?.[0]?.awayTeamShort))
    ) {
      const league = teamSelectedId.split('-')[0];
      if (league) {
        const otherGamesInLeague = await this.findByLeague(league, 10);
        const games = Object.keys(otherGamesInLeague).filter((gameDate) => {
          return otherGamesInLeague[gameDate].some(
            (game) => game.awayTeamShort,
          );
        });
        // Only refresh the league when it is actually in season (regular season
        // or playoffs). Off-season requests return the (legitimately) empty
        // result without hitting third-party APIs; the monthly/daily cron jobs
        // keep the data up to date all year round instead.
        const inSeason =
          games.length > 0 &&
          ((await isCurrentSeason(league, new Date())) ||
            (await isPlayoffsPeriod(league, new Date())));
        if (inSeason) {
          await this.getLeagueGames({
            league,
            forceUpdate: false,
            skipCascade: false,
          });
        }
      }
      const refreshedGames = await this.filterGames({
        teamSelectedIds: teamSelectedId,
        startDate,
        clean,
      });

      // Ensure we filter scores from the refreshed data as well
      for (const date in refreshedGames) {
        refreshedGames[date] = refreshedGames[date].filter(
          (game) => game.homeTeamScore == null,
        );
        if (refreshedGames[date].length === 0) delete refreshedGames[date];
      }
      return refreshedGames;
    }

    return games;
  }

  async findResultsByTeam(teamSelectedId: string, startDate?: string) {
    if (!startDate) {
      const fewYearsAgo = new Date();
      fewYearsAgo.setFullYear(
        fewYearsAgo.getFullYear() - this.maxYearBeforeDelete,
      );
      startDate = readableDate(fewYearsAgo);
    }
    const today = readableDate(new Date());
    const games = await this.filterGames({
      teamSelectedIds: teamSelectedId,
      startDate,
      endDate: today,
      clean: true,
    });

    for (const date in games) {
      games[date] = games[date].filter((game) => {
        return (
          game.homeTeamScore !== null &&
          game.homeTeamScore !== undefined &&
          game.awayTeamScore !== null &&
          game.awayTeamScore !== undefined
        );
      });
      if (games[date].length === 0) {
        delete games[date];
      }
    }

    return games;
  }

  async findResultsByLeague(
    league: string,
    startDate?: string,
    maxResults?: number,
  ) {
    if (!startDate) {
      const fewYearsAgo = new Date();
      fewYearsAgo.setFullYear(
        fewYearsAgo.getFullYear() - this.maxYearBeforeDelete,
      );
      startDate = readableDate(fewYearsAgo);
    }
    maxResults = maxResults || 5000;

    const today = readableDate(new Date());

    const games = await this.filterGames({
      league,
      startDate,
      endDate: today,
      clean: true,
      selectedTeam: true,
      maxResults,
    });

    for (const date in games) {
      games[date] = games[date].filter((game) => {
        return (
          game.homeTeamScore !== null &&
          game.homeTeamScore !== undefined &&
          game.awayTeamScore !== null &&
          game.awayTeamScore !== undefined
        );
      });
      if (games[date].length === 0) {
        delete games[date];
      }
    }

    return games;
  }

  async findByLeague(
    league: string,
    maxResults?: number,
    skip?: number,
    startDate?: string,
    isHome?: boolean,
  ) {
    return this.filterGames({
      league: league,
      maxResults,
      skip,
      startDate,
      isHome,
      selectedTeam: true,
    });
  }

  async filterGames({
    startDate = undefined,
    endDate = undefined,
    teamSelectedIds = undefined,
    league = undefined,
    maxResults = undefined,
    skip = undefined,
    selectedTeam = undefined,
    isHome = undefined,
    clean = undefined,
  }) {
    const filter: any = { isActive: true };

    if (selectedTeam !== undefined) {
      filter.selectedTeam = selectedTeam;
    }

    const effectiveStartDate = startDate || readableDate(new Date());
    filter.gameDate = { $gte: effectiveStartDate };

    if (endDate) {
      filter.gameDate.$lte = endDate;
    }

    if (league) {
      filter.league = league;
    }

    if (teamSelectedIds && teamSelectedIds.length > 0) {
      const teamSelected = teamSelectedIds
        .split(',')
        .map((item) => item.trim());
      filter.teamSelectedId = { $in: teamSelected };
    }

    if (isHome) {
      filter.$expr = { $eq: ['$teamSelectedId', '$homeTeamId'] };
    }

    const filtredGames = await this.gameModel
      .find(filter)
      .sort({ startTimeUTC: 1 })
      .skip(skip ? Number.parseInt(skip, 10) : 0)
      .limit(maxResults ? Number.parseInt(maxResults, 10) : 0)
      .lean()
      .exec();

    const leaguesInGames = Array.from(
      new Set((filtredGames as any[]).map((g) => g.league).filter(Boolean)),
    );
    const teams = await this.teamService.findAll(
      league
        ? [league]
        : leaguesInGames.length > 0
          ? leaguesInGames
          : undefined,
    );
    const teamsMap = new Map(teams.map((t) => [t.uniqueId, t]));

    const games = Array.isArray(filtredGames)
      ? filtredGames.map((game: any) =>
          this._enrichGameWithTeamData(game, teamsMap),
        )
      : [];
    const gamesByDay = {};
    const uniqueTeamSelectedIds = this.getTeams(teamSelectedIds, games);

    // Use actual query results to define boundaries if dates aren't provided
    const resultDates = games.map((game) => new Date(game.gameDate).getTime());
    let minDate =
      resultDates.length > 0
        ? new Date(Math.min(...resultDates))
        : new Date(startDate);
    let maxDate =
      resultDates.length > 0
        ? new Date(Math.max(...resultDates))
        : new Date(endDate || startDate);

    // Ensure input boundaries are respected
    if (startDate && new Date(startDate) < minDate)
      minDate = new Date(startDate);
    if (endDate && new Date(endDate) > maxDate) maxDate = new Date(endDate);

    for (let date = minDate; date <= maxDate; ) {
      const currentDate = readableDate(date);
      const gamesOfDay = [];
      uniqueTeamSelectedIds.forEach((teamSelectedId) => {
        const gameOfDay = games.filter(
          (game) =>
            game.gameDate === currentDate &&
            game.teamSelectedId === teamSelectedId &&
            game.isActive === true,
        );
        if (!gameOfDay.length && !league && !clean) {
          gamesOfDay.push({
            _id: new mongoose.Types.ObjectId().toString(),
            uniqueId: teamSelectedId + currentDate,
            awayTeamId: '',
            awayTeamShort: '',
            awayTeam: '',
            homeTeamId: '',
            homeTeamShort: '',
            homeTeam: '',
            homeTeamScore: null,
            awayTeamScore: null,
            arenaName: '',
            placeName: '',
            gameDate: currentDate,
            teamSelectedId: teamSelectedId,
            show: false,
            selectedTeam: false,
            league: '',
            venueTimezone: '',
            isActive: true,
            startTimeUTC: '',
            updateDate: '',
            __v: 0,
            awayTeamLogo: '',
            awayTeamLogoDark: '',
            homeTeamLogo: '',
            homeTeamLogoDark: '',
            homeTeamRecord: '',
            awayTeamRecord: '',
            color: undefined,
            backgroundColor: undefined,
          });
        } else {
          gamesOfDay.push(...gameOfDay);
        }
      });

      // Only add the date key if there are games, or if we explicitly want placeholders (not clean)
      if (gamesOfDay.length > 0 || (!clean && !league)) {
        gamesByDay[currentDate] = gamesOfDay;
      }
      date = new Date(date.setDate(date.getDate() + 1));
    }

    return gamesByDay;
  }

  async findByDate(gameDate: string) {
    const today = readableDate(new Date());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayString = readableDate(yesterdayDate);
    const filter: any = { isActive: true };
    filter.$expr = { $eq: ['$homeTeamId', '$teamSelectedId'] };

    if (gameDate === today) {
      const threeHoursAgo = new Date(addHours(new Date(), -3));

      filter.$or = [
        { gameDate: gameDate },
        {
          gameDate: yesterdayString,
          startTimeUTC: { $gte: threeHoursAgo.toISOString() },
        },
      ];
    } else {
      filter.gameDate = gameDate;
    }

    const games = await this.gameModel
      .find(filter)
      .sort({ startTimeUTC: 1 })
      .lean()
      .exec();

    if (games.length === 0) {
      // Read-only route: no refresh-on-empty. An empty day is a legitimate
      // result (off-season, no games for the filters); the cron jobs (daily
      // per-league refreshes + monthly getAllGames) keep the DB filled.
      console.info(`No games found in DB for ${gameDate}. Returning [].`);
      return [];
    }

    const leaguesInGames = Array.from(
      new Set(games.map((g) => g.league).filter(Boolean)),
    );

    const teams = await this.teamService.findAll(
      leaguesInGames.length > 0 ? leaguesInGames : undefined,
    );
    const teamsMap = new Map(teams.map((t) => [t.uniqueId, t]));

    // avoid dupplicate games
    const filteredGames = games.filter(({ gameStatus, startTimeUTC }) => {
      const now = new Date();
      const isStartedForMoreThan12Hours =
        new Date(startTimeUTC) < new Date(now.getTime() - 12 * 60 * 60 * 1000);
      return (
        (gameStatus !== 'FINISHED' && !isStartedForMoreThan12Hours) ||
        gameStatus === 'FINISHED'
      );
    });
    return filteredGames.map((game: any) =>
      this._enrichGameWithTeamData(game, teamsMap),
    );
  }

  async update(uniqueId: string, updateGameDto: Partial<UpdateGameDto>) {
    return this.executeWithCapacityGuard(async () => {
      const filter = { uniqueId: uniqueId };
      return this.gameModel.updateOne(filter, updateGameDto);
    }, 'update');
  }
  async remove(uniqueId: string) {
    const filter = { uniqueId: uniqueId };
    const deleted = await this.gameModel.findOneAndDelete(filter).exec();
    return deleted;
  }

  /**
   * Returns the set of team ids referenced by at least one ACTIVE game
   * (`teamSelectedId` + `homeTeamId` + `awayTeamId`). Used by the stale teams
   * purge: a team still referenced by an active game is never deleted, even if
   * its `updateDate` is old (e.g. off-season).
   */
  async findUsedTeamIds(): Promise<Set<string>> {
    const fields = ['teamSelectedId', 'homeTeamId', 'awayTeamId'];
    const used = new Set<string>();
    for (const field of fields) {
      const ids: unknown[] = await this.gameModel
        .distinct(field, { isActive: true })
        .exec();
      for (const id of ids) {
        if (typeof id === 'string' && id.length > 0) used.add(id);
      }
    }
    return used;
  }

  /**
   * Deletes teams stale for more than 2 months with no active game reference.
   * Collects used team ids then delegates filtering/deletion to
   * `TeamService.purgeStaleTeamsWithoutGames()` (no circular dependency:
   * TeamService does not depend on GameService).
   */
  async purgeStaleTeamsWithoutGames(): Promise<{
    action: 'purged' | 'none';
    candidates: number;
    deletedCount: number;
    deletedIds: string[];
  }> {
    const used = await this.findUsedTeamIds();
    return this.teamService.purgeStaleTeamsWithoutGames(used);
  }

  async removeAll() {
    await this.gameModel.deleteMany({});
    const games = await this.gameModel.find().exec();
    for (const game of games) {
      await this.remove(game.uniqueId);
    }
  }

  async removeDuplicatesAndOlds() {
    console.info('Removing duplicates and old games...');

    const maxYearsAgo = new Date();
    maxYearsAgo.setFullYear(
      maxYearsAgo.getFullYear() - this.maxYearBeforeDelete,
    );

    // Prepare both date formats
    const maxYearsAgoISO = maxYearsAgo.toISOString();
    // E.g., "2025-10-23" to match the format of your gameDate field
    const maxYearsAgoStr = maxYearsAgo.toISOString().split('T')[0];

    // 1. Delete games older than 5 years directly in DB for efficiency
    const deleteResult = await this.gameModel.deleteMany({
      $or: [
        {
          // Condition 1: startTimeUTC is valid and older than 5 years
          startTimeUTC: {
            $lt: maxYearsAgoISO,
            $nin: ['', null], // Ignore empty or null fields here
          },
        },
        {
          // Condition 2 (safety net): gameDate is older than 5 years
          gameDate: {
            $lt: maxYearsAgoStr,
            $nin: ['', null],
          },
        },
      ],
    });

    console.info(
      `Deleted ${deleteResult.deletedCount} games older than ${this.maxYearBeforeDelete} years.`,
    );

    // 2. Handle duplicates among remaining active games
    const games = await this.gameModel.find({ isActive: true }).exec();
    const duplicates = [];
    const gameMap = new Map();

    for (const game of games) {
      const key = `${game.teamSelectedId}-${game.startTimeUTC}`;
      if (gameMap.has(key)) {
        const existing = gameMap.get(key);
        const existingHasScore =
          existing.homeTeamScore != null && existing.awayTeamScore != null;
        const currentHasScore =
          game.homeTeamScore != null && game.awayTeamScore != null;

        if (currentHasScore && !existingHasScore) {
          duplicates.push(existing);
          gameMap.set(key, game);
        } else {
          duplicates.push(game);
        }
      } else {
        gameMap.set(key, game);
      }
    }

    for (const duplicate of duplicates) {
      await this.remove(duplicate.uniqueId);
    }

    console.info('End of removing duplicates and old games...');
  }

  async removeLeague(league: string): Promise<DeleteResult> {
    const filter = { league };
    const deleted = await this.gameModel.deleteMany(filter);
    return deleted;
  }

  async unactivateGames(teamId: string): Promise<void> {
    const today = readableDate(new Date());
    const games = await this.gameModel
      .find({
        teamSelectedId: teamId,
        isActive: true,
        gameDate: { $gte: today },
      })
      .lean()
      .exec();
    const now = new Date();

    for (const game of games) {
      if (!game.awayTeamShort) continue;

      const gameTime = new Date(game.startTimeUTC);
      if (gameTime < now) {
        continue;
      }
      game.isActive = false;
      await this.create(game);
    }
  }

  async fetchOldGamesWithMissingScores(hours = 2): Promise<Game[]> {
    const hoursAgo = new Date();
    hoursAgo.setHours(hoursAgo.getHours() - hours);

    // match started at least 2 hours ago and score is null or missing
    const gamesWithoutScores = await this.gameModel
      .find({
        startTimeUTC: { $lte: hoursAgo.toISOString() },
        $or: [{ homeTeamScore: null }, { awayTeamScore: null }],
      })
      .sort({ startTimeUTC: -1 }) // Most recent first
      .exec();
    return gamesWithoutScores;
  }

  async fetchGamesForLiveScoreUpdate(hours = 2): Promise<Game[]> {
    const now = new Date();

    // Upper bound: started at least `hours` ago (default: 2 hours).
    const hoursAgo = new Date();
    hoursAgo.setHours(hoursAgo.getHours() - hours);

    // --- Fix for restart loop / unbounded recovery ---
    // `removeStaleUnresolvedGames` (runs at the end of every score cycle) purges games
    // older than `staleGameMaxAgeDays` (default 90) that are still active / unresolved.
    // Without a matching LOWER bound here, this query also matched 2017 games stuck in an
    // active-but-never-resolved state (e.g. a PWHL game on 2026-05-11). The score cycle
    // kept re-scoring them on every run because `removeStaleUnresolvedGames` could only
    // purge them AFTER the loop, and the loop grew faster than the purge → net growth →
    // heap OOM → Render restarts → boot recovery → repeat.
    // Bounding the scan to `staleGameMaxAgeDays` makes the scan size predictable
    // (≤ ~90 days of games) and lets the purge actually catch up between cycles,
    // breaking the loop.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.staleGameMaxAgeDays);

    // Fetch games that are:
    // 1. Active
    // 2. Started at least `hours` ago AND started within the last `staleGameMaxAgeDays`
    // 3. NOT in a final/cancelled/postponed state
    // This will include games with partial scores (e.g., 3-0) that are still in progress,
    // and games with null scores that are in progress or should have started.
    return await this.gameModel
      .find({
        isActive: true,
        startTimeUTC: {
          $gte: cutoff.toISOString(), // NEW: lower bound (was unbounded)
          $lte: hoursAgo.toISOString(),
        },
        $or: [
          {
            gameStatus: {
              $nin: ['FINISHED', 'FINAL', 'CANCELLED', 'POSTPONED'],
            },
          },
          {
            // Explicitly target games with scores but no status
            gameStatus: null,
            homeTeamScore: { $ne: null },
          },
        ],
      })
      .sort({ startTimeUTC: -1 }) // Most recent first
      .exec();
  }

  async fetchGamesNotStartedWithScores(): Promise<Game[]> {
    const now = new Date();
    return await this.gameModel
      .find({
        startTimeUTC: { $gt: now.toISOString() }, // Game has NOT started
        $and: [
          { homeTeamScore: { $exists: true, $ne: null } }, // But has scores
          { awayTeamScore: { $exists: true, $ne: null } },
        ],
      })
      .exec();
  }

  get isScoreRecoveryRunning(): boolean {
    return this.isFetchingScores;
  }

  // --- Startup recovery timestamp helpers (delegated to RefreshTimestampService) ---
  async getLastRecoveryTimestamp(): Promise<Date | null> {
    return this.refreshTimestampService.getLastRecoveryTimestamp();
  }

  async addRecoveryTimestamp(): Promise<void> {
    await this.refreshTimestampService.addRecoveryTimestamp();
  }

  async fetchGamesScores(): Promise<any[]> {
    if (this.isFetchingScores) {
      console.info('fetchGamesScores is already running.');
      return [];
    }
    this.isFetchingScores = true;
    try {
      console.info('[fetchGamesScores] Starting score recovery cycle...');
      const gamesToProcess = await this.fetchGamesForLiveScoreUpdate(2);

      const postponedGamesLeagues = new Set<string>();

      // Group needed updates by League AND Date
      const tasks = new Map<string, Set<string>>();

      gamesToProcess.forEach((game) => {
        if (game.league && game.gameDate) {
          if (!tasks.has(game.league)) {
            tasks.set(game.league, new Set());
          }
          tasks.get(game.league).add(game.gameDate);
        }
      });

      const results: any[] = [];

      for (const [league, dates] of tasks) {
        for (const date of dates) {
          console.info(
            `[fetchGamesScores] Fetching scores for ${league} on ${date}...`,
          );
          if (league === League.PWHL) {
            const hockeyData = new HockeyData();
            try {
              const scoresPWHL = await hockeyData.getPWHLScores(date);
              if (Array.isArray(scoresPWHL)) {
                console.info(
                  `[fetchGamesScores] PWHL: ${scoresPWHL.length} scores received.`,
                );
                results.push(...scoresPWHL);
              }
            } catch (error) {
              console.error(
                `[fetchGamesScores] Error while fetching PWHL data for ${date}:`,
                error,
              );
              // ignore fetch errors for PWHL
            }
          } else {
            try {
              const espnScores = await getESPNScores(league, date);
              if (Array.isArray(espnScores) && espnScores.length) {
                results.push(...espnScores);
              }
              console.info(
                `[fetchGamesScores] ${league}: ${espnScores?.length ?? 0} scores received.`,
              );
            } catch (err) {
              console.error(
                `Error fetching scores for ${league} on ${date}:`,
                err,
              );
            }
          }
        }
      }

      // Fallback: Check for missing scores and fetch individually
      const fetchedEventIds = new Set(results.map((r) => r.uniqueId));
      for (const game of gamesToProcess) {
        if (game.league === League.PWHL) continue;

        const parts = game.uniqueId.split('-');
        const possibleId = parts[parts.length - 1];

        // Check if it looks like an ESPN ID (numeric) and wasn't already fetched
        if (/^\d+$/.test(possibleId) && !fetchedEventIds.has(possibleId)) {
          try {
            const individualScore = await getESPNGameScore(
              game.league,
              possibleId,
            );
            // Accept individual update if it is final OR if the database record is missing its status
            if (
              individualScore &&
              (individualScore.isFinal || game.gameStatus === null)
            ) {
              console.info(
                `[fetchGamesScores] Fallback: individual score retrieved for ${game.uniqueId}`,
              );
              results.push(individualScore);
              fetchedEventIds.add(possibleId);
            }
          } catch (e) {
            console.error(
              `Failed to fetch individual score for ${game.uniqueId}`,
              e,
            );
          }
        }
      }

      // Now try to update matching games in DB before returning
      const appliedUpdates: any[] = [];
      console.info(
        `[fetchGamesScores] Total scores retrieved: ${results.length}. Applying updates to database...`,
      );

      for (const score of results) {
        try {
          const isPostponed =
            score.status === 'Postponed' ||
            score.status?.type?.name === 'STATUS_POSTPONED' ||
            score.status?.type?.detail?.includes('TBD');

          if (isPostponed) {
            postponedGamesLeagues.add(score.league);
          }

          const matchingGames: any[] = [];

          if (score.uniqueId) {
            try {
              // Match by exact uniqueId or suffix (handles both "123" and "MLB-TEX-123")
              const regex = new RegExp(`${score.uniqueId}$`);
              const idMatches = await this.gameModel
                .find({
                  $or: [
                    { uniqueId: score.uniqueId },
                    { uniqueId: { $regex: regex } },
                  ],
                  league: score.league,
                })
                .exec();
              matchingGames.push(...idMatches);
            } catch (e) {
              // ignore regex errors
            }
          }

          // If no ID matches, try fallback by team IDs and date
          if (matchingGames.length === 0) {
            const dateOfGame = score.startTimeUTC || score?.gameDate;
            if (dateOfGame) {
              const gameDate =
                score.gameDate || readableDate(new Date(score.startTimeUTC));

              const candidateHomeId =
                score.homeTeamId ||
                (score.homeTeamShort
                  ? `${score.league}-${score.homeTeamShort}`
                  : undefined);
              const candidateAwayId =
                score.awayTeamId ||
                (score.awayTeamShort
                  ? `${score.league}-${score.awayTeamShort}`
                  : undefined);

              if (candidateHomeId && candidateAwayId) {
                const teamMatches = await this.gameModel
                  .find({
                    homeTeamId: candidateHomeId,
                    awayTeamId: candidateAwayId,
                    gameDate,
                    league: score.league,
                    isActive: true,
                  })
                  .exec();
                matchingGames.push(...teamMatches);
              }

              if (
                matchingGames.length === 0 &&
                score.homeTeamShort &&
                score.awayTeamShort
              ) {
                const shortMatches = await this.gameModel
                  .find({
                    homeTeamShort: score.homeTeamShort,
                    awayTeamShort: score.awayTeamShort,
                    gameDate,
                    league: score.league,
                    isActive: true,
                  })
                  .exec();
                matchingGames.push(...shortMatches);
              }
            }
          }

          // Deduplicate matches and process each
          const uniqueMatches = Array.from(
            new Map(matchingGames.map((g) => [g._id.toString(), g])).values(),
          );

          for (const game of uniqueMatches) {
            const needsUpdate =
              game.homeTeamScore === null ||
              game.awayTeamScore === null ||
              game.gameStatus === null;

            await this.syncGameWithScore(score, game);

            if (isPostponed) {
              await this.remove(game.uniqueId);
              continue;
            }

            if ((needsUpdate || score.isFinal) && score.isFinal) {
              (game as any).homeTeamRecord = score.homeTeamRecord;
              (game as any).awayTeamRecord = score.awayTeamRecord;
              appliedUpdates.push(game);
            }
          }
        } catch (err) {
          // ignore update errors
        }
      }

      console.info(
        `[fetchGamesScores] Cycle completed. ${appliedUpdates.length} updates applied.`,
      );
      const anyManualRefresh = Object.values(this.manualRefreshInProgress).some(
        (v) => v,
      );
      if (anyManualRefresh) {
        console.info(
          'Skipping cascaded teams/leagues updates because a manual refresh is in progress.',
        );
      } else {
        for (const league of postponedGamesLeagues) {
          await this.getLeagueGames({
            league,
            forceUpdate: true,
            skipCascade: false,
          });
        }
      }

      await this.fixScoreIssue();
      await this.removeOldGamesWithoutScore();
      await this.removeStaleUnresolvedGames();

      return appliedUpdates.length ? appliedUpdates : results;
    } catch (error) {
      console.error('Error fetching games scores:', error);
      return [];
    } finally {
      this.isFetchingScores = false;
    }
  }

  private async fixScoreIssue() {
    const wrongScores = await this.fetchGamesNotStartedWithScores();
    for (const game of wrongScores) {
      console.info(
        `[fixScoreIssue] Removing score for game ${game.uniqueId} that has scores but hasn't started yet...`,
      );
      await this.gameModel.updateOne(
        { uniqueId: game.uniqueId },
        {
          $set: { homeTeamScore: null, awayTeamScore: null, gameStatus: null },
        },
      );
    }
  }

  private async removeOldGamesWithoutScore() {
    const gamesToDelete = await this.fetchOldGamesWithMissingScores(72);

    console.info(
      `[fetchGamesScores] ${gamesToDelete.length} games without scores found. Processing...`,
    );

    for (const game of gamesToDelete) {
      console.info(
        `[fetchGamesScores] Removing game ${game.uniqueId} without score and started more than 72h ago...`,
      );
      await this.remove(game.uniqueId);
    }
  }

  /**
   * Purges games that are still active (and not resolved to a terminal status) several
   * months after they started. These are stuck/stale games whose final result can no
   * longer be recovered from the source, so they would otherwise trigger the
   * "Fetching scores for {league}..." cycle on every run (e.g. a PWHL game on 2026-05-11).
   */
  private async removeStaleUnresolvedGames(
    maxAgeDays = this.staleGameMaxAgeDays,
  ): Promise<Game[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    const staleGames = await this.gameModel
      .find({
        isActive: true,
        startTimeUTC: { $lte: cutoff.toISOString(), $nin: ['', null] },
        gameStatus: {
          $nin: ['FINISHED', 'FINAL', 'CANCELLED', 'POSTPONED'],
        },
      })
      .exec();

    console.info(
      `[fetchGamesScores] ${staleGames.length} active game(s) unresolved for more than ${maxAgeDays} days. Processing...`,
    );

    for (const game of staleGames) {
      console.info(
        `[fetchGamesScores] Removing unresolved game ${game.uniqueId} (${game.league}) started more than ${maxAgeDays} days ago without a final status...`,
      );
      await this.remove(game.uniqueId);
    }

    return staleGames;
  }

  async fetchLiveScores(gameIds: string[]): Promise<any[]> {
    const games = await this.gameModel
      .find({ uniqueId: { $in: gameIds } })
      .exec();
    if (!games || games.length === 0) return [];

    const allScores: any[] = [];
    const espnGames = [];
    const pwhlGames = [];

    for (const game of games) {
      if (game.league === League.PWHL) {
        pwhlGames.push(game);
      } else {
        espnGames.push(game);
      }
    }

    if (pwhlGames.length > 0) {
      const hockeyData = new HockeyData();
      try {
        const scores = await hockeyData.getPWHLRealTimeData();
        if (Array.isArray(scores)) {
          allScores.push(...scores);
        }
      } catch (error) {
        console.error(`Error fetching PWHL live scores:`, error);
      }
    }

    if (espnGames.length > 0) {
      const promises = espnGames.map(async (game) => {
        const parts = game.uniqueId.split('-');
        const eventId = parts[parts.length - 1];
        if (/^\d+$/.test(eventId)) {
          try {
            return await getESPNGameScore(game.league, eventId);
          } catch (error) {
            console.error(
              `Error fetching ESPN score for ${game.uniqueId}:`,
              error,
            );
            return null;
          }
        }
        return null;
      });

      const results = await Promise.all(promises);
      results.forEach((res) => {
        if (res) allScores.push(res);
      });
    }

    const updatedGames = [];

    for (const game of games) {
      let matchedScore = allScores.find((s) => s.uniqueId === game.uniqueId);

      if (!matchedScore) {
        matchedScore = allScores.find(
          (s) =>
            s.uniqueId &&
            game.uniqueId.endsWith(s.uniqueId) &&
            s.league === game.league,
        );
      }

      if (matchedScore) {
        await this.syncGameWithScore(matchedScore, game);
        updatedGames.push(game);
      } else {
        updatedGames.push(game);
      }
    }

    return updatedGames;
  }

  private async syncGameWithScore(
    matchedScore: any,
    game: mongoose.Document<unknown, {}, Game> &
      Game &
      Required<{ _id: unknown }> & { __v: number },
  ) {
    const resolvedStatus = this._resolveStatus(matchedScore);

    // Only update scores and game time information if the game is in progress or finished.
    // This avoids filling the database with temporary scores (e.g., 0-0) for games that are still "scheduled".
    if (
      resolvedStatus !== 'SCHEDULED' &&
      resolvedStatus !== 'POSTPONED' &&
      resolvedStatus !== 'CANCELLED'
    ) {
      const isFinalStatus =
        resolvedStatus === 'FINISHED' || matchedScore.isFinal;

      game.homeTeamScore =
        matchedScore.homeTeamScore !== null &&
        matchedScore.homeTeamScore !== undefined
          ? matchedScore.homeTeamScore
          : isFinalStatus
            ? 0
            : game.homeTeamScore;

      game.awayTeamScore =
        matchedScore.awayTeamScore !== null &&
        matchedScore.awayTeamScore !== undefined
          ? matchedScore.awayTeamScore
          : isFinalStatus
            ? 0
            : game.awayTeamScore;
      game.gameClock = matchedScore.gameClock;
      game.gamePeriod = matchedScore.gamePeriod;
    }

    game.updateDate = new Date().toISOString();
    game.gameStatus = resolvedStatus;
    game.seriesSummary = matchedScore.seriesSummary;
    game.seriesStatus = matchedScore.seriesStatus;

    // Update team records
    if (matchedScore.homeTeamRecord && game.homeTeamId) {
      await this.teamService.updateRecord(
        game.homeTeamId,
        matchedScore.homeTeamRecord,
      );
    }
    if (matchedScore.awayTeamRecord && game.awayTeamId) {
      await this.teamService.updateRecord(
        game.awayTeamId,
        matchedScore.awayTeamRecord,
      );
    }

    // Propagate series info to future games in the same series
    // This allows users to see the series lead/status on future scheduled games
    if (game.seriesSummary || game.seriesStatus) {
      await this.gameModel
        .updateMany(
          {
            league: game.league,
            startTimeUTC: { $gt: game.startTimeUTC },
            $or: [
              { homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId },
              { homeTeamId: game.awayTeamId, awayTeamId: game.homeTeamId },
            ],
          },
          {
            $set: {
              seriesSummary: game.seriesSummary,
              seriesStatus: game.seriesStatus,
            },
          },
        )
        .exec();
    }

    // Update isActive based on resolved status
    if (resolvedStatus === 'POSTPONED' || resolvedStatus === 'CANCELLED') {
      game.isActive = false;
    } else {
      // If the matchedScore explicitly provides isActive, use it, otherwise keep current
      game.isActive =
        matchedScore.isActive === undefined
          ? game.isActive
          : matchedScore.isActive;
    }

    // Update startTimeUTC and gameDate if they have changed (using same logic as fetchGamesScores)
    if (matchedScore.startTimeUTC) {
      const startTime = new Date(matchedScore.startTimeUTC);
      const now = new Date();
      const currentDateAdjusted = new Date(
        new Date(matchedScore.startTimeUTC).toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
        }),
      );

      const newStartTimeISO = startTime.toISOString();
      const newGameDate = readableDate(currentDateAdjusted);

      if (
        startTime > now &&
        (game.startTimeUTC !== newStartTimeISO || game.gameDate !== newGameDate)
      ) {
        game.startTimeUTC = newStartTimeISO;
        game.gameDate = newGameDate;
      }
    }

    await this.executeWithCapacityGuard(
      async () => game.save(),
      'syncGameWithScore.save',
    );
    return resolvedStatus;
  }

  async findByDateHour(
    gameDate: string,
    leagues?: string,
    maxResults?: number,
    skip?: number,
  ) {
    const today = readableDate(new Date());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayString = readableDate(yesterdayDate);
    const filter: any = { isActive: true };
    filter.$expr = { $eq: ['$homeTeamId', '$teamSelectedId'] };
    let leaguesList: string[] = [];

    if (leagues) {
      leaguesList = leagues
        .split(/[ ,+]+/)
        .filter((l) => l.trim().length > 0)
        .map((l) => l.trim().toUpperCase());
      if (leaguesList.length > 0) {
        filter.league = { $in: leaguesList };
      }
    }

    if (gameDate === today) {
      const threeHoursAgo = new Date(addHours(new Date(), -3));

      filter.$or = [
        { gameDate: gameDate },
        {
          gameDate: yesterdayString,
          startTimeUTC: { $gte: threeHoursAgo.toISOString() },
        },
      ];
    } else {
      filter.gameDate = gameDate;
    }

    const query = this.gameModel.find(filter).sort({ startTimeUTC: 1 });

    if (skip !== undefined) {
      query.skip(skip);
    }
    if (maxResults !== undefined) {
      query.limit(maxResults);
    }

    const games = await query.lean().exec();
    if (games.length === 0) {
      // Read-only route: no refresh-on-empty. An empty day is a legitimate
      // result (off-season, no games for the selected leagues/filters); the
      // cron jobs (daily per-league refreshes + monthly getAllGames +
      // checkLeagueGamesAvailability) fill and keep the DB fresh. Refreshing
      // from this read path was blocking the server during third-party
      // schedule fetches (event-loop + memory pressure → restarts).
      console.info(
        `[findByDateHour] No games found for ${gameDate}. Returning {}.`,
      );
      return {};
    }

    const leaguesInGames = Array.from(
      new Set(games.map((g) => g.league).filter(Boolean)),
    );

    const teams = await this.teamService.findAll(
      leaguesList.length > 0
        ? leaguesList
        : leaguesInGames.length > 0
          ? leaguesInGames
          : undefined,
    );
    const teamsMap = new Map(teams.map((t) => [t.uniqueId, t]));

    // avoid dupplicate games
    const filteredGames = games.filter(({ gameStatus, startTimeUTC }) => {
      const now = new Date();
      const isStartedForMoreThan12Hours =
        new Date(startTimeUTC) < new Date(now.getTime() - 12 * 60 * 60 * 1000);
      return (
        (gameStatus !== 'FINISHED' && !isStartedForMoreThan12Hours) ||
        gameStatus === 'FINISHED'
      );
    });

    const gamesByTimeSlot: { [key: string]: any[] } = {};
    filteredGames.forEach((game: any) => {
      const enrichedGame = this._enrichGameWithTeamData(game, teamsMap);
      const date = new Date(enrichedGame.startTimeUTC);
      const hours = date.getUTCHours().toString().padStart(2, '0');
      const minutes = date.getUTCMinutes();
      const minutesStr = minutes < 30 ? '00' : '30';
      const timeSlot = `${hours}:${minutesStr}`;

      if (!gamesByTimeSlot[timeSlot]) {
        gamesByTimeSlot[timeSlot] = [];
      }
      gamesByTimeSlot[timeSlot].push(enrichedGame);
    });

    return gamesByTimeSlot;
  }

  private _resolveStatus(score: any): string {
    // Priority 0: Check for explicit postponement or cancellation in text fields
    // Sometimes APIs put postponement reasons in status detail, series summary, or records
    const statusTextFields = [
      typeof score.status === 'string' ? score.status : '',
      score.status?.detail,
      score.status?.type?.detail,
      score.seriesSummary,
      score.homeTeamRecord,
    ]
      .filter(Boolean)
      .map((s) => s.toUpperCase());

    const explicitTypeName = (
      (typeof score.status === 'object' ? score.status?.type?.name : '') || ''
    ).toUpperCase();

    // A temporarily interrupted game (rain delay / suspended) is distinct from a
    // postponement: it is expected to resume and still produce a result, so it
    // must stay visible with its own status for the frontend to display a
    // translated "interrupted/delayed" badge (unlike a true postponement).
    if (
      explicitTypeName === 'STATUS_DELAYED' ||
      explicitTypeName === 'STATUS_SUSPENDED'
    ) {
      return 'DELAYED';
    }
    if (explicitTypeName === 'STATUS_POSTPONED') return 'POSTPONED';
    if (explicitTypeName === 'STATUS_CANCELLED') return 'CANCELLED';

    // Text fallback. Prioritise an explicit postponement/cancellation so that a
    // detail like "Postponed - Heavy Rain" stays a postponement rather than being
    // downgraded to a plain delay.
    if (statusTextFields.some((text) => /POSTPONED|POSTPONE|TBD/i.test(text))) {
      return 'POSTPONED';
    }
    if (statusTextFields.some((text) => /CANCELLED|CANCELED/i.test(text))) {
      return 'CANCELLED';
    }
    if (
      statusTextFields.some((text) =>
        /DELAYED|DELAY|SUSPENDED|INTERRUPTED|RAIN|WEATHER/i.test(text),
      )
    ) {
      return 'DELAYED';
    }

    // Priority 1: Check if game is truly finished
    if (score.isFinal) {
      return 'FINISHED';
    }

    // If the game started a long time ago (e.g., > 12 hours) and has scores,
    // it is almost certainly finished, regardless of the API status string.
    if (score.startTimeUTC) {
      const startTime = new Date(score.startTimeUTC);
      const now = new Date();
      const hoursSinceStart =
        (now.getTime() - startTime.getTime()) / (1000 * 60 * 60);
      if (
        hoursSinceStart > 12 &&
        (score.homeTeamScore !== null || score.awayTeamScore !== null)
      ) {
        return 'FINISHED';
      }
    }

    // Priority 2: If API provides explicit game status (like "1st", "Top", "Bot", etc.), use it
    if (score.gameStatus) {
      const gameStatus = score.gameStatus.toUpperCase();
      // Game status indicators that mean the game is in progress
      if (gameStatus === 'FINISHED' || gameStatus === 'FINAL') {
        return 'FINISHED';
      }

      if (
        [
          'TOP',
          'BOT',
          'MID',
          'END',
          '1ST',
          '2ND',
          '3RD',
          '4TH',
          'OT',
          'HALF',
          'IN SO',
          'IN PROGRESS',
        ].some((s) => gameStatus.includes(s))
      ) {
        return score.gameStatus; // Return as-is for live game indicators
      }
      // Game status indicators that mean the game is finished
      if (
        gameStatus.includes('FINAL') ||
        gameStatus.includes('ENDED') ||
        gameStatus === 'FT' ||
        gameStatus === 'FULL TIME'
      ) {
        return 'FINISHED';
      }
      // For other explicit statuses, use them as-is
      return score.gameStatus;
    }

    // Priority 3: Check API state field
    if (score.status && typeof score.status === 'object') {
      const state = score.status.state || score.status.type?.state;
      if (state === 'post') {
        return 'FINISHED';
      } else if (state === 'in') {
        return 'IN_PROGRESS';
      } else if (state === 'pre') {
        return 'SCHEDULED';
      }
    } else if (typeof score.status === 'string') {
      const status = score.status.toUpperCase();
      if (status === 'POSTPONED') {
        return 'POSTPONED';
      }
      return score.status;
    }

    // Priority 4: If we have scores but no explicit finish, it's ongoing
    // If at least one score is present, the game is no longer just scheduled
    if (score.homeTeamScore != null || score.awayTeamScore != null) {
      return 'IN_PROGRESS';
    }

    // Default: Scheduled
    return 'SCHEDULED';
  }

  async syncRecentGames(): Promise<any[]> {
    const allLeagues = Object.values(League);
    const collegeLeagues = Object.values(CollegeLeague) as string[];
    const targetLeagues = allLeagues.filter((l) => !collegeLeagues.includes(l));

    const now = new Date();

    for (const league of targetLeagues) {
      // Synchronize data for the last 7 days
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(now.getDate() - i);
        const dateStr = readableDate(date);

        let externalGames: any[] = [];
        try {
          if (league === League.PWHL) {
            const hockeyData = new HockeyData();
            externalGames = await hockeyData.getPWHLScores(dateStr);
          } else {
            externalGames = await getESPNScores(league, dateStr);
          }
        } catch (error) {
          console.error(
            `[syncRecentGames] Error fetching data for ${league} on ${dateStr}:`,
            error,
          );
          continue;
        }

        if (!Array.isArray(externalGames) || externalGames.length === 0)
          continue;

        // Fetch games already in DB for this specific day and league
        const dbGames = await this.gameModel
          .find({
            league,
            gameDate: dateStr,
          })
          .exec();

        for (const extGame of externalGames) {
          // Check if the game is missing from DB
          const alreadyExists = dbGames.some((dbGame) => {
            const matchesId =
              extGame.uniqueId &&
              (dbGame.uniqueId === extGame.uniqueId ||
                dbGame.uniqueId.endsWith(extGame.uniqueId));
            const matchesTeams =
              dbGame.homeTeamId === extGame.homeTeamId &&
              dbGame.awayTeamId === extGame.awayTeamId;
            return matchesId || matchesTeams;
          });

          if (!alreadyExists) {
            // Create missing game
            const gameToCreate = {
              ...extGame,
              league: extGame.league || league,
              gameDate: extGame.gameDate || dateStr,
              isActive: true,
              updateDate: new Date().toISOString(),
            };
            await this.create(gameToCreate);
          }
        }
      }
    }

    // Retrieve and return all games for the last 7 days for these leagues
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(now.getDate() - 7);
    const startDateStr = readableDate(sevenDaysAgo);

    return this.gameModel
      .find({
        league: { $in: targetLeagues },
        gameDate: { $gte: startDateStr },
        isActive: true,
      })
      .sort({ gameDate: -1, startTimeUTC: 1 })
      .lean()
      .exec();
  }

  private async _deleteUnlinkedTeams(league: string): Promise<void> {
    const normalizedLeague = league.toUpperCase().trim();

    // 1. Exclude all college leagues to prevent infinite delete/refetch loops
    const isCollegeLeague = Object.values(CollegeLeague).includes(
      normalizedLeague as CollegeLeague,
    );

    if (isCollegeLeague) {
      return;
    }

    // 2. Safeguard: stop cleanup if no games exist at all for this league in the DB
    const totalGamesForLeague = await this.gameModel.countDocuments({
      league: normalizedLeague,
    });
    if (totalGamesForLeague === 0) {
      return;
    }

    // 3. Fetch all teams currently stored for the specified league
    const teams = await this.teamService.findAll([normalizedLeague]);
    if (!teams.length) return;

    // 4. Find all team IDs referenced in games across all years (without date filters)
    const [referencedTeamIds, homeTeamIds, awayTeamIds] = await Promise.all([
      this.gameModel.distinct('teamSelectedId', { league: normalizedLeague }),
      this.gameModel.distinct('homeTeamId', { league: normalizedLeague }),
      this.gameModel.distinct('awayTeamId', { league: normalizedLeague }),
    ]);

    const usedTeamIds = new Set([
      ...referencedTeamIds,
      ...homeTeamIds,
      ...awayTeamIds,
    ]);

    // 5. Identify unlinked teams (pro leagues only) with zero existing games.
    //    Teams marked as inactive (`HistoricalTeams` or `isActive:false`) are
    //    never deleted: they are needed to enrich historical/oldies games.
    const unlinkedTeams = teams.filter(
      (team) =>
        !usedTeamIds.has(team.uniqueId) &&
        team.isActive !== false &&
        !HistoricalTeams[team.uniqueId],
    );

    if (unlinkedTeams.length > 0) {
      console.info(
        `[Cleanup] Found ${unlinkedTeams.length} unlinked teams for ${normalizedLeague}. Deleting...`,
      );

      const idsToDelete = unlinkedTeams.map((t) => t.uniqueId);
      await this.teamService.deleteManyByIds(idsToDelete);
    }
  }

  /**
   * Retrieves all years currently present in the database and counts games by year.
   * Returns a list sorted from oldest to newest.
   */
  private async getAvailableYears(): Promise<
    { year: number; count: number; oldestDate: string; newestDate: string }[]
  > {
    const result = await this.gameModel.aggregate([
      {
        $group: {
          _id: {
            $substrCP: ['$gameDate', 0, 4], // Extract the first 4 characters (YYYY)
          },
          count: { $sum: 1 },
          oldestDate: { $min: '$gameDate' },
          newestDate: { $max: '$gameDate' },
        },
      },
      { $sort: { _id: 1 } }, // Years from oldest to newest
      {
        $project: {
          _id: 0,
          year: { $toInt: '$_id' },
          count: 1,
          oldestDate: 1,
          newestDate: 1,
        },
      },
    ]);

    return result;
  }

  /**
   * Disk usage result type returned by getDiskUsage().
   */
  private diskUsageResult(usedMB: number, totalMB: number, percentage: number) {
    return { usedMB, totalMB, percentage };
  }

  /**
   * Calculates MongoDB disk usage via dbStats (Atlas-compatible).
   *
   * `df` only sees the local container filesystem — on Render this is
   * ephemeral and does NOT reflect the remote Atlas cluster storage.
   * `db.command({ dbStats: 1 })` returns the actual storage footprint
   * of the database, matching what Atlas shows in its Metrics tab.
   *
   * `totalMB` is a hardcoded constant (CLUSTER_TOTAL_MB) set to match
   * your Atlas cluster storage size (e.g. 512 for a 512MB cluster).
   * Adjust this value if you upgrade your Atlas plan.
   *
   * Results are cached for DISK_USAGE_CACHE_TTL_MS (60s) to avoid
   * overloading the Atlas cluster with frequent dbStats commands.
   *
   * Returns { usedMB, totalMB, percentage (0-1) }
   */
  private async getDiskUsage(): Promise<{
    usedMB: number;
    totalMB: number;
    percentage: number;
  }> {
    const now = Date.now();

    // 1. Serve from cache if still valid
    if (
      this.diskUsageCache &&
      now - this.diskUsageCache.timestamp < this.DISK_USAGE_CACHE_TTL_MS
    ) {
      return this.diskUsageCache.data;
    }

    try {
      // 2. Proper type-safe access to native MongoDB driver via Mongoose
      const mongooseConnection = this.gameModel.db;
      if (!mongooseConnection || mongooseConnection.readyState !== 1) {
        throw new Error('Mongoose connection is not ready');
      }

      const db = mongooseConnection.db;
      if (!db) {
        throw new Error('Native MongoDB database instance is not available');
      }

      let usedBytes = 0;
      let statsSource = 'unknown';

      try {
        // Attempt dbStats (requires admin read privileges)
        const dbStats = await db.command({ dbStats: 1 });

        // Log actual dbStats response for debugging
        console.info(
          '[Capacity Manager] dbStats response:',
          JSON.stringify({
            dataSize: dbStats.dataSize,
            storageSize: dbStats.storageSize,
            indexSize: dbStats.indexSize,
            totalSize: dbStats.totalSize,
            fileSize: dbStats.fileSize,
            nsSizeMB: dbStats.nsSizeMB,
          }),
        );

        // Prioritize totalSize (data + indexes across all collections),
        // then fall back to dataSize + indexSize (Atlas-compatible for all cluster types)
        if (dbStats.totalSize && dbStats.totalSize > 0) {
          usedBytes = dbStats.totalSize;
          statsSource = 'dbStats.totalSize';
        } else if (dbStats.dataSize || dbStats.indexSize) {
          usedBytes = (dbStats.dataSize || 0) + (dbStats.indexSize || 0);
          statsSource = 'dbStats.dataSize+indexSize';
        } else {
          usedBytes = dbStats.storageSize || 0;
          statsSource = 'dbStats.storageSize';
        }
      } catch (dbStatsError) {
        // Fallback: aggregate $collStats across ALL collections
        console.info(
          '[Capacity Manager] dbStats failed, using collection aggregation fallback',
        );
        console.debug(
          '[Capacity Manager] dbStats error:',
          dbStatsError instanceof Error
            ? dbStatsError.message
            : String(dbStatsError),
        );

        try {
          // Get all collection names and sum their storage stats
          const collections = await db.listCollections().toArray();
          let totalStorageSize = 0;
          let totalIndexSize = 0;
          let totalDataSize = 0;

          for (const collInfo of collections) {
            const collName = collInfo.name;
            // Skip system collections
            if (collName.startsWith('system.')) continue;

            try {
              const collStats = await db
                .collection(collName)
                .aggregate([{ $collStats: { storageStats: {} } }])
                .toArray();

              if (collStats[0]?.storageStats) {
                const ss = collStats[0].storageStats;
                // $collStats returns: size (uncompressed data), storageSize (compressed), totalIndexSize
                totalDataSize += ss.size || 0;
                totalStorageSize += ss.storageSize || 0;
                totalIndexSize += ss.totalIndexSize || 0;
              }
            } catch {
              // Skip collections we can't read
              console.debug(
                `[Capacity Manager] Could not get stats for collection: ${collName}`,
              );
            }
          }

          // Use dataSize + totalIndexSize to match Atlas "Total Data Size"
          usedBytes = totalDataSize + totalIndexSize;
          statsSource = 'aggregated $collStats (all collections)';

          console.info(
            '[Capacity Manager] Aggregated collection stats:',
            JSON.stringify({
              totalDataSize,
              totalStorageSize,
              totalIndexSize,
              usedBytes,
            }),
          );
        } catch (aggError) {
          // Last resort: just use the games collection stats
          console.info(
            '[Capacity Manager] Aggregation failed, using games collection only',
          );

          const sizeInfo = await this.gameModel
            .aggregate<{
              storageStats?: {
                size?: number;
                storageSize?: number;
                totalIndexSize?: number;
              };
            }>([{ $collStats: { storageStats: {} } }])
            .exec()
            .catch(() => null);

          if (sizeInfo?.length && sizeInfo[0]?.storageStats) {
            const stats = sizeInfo[0].storageStats;
            // $collStats returns "size" (not "totalSize") for uncompressed data size
            usedBytes = (stats.size || 0) + (stats.totalIndexSize || 0);
            statsSource = 'games collection $collStats only';
          }
        }
      }

      // 3. Convert bytes → MiB
      const usedMB = Math.round(usedBytes / (1024 * 1024));

      // 4. Calculate total cluster quota (hardcoded constant)
      const totalMB = this.CLUSTER_TOTAL_MB;

      // 5. Calculate percentage, capped at 1.0 (100%)
      const rawPercentage = totalMB > 0 ? usedMB / totalMB : 0;
      const percentage = Number(Math.min(rawPercentage, 1).toFixed(4));

      const result = this.diskUsageResult(usedMB, totalMB, percentage);

      // Update cache
      this.diskUsageCache = { data: result, timestamp: now };

      // Log with source info for debugging
      console.info(
        `[Capacity Manager] Disk usage: ${usedMB}MB / ${totalMB}MB (${(percentage * 100).toFixed(1)}%) - source: ${statsSource}`,
      );

      // Critical threshold warning (> 85%)
      if (percentage >= 0.85) {
        console.warn(
          `[Capacity Manager] Disk usage is CRITICAL: ${usedMB}MB / ${totalMB}MB (${(percentage * 100).toFixed(1)}%)`,
        );
      }

      return result;
    } catch (error) {
      console.warn(
        '[Capacity Manager] Could not check disk usage:',
        error instanceof Error ? error.message : String(error),
      );

      // Return last known cache on transient error, or safe fallback
      return this.diskUsageCache?.data ?? this.diskUsageResult(0, 1, 0);
    }
  }

  /**
   * Deletes all games from a given year.
   * Returns the number of deleted games.
   */
  private async deleteGamesForYear(year: number): Promise<number> {
    const yearStr = year.toString();
    const startDate = `${yearStr}-01-01`;
    const endDate = `${yearStr}-12-31`;

    const result = await this.gameModel.deleteMany({
      gameDate: { $gte: startDate, $lte: endDate },
    });

    console.info(
      `[Capacity Manager] Deleted ${result.deletedCount} games from year ${year}`,
    );
    return result.deletedCount || 0;
  }

  /**
   * READ-ONLY capacity report.
   * Returns the current disk usage + a per-year breakdown (oldest → newest)
   * plus the count of stored teams, WITHOUT performing any deletion.
   * Intended for manual inspection / a GET endpoint so operators can decide
   * whether to trigger `purgeOldestYearsIfNeeded()`.
   */
  async getCapacityStatus(): Promise<{
    /** Used storage in MB */
    usedMB: number;
    /** Total storage in MB */
    totalMB: number;
    /** Occupancy rate (0–1) */
    percentage: number;
    /** Per-year game counts, oldest → newest */
    years: {
      year: number;
      count: number;
      oldestDate: string;
      newestDate: string;
    }[];
    /** Total number of stored teams */
    teamCount: number;
    /** Total number of stored game documents */
    gameCount: number;
    /** Occupancy threshold above which a purge is triggered (default 0.9) */
    threshold: number;
    /** True when `percentage >= threshold` */
    actionNeeded: boolean;
    diskUsage: { usedMB: number; totalMB: number; percentage: number };
  }> {
    const defaults = {
      diskUsage: { usedMB: 0, totalMB: 1, percentage: 0 },
      years: [] as {
        year: number;
        count: number;
        oldestDate: string;
        newestDate: string;
      }[],
      teamCount: 0,
      gameCount: 0,
    };

    try {
      const [diskUsage, years, teamCount, gameCount] = await Promise.all([
        this.getDiskUsage(),
        this.getAvailableYears(),
        this.teamService.countAllTeams?.() ?? 0,
        this.gameModel.countDocuments({}),
      ]);

      return {
        // Flattened at root for easy consumption: used / total / percentage
        usedMB: diskUsage.usedMB,
        totalMB: diskUsage.totalMB,
        percentage: diskUsage.percentage,
        years,
        teamCount,
        gameCount,
        threshold: this.DISK_USAGE_THRESHOLD,
        actionNeeded: diskUsage.percentage >= this.DISK_USAGE_THRESHOLD,
        diskUsage,
      };
    } catch {
      return {
        ...defaults,
        usedMB: 0,
        totalMB: 1,
        percentage: 0,
        threshold: this.DISK_USAGE_THRESHOLD,
        actionNeeded: false,
        diskUsage: defaults.diskUsage,
      };
    }
  }

  /**
   * Checks disk space and deletes the oldest years if needed.
   * Returns a report with the action taken and the current disk usage.
   */
  async purgeOldestYearsIfNeeded(): Promise<{
    action: 'none' | 'purged';
    diskUsage: { usedMB: number; totalMB: number; percentage: number };
    purgedYears?: number[];
    remainingYears?: number[];
  }> {
    const now = Date.now();

    // Avoid overly frequent checks (maximum once per hour)
    if (now - this.lastDiskCheck < this.CHECK_INTERVAL_MS) {
      return {
        action: 'none',
        diskUsage: { usedMB: 0, totalMB: 1, percentage: 0 },
      };
    }

    this.lastDiskCheck = now;

    const diskUsage = await this.getDiskUsage();
    const purgedYears: number[] = [];

    console.info(
      `[Capacity Manager] Disk usage: ${(diskUsage.percentage * 100).toFixed(1)}% (${diskUsage.usedMB}MB / ${diskUsage.totalMB}MB)`,
    );

    // If the storage is full, purge years one by one
    if (diskUsage.percentage >= this.DISK_USAGE_THRESHOLD) {
      const years = await this.getAvailableYears();

      if (years.length === 0) {
        console.warn('[Capacity Manager] No games to delete!');
        return {
          action: 'none',
          diskUsage,
          remainingYears: [],
        };
      }

      console.warn(
        `[Capacity Manager] Disk usage exceeds ${(this.DISK_USAGE_THRESHOLD * 100).toFixed(0)}%! Starting purge...`,
      );

      // Delete years from oldest to newest until usage drops below the threshold
      for (const { year, count } of years) {
        console.info(
          `[Capacity Manager] Purging year ${year} (${count} games)...`,
        );

        await this.deleteGamesForYear(year);
        purgedYears.push(year);

        // Re-check after each deletion
        const updatedDiskUsage = await this.getDiskUsage();
        console.info(
          `[Capacity Manager] New disk usage: ${(updatedDiskUsage.percentage * 100).toFixed(1)}%`,
        );

        if (updatedDiskUsage.percentage < this.DISK_USAGE_THRESHOLD) {
          console.info('[Capacity Manager] Disk usage back to normal.');
          break;
        }
      }

      const remainingYears = (await this.getAvailableYears()).map(
        (y) => y.year,
      );

      return {
        action: 'purged',
        diskUsage: await this.getDiskUsage(),
        purgedYears,
        remainingYears,
      };
    }

    const remainingYears = (await this.getAvailableYears()).map((y) => y.year);
    return {
      action: 'none',
      diskUsage,
      remainingYears,
    };
  }

  /**
   * Checks if an error is a MongoDB "no space left" / disk full error.
   * MongoDB error codes: 68 (NoSpaceLeft), 14 (DiskFull), or message patterns.
   */
  private isNoSpaceError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    // Check MongoDB error code
    const code = (error as any).code;
    if (code === 68 || code === 14) return true;

    // Check error message patterns
    const message =
      (error as any)?.message ?? (error as any)?.errmsg ?? String(error);
    const lowerMsg = message.toLowerCase();
    return (
      lowerMsg.includes('no space left') ||
      lowerMsg.includes('disk full') ||
      lowerMsg.includes('out of disk space') ||
      lowerMsg.includes('quota exceeded') ||
      lowerMsg.includes('storage full')
    );
  }

  /**
   * Handles a "no space" error by purging the oldest month of games.
   * Returns true if the error was a no-space error and purge was triggered.
   */
  private async handleNoSpaceError(error: unknown): Promise<boolean> {
    if (!this.isNoSpaceError(error)) return false;

    console.warn(
      '[Capacity Manager] No space left error detected — triggering automatic purge of oldest month...',
    );
    try {
      const result = await this.purgeOldestMonth();
      if (result.action === 'purged') {
        console.info(
          `[Capacity Manager] Auto-purge completed: deleted ${result.deletedCount} games from ${result.purgedYear}-${result.purgedMonth?.toString().padStart(2, '0')}.`,
        );
      } else {
        console.warn('[Capacity Manager] Auto-purge: no games to purge.');
      }
    } catch (purgeErr) {
      console.error(
        '[Capacity Manager] Auto-purge failed:',
        purgeErr instanceof Error ? purgeErr.message : String(purgeErr),
      );
    }
    return true;
  }

  /**
   * Wraps an async operation with automatic capacity management.
   * If the operation fails with a "no space left" error from MongoDB,
   * triggers the oldest-month purge and re-throws the original error.
   */
  private async executeWithCapacityGuard<T>(
    operation: () => Promise<T>,
    context: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const wasNoSpace = await this.handleNoSpaceError(error);
      if (wasNoSpace) {
        console.warn(
          `[Capacity Manager] ${context} failed due to no-space — purge triggered, re-throwing error.`,
        );
      }
      throw error;
    }
  }

  /**
   * Purges the oldest month of games from the database.
   * Finds the oldest year, then the oldest month within that year,
   * and deletes all games from that month.
   * Returns a report with the action taken.
   */
  async purgeOldestMonth(): Promise<{
    action: 'none' | 'purged';
    purgedYear?: number;
    purgedMonth?: number;
    deletedCount?: number;
    remainingYears?: number[];
  }> {
    try {
      const years = await this.getAvailableYears();

      if (years.length === 0) {
        console.info('[Capacity Manager] No games to purge.');
        return { action: 'none' };
      }

      const oldestYear = years[0].year;

      // Find the oldest month in that year using aggregation
      const monthResult = await this.gameModel
        .aggregate([
          {
            $match: {
              gameDate: {
                $gte: `${oldestYear}-01-01`,
                $lte: `${oldestYear}-12-31`,
              },
            },
          },
          {
            $group: {
              _id: {
                $substr: ['$gameDate', 5, 2], // Extract MM from YYYY-MM-DD
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } }, // Sort months ascending (01, 02, ..., 12)
          { $limit: 1 },
        ])
        .exec();

      if (monthResult.length === 0) {
        console.info(
          `[Capacity Manager] No games found in oldest year ${oldestYear}.`,
        );
        return { action: 'none' };
      }

      const oldestMonth = monthResult[0]._id; // "01", "02", etc.
      const gameCount = monthResult[0].count;

      console.info(
        `[Capacity Manager] Purging oldest month: ${oldestYear}-${oldestMonth} (${gameCount} games)...`,
      );

      // Delete all games from that month
      const startDate = `${oldestYear}-${oldestMonth}-01`;
      // Calculate last day of month
      const lastDay = new Date(
        oldestYear,
        parseInt(oldestMonth, 10),
        0,
      ).getDate();
      const endDate = `${oldestYear}-${oldestMonth}-${lastDay.toString().padStart(2, '0')}`;

      const deleteResult = await this.gameModel.deleteMany({
        gameDate: { $gte: startDate, $lte: endDate },
      });

      const deletedCount = deleteResult.deletedCount || 0;
      console.info(
        `[Capacity Manager] Deleted ${deletedCount} games from ${oldestYear}-${oldestMonth}.`,
      );

      // Get remaining years for the report
      const remainingYears = (await this.getAvailableYears()).map(
        (y) => y.year,
      );

      return {
        action: 'purged',
        purgedYear: oldestYear,
        purgedMonth: parseInt(oldestMonth, 10),
        deletedCount,
        remainingYears,
      };
    } catch (error) {
      console.error(
        '[Capacity Manager] Error purging oldest month:',
        error instanceof Error ? error.message : String(error),
      );
      return { action: 'none' };
    }
  }

  async checkLeagueGamesAvailability() {
    if (this.isCheckingAvailability) {
      console.info('checkLeagueGamesAvailability is already running.');
      return;
    }

    this.isCheckingAvailability = true;
    try {
      const allLeagues = Object.values(League);
      for (const league of allLeagues) {
        try {
          // check if the league

          if (await isCurrentSeason(league)) {
            // fetch all the games for the next 7 days for the league
            const today = new Date();
            const sevenDaysLater = new Date();
            sevenDaysLater.setDate(today.getDate() + 7);
            const games = await this.gameModel
              .find({
                league,
                gameDate: {
                  $gte: readableDate(today),
                  $lte: readableDate(sevenDaysLater),
                },
              })
              .lean()
              .exec();
            const numberOfTeams = await this.teamService.countByLeague(league);
            if (games.length < numberOfTeams * 0.3) {
              const oneHourAgo = new Date();
              oneHourAgo.setHours(oneHourAgo.getHours() - 1);
              let recentRefreshes = [] as any[];
              if (
                this.refreshTimestampService &&
                typeof this.refreshTimestampService.getManualTimestampsSince ===
                  'function'
              ) {
                recentRefreshes =
                  await this.refreshTimestampService.getManualTimestampsSince(
                    league,
                    oneHourAgo,
                  );
              }
              if (recentRefreshes && recentRefreshes.length >= 2) {
                console.info(
                  `Skipping refresh for ${league} because it has already been refreshed ${recentRefreshes.length} times in the last hour.`,
                );
                continue;
              }

              await this.getLeagueGames({
                league,
                forceUpdate: true,
                skipCascade: false,
                maxRecall: 5,
              });
            } else {
              console.info(
                `Found ${games.length} games for league ${league} in the next 7 days. No refresh needed.`,
              );
            }
          } else {
            console.info(
              `Skipping availability check for ${league} as it is not in current season.`,
            );
            continue;
          }
        } catch (error) {
          console.error(`Error checking availability for ${league}:`, error);
        }
      }
    } finally {
      this.isCheckingAvailability = false;
    }
  }

  async getOldiesGames(yearStr?: string, leagueParam?: string) {
    const currentYear = new Date().getFullYear();
    const minYear = currentYear - this.maxYearBeforeDelete;

    let years: number[];
    if (yearStr === undefined || yearStr === null || yearStr.trim() === '') {
      // No year specified -> loop over the last N seasons (years), from the
      // last finished year to the oldest allowed by the historical limit.
      // The current year is excluded: it is still in progress and already
      // covered by the normal refresh (getLeagueGames / rotation cron).
      // Use the endpoint with an explicit ?year= to force the current year.
      years = [];
      for (let y = currentYear - 1; y > minYear; y--) {
        years.push(y);
      }
    } else {
      const targetYear = parseInt(yearStr, 10);

      // Security check: the year must be valid, not in the future,
      // and not older than the allowed historical limit
      if (
        isNaN(targetYear) ||
        targetYear > currentYear ||
        targetYear < minYear
      ) {
        throw new HttpException(
          `The year parameter must be a valid year between ${minYear} and ${currentYear}`,
          400,
        );
      }
      years = [targetYear];
    }

    // 1. Retrieve all teams to infer the leagues
    let teams = await this.teamService.findAll();
    if (!teams.length) {
      teams = (await this.teamService.getTeams()) || [];
    }

    let leagues = Array.from(new Set(teams.map((team) => team.league)));

    // Filter leagues if a specific league query parameter is provided
    if (leagueParam) {
      const normalizedLeague = leagueParam.toUpperCase().trim();
      // Validate against the League enum instead of checking if teams exist in DB
      if (!Object.values(League).includes(normalizedLeague as League)) {
        throw new HttpException(`League ${normalizedLeague} not found`, 404);
      }
      leagues = [normalizedLeague];
    }

    const yearsLabel =
      years.length > 1 ? `years ${years.join(', ')}` : `the year ${years[0]}`;
    console.info(
      `[Oldies] Starting data recovery for ${yearsLabel} ${leagueParam ? `(League: ${leagueParam})` : ''}...`,
    );

    // 2. Loop through the leagues and the requested years
    // Track years where games were actually added (added > 0) for the response message
    const yearsWithAdditions: number[] = [];
    const totalSteps = leagues.length * years.length;
    let completedSteps = 0;
    for (const league of leagues) {
      for (const year of years) {
        console.info(
          `[Oldies] Fetching league ${league} for the year ${year}...`,
        );

        try {
          // Call getLeagueGames passing the specific season parameter.
          // addMissingOnly ensures we never overwrite existing matches (only insert missing ones..
          const result = await this.getLeagueGames({
            league,
            forceUpdate: true,
            skipCascade: true, // true to avoid concurrent refresh conflicts
            season: year,
            addMissingOnly: true, // Oldies: do not overwrite, only add missing games.
          });
          // Track years where at least one game was actually added
          if (
            result &&
            typeof result === 'object' &&
            'added' in result &&
            result.added > 0
          ) {
            yearsWithAdditions.push(year);
          }
        } catch (error) {
          console.error(`[Oldies] Error for ${league} in ${year}:`, error);
        } finally {
          completedSteps++;
          const pct = Math.round((completedSteps / totalSteps) * 100);
          console.info(
            `[Oldies] progress: ${pct}% (${completedSteps}/${totalSteps}) — last: ${league} ${year}`,
          );
        }
      }
    }

    console.info('[Oldies] History data recovery completed!');

    // Build the response message: only list years where games were actually added
    const addedYearsLabel =
      yearsWithAdditions.length > 1
        ? `years ${yearsWithAdditions.join(', ')}`
        : yearsWithAdditions.length === 1
          ? `the year ${yearsWithAdditions[0]}`
          : null;

    const message = addedYearsLabel
      ? `History recovery for ${addedYearsLabel} ${leagueParam ? `for league ${leagueParam}` : ''} started successfully.`
      : `History recovery ${leagueParam ? `for league ${leagueParam}` : ''} completed — no new games were added (all years already up to date).`;

    return {
      message,
      yearsWithAdditions,
    };
  }
}
