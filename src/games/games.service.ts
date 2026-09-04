import { HttpException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DeleteResult } from 'mongodb';
import * as mongoose from 'mongoose';
import { Model } from 'mongoose';
import { TeamService } from '../teams/teams.service';
import { addHours, readableDate } from '../utils/date';
import { CollegeLeague, League } from '../utils/enum';
import {
  getESPNGameScore,
  getESPNScores,
  getTeamsSchedule,
} from '../utils/fetchData/espnAllData';
import { HockeyData } from '../utils/fetchData/hockeyData';
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
  private refreshChain: Promise<any> = Promise.resolve();
  constructor(
    @InjectModel(Game.name) public gameModel: Model<Game>,
    private readonly teamService: TeamService,
    private readonly refreshTimestampService: RefreshTimestampService,
  ) {}

  maxYearBeforeDelete = 10;
  // Purge games that are still active/resolved-less several months after their start
  // (e.g. a PWHL game stuck on 2026-05-11 whose final result can never be fetched).
  staleGameMaxAgeDays = 90;

  // Capacity-based purge configuration
  private readonly DISK_USAGE_THRESHOLD = 0.9; // 90%
  private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private lastDiskCheck = 0;

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

  private _enrichGameWithTeamData(game: any, teamsMap: Map<string, TeamType>) {
    const homeTeam = teamsMap.get(game.homeTeamId);
    const awayTeam = teamsMap.get(game.awayTeamId);
    const isPlayoffs =
      (game.seriesSummary || game.seriesStatus) &&
      !game.seriesSummary?.toLowerCase().includes('regular season');

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
      homeTeamColor: homeTeam?.color,
      homeTeamBackgroundColor: homeTeam?.backgroundColor,
      awayTeam: awayTeam?.label || game.awayTeam,
      awayTeamShort: awayTeam?.abbrev || game.awayTeamShort,
      awayTeamLogo: awayTeam?.teamLogo || game.awayTeamLogo,
      awayTeamLogoDark: awayTeam?.teamLogoDark || game.awayTeamLogoDark,
      awayTeamColor: awayTeam?.color,
      awayTeamBackgroundColor: awayTeam?.backgroundColor,
    };
  }

  async create(gameDto: CreateGameDto | UpdateGameDto): Promise<Game> {
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
      // league's upcoming games if the process dies before saving (see empty fetch guardabove)..
      // A fetch returning 0 games never triggers a deactivation (guard below)..
      if (!season && uniqueGames && uniqueGames.length > 0) {
        const freshIds = new Set(
          uniqueGames
            .map((g: any) => g?.uniqueId)
            .filter((id: any) => !!id),
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
              { uniqueId: 1, _id: 0 },
            )
            .lean()
            .exec()) as Array<{ uniqueId?: string }>;

          const staleFutureIds = existingFuture
            .map((g) => g.uniqueId)
            .filter((id) => id && !freshIds.has(id));

          if (staleFutureIds.length > 0) {
            await this.gameModel.updateMany(
              {
                league: normalizedLeague,
                uniqueId: { $in: staleFutureIds },
                isActive: true,
                startTimeUTC: { $gt: now.toISOString() },
              },
              { $set: { isActive: false } },
            );
            console.info(
              `[Games] Deactivated ${staleFutureIds.length} stale future games for ${normalizedLeague} (no longer in freshly fetched season).`,
            );
          }
        }
      }

      if (uniqueGames && uniqueGames.length > 0) {
        // Oldies recovery: only ever add missing games without overwriting an existing match.
        // A game is considered "already present" (same game) only when its uniqueId matches
        // AND both the home and the away scores match the stored ones.
        // Otherwise we refresh it with the fresh (more complete) data.
        let existingResults = new Map<
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
        for (const game of uniqueGames) {
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
              continue;
            }
            // Past games are accepted even with null scores; cron will fill them later via fetchGamesScores()
          }

          await this.create(game);
          added++;
        }

        if (addMissingOnly) {
          console.info(
            `[Oldies] ${normalizedLeague} ${season ? `(season ${season})` : ''}: added ${added}, skipped (existing identical) ${skippedExisting}, skipped (missing team/score data) ${skippedMissingTeamData}.`,
          );
        }
      }

      await this._deleteUnlinkedTeams(normalizedLeague);
      return games;
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

    for (const league of leaguesToRefresh) {
      let needRefresh = true;
      if (date) {
        needRefresh =
          (await isCurrentSeason(league, date)) ||
          (await isPlayoffsPeriod(league, date));
      }
      if (needRefresh) {
        await this.getLeagueGames({ league, forceUpdate, skipCascade: false });
      }
    }
    return this.findAll();
  }

  async findAll(): Promise<any[]> {
    const allGames = await this.gameModel
      .find({ isActive: true })
      .sort({ startTimeUTC: 1 })
      .lean()
      .exec();
    if (Object.keys(allGames).length === 0 || allGames?.length === 0) {
      console.info('No games found in DB. Fetching all games...');
      return this.getAllGames();
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

  async getDateRange() {
    const result = await this.gameModel.aggregate([
      {
        $match: {
          isActive: true,
          $expr: { $eq: ['$homeTeamId', '$teamSelectedId'] },
        },
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

  async findByTeam(
    teamSelectedId: string,
    startDate?: string,
    clean?: boolean,
    needRefreshData = true,
  ) {
    let games = await this.filterGames({
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
        if (games.length) {
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
      const allGames = await this.findAll();
      if (!allGames.length) {
        this.getAllGames();
      }
      return [];
    } else {
      const leaguesInGames = Array.from(
        new Set(games.map((g) => g.league).filter(Boolean)),
      );
      if (gameDate >= yesterdayString) {
        for (const currentLeague of leaguesInGames) {
          const filteredGamesForLeague = games.filter(
            ({ isActive, awayTeamId, league }) => {
              return (
                isActive === true &&
                awayTeamId !== undefined &&
                awayTeamId !== '' &&
                league?.toUpperCase() === currentLeague?.toUpperCase()
              );
            },
          );

          if (filteredGamesForLeague.length === 0) {
            continue;
          }
          if (
            !(await needRefresh(currentLeague, {
              data: filteredGamesForLeague,
            }))
          ) {
            continue;
          }

          this.refreshChain = this.refreshChain.then(() =>
            this.getLeagueGames({
              league: currentLeague,
              forceUpdate: false,
              skipCascade: false,
            }).catch((err) =>
              console.error(`Error refreshing ${currentLeague}`, err),
            ),
          );
        }
      }

      const teams = await this.teamService.findAll(
        leaguesInGames.length > 0 ? leaguesInGames : undefined,
      );
      const teamsMap = new Map(teams.map((t) => [t.uniqueId, t]));

      // avoid dupplicate games
      const filteredGames = games.filter(({ gameStatus, startTimeUTC }) => {
        const now = new Date();
        const isStartedForMoreThan12Hours =
          new Date(startTimeUTC) <
          new Date(now.getTime() - 12 * 60 * 60 * 1000);
        return (
          (gameStatus !== 'FINISHED' && !isStartedForMoreThan12Hours) ||
          gameStatus === 'FINISHED'
        );
      });
      return filteredGames.map((game: any) =>
        this._enrichGameWithTeamData(game, teamsMap),
      );
    }
  }

  async update(uniqueId: string, updateGameDto: Partial<UpdateGameDto>) {
    const filter = { uniqueId: uniqueId };
    return this.gameModel.updateOne(filter, updateGameDto);
  }
  async remove(uniqueId: string) {
    const filter = { uniqueId: uniqueId };
    const deleted = await this.gameModel.findOneAndDelete(filter).exec();
    return deleted;
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
    const hoursAgo = new Date();
    hoursAgo.setHours(hoursAgo.getHours() - hours);

    // Fetch games that are:
    // 1. Active
    // 2. Started at least `hours` ago
    // 3. NOT in a final/cancelled/postponed state
    // This will include games with partial scores (e.g., 3-0) that are still in progress,
    // and games with null scores that are in progress or should have started.
    return await this.gameModel
      .find({
        isActive: true,
        $or: [
          {
            startTimeUTC: { $lte: hoursAgo.toISOString() },
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
    let gamesToDelete = await this.fetchOldGamesWithMissingScores(72);

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

    await game.save();
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
      if (!skip) {
        const allGames = await this.findAll();
        if (!allGames.length) {
          if (leaguesList.length > 0) {
            await this.getAllGames(false, gameDate, leaguesList);
          } else {
            await this.getAllGames(false, gameDate);
          }
        }
      }
      return {};
    } else {
      if (gameDate === today) {
        const leaguesInGames = Array.from(
          new Set(games.map((g) => g.league).filter(Boolean)),
        );

        for (const currentLeague of leaguesInGames) {
          const filteredGamesForLeague = games.filter(
            ({ isActive, awayTeamId, league }) => {
              return (
                isActive === true &&
                awayTeamId !== undefined &&
                awayTeamId !== '' &&
                league?.toUpperCase() === currentLeague?.toUpperCase()
              );
            },
          );

          if (
            !(await needRefresh(currentLeague, {
              data: filteredGamesForLeague,
            }))
          ) {
            continue;
          }
          this.refreshChain = this.refreshChain.then(() =>
            this.getLeagueGames({
              league: currentLeague,
              forceUpdate: false,
              skipCascade: true,
            }).catch((err) =>
              console.error(`Error refreshing ${currentLeague}`, err),
            ),
          );
        }
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
          new Date(startTimeUTC) <
          new Date(now.getTime() - 12 * 60 * 60 * 1000);
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
  }

  private _resolveStatus(score: any): string {
    // Priority 0: Check for explicit postponement or cancellation in text fields
    // Sometimes APIs put postponement reasons in status detail, series summary, or records
    const postponementKeywords = [
      'POSTPONED',
      'RAIN',
      'DELAY',
      'TBD',
      'WEATHER',
    ];
    const cancellationKeywords = ['CANCELLED', 'CANCELED'];

    const statusTextFields = [
      typeof score.status === 'string' ? score.status : '',
      score.status?.detail,
      score.status?.type?.detail,
      score.seriesSummary,
      score.homeTeamRecord,
    ]
      .filter(Boolean)
      .map((s) => s.toUpperCase());

    if (
      statusTextFields.some((text) =>
        postponementKeywords.some((key) => text.includes(key)),
      )
    ) {
      return 'POSTPONED';
    }

    if (
      statusTextFields.some((text) =>
        cancellationKeywords.some((key) => text.includes(key)),
      )
    ) {
      return 'CANCELLED';
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

    // 5. Identify unlinked teams (pro leagues only) with zero existing games
    const unlinkedTeams = teams.filter(
      (team) => !usedTeamIds.has(team.uniqueId),
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
   * Calculates MongoDB disk usage inside Docker.
   * Returns { usedMB, totalMB, percentage (0-1) }
   */
  private async getDiskUsage(): Promise<{
    usedMB: number;
    totalMB: number;
    percentage: number;
  }> {
    try {
      // Try to get the disk space of the Docker volume
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      try {
        // For Docker/Linux: check the persistent volume
        const { stdout } = await execAsync(
          'df -B1M /data/db 2>/dev/null || df -B1M .',
        );
        const lines = stdout.trim().split('\n');
        const row = lines[1].split(/\s+/);
        const totalMB = parseInt(row[1], 10);
        const usedMBTotal = parseInt(row[2], 10);

        return {
          usedMB: usedMBTotal,
          totalMB,
          percentage: usedMBTotal / totalMB,
        };
      } catch {
        // Fallback: estimate usage via aggregate
        const sizeInfo = await (this.gameModel.collection as any)
          .aggregate([
            {
              $collStats: { storageStats: {} },
            },
          ])
          .toArray()
          .catch(() => []);

        if (sizeInfo && sizeInfo.length > 0) {
          const sizeMB = (sizeInfo[0].storageStats?.size || 0) / (1024 * 1024);
          return {
            usedMB: Math.round(sizeMB),
            totalMB: Math.round(sizeMB * 2), // Estimate
            percentage: 0.5,
          };
        }

        // Full fallback: return 0% (no purge if usage is uncertain)
        return { usedMB: 0, totalMB: 1, percentage: 0 };
      }
    } catch (error) {
      console.warn(
        '[Capacity Manager] Could not check disk usage:',
        error instanceof Error ? error.message : String(error),
      );
      // Full fallback: return 0% (no purge if usage is uncertain)
      return { usedMB: 0, totalMB: 1, percentage: 0 };
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
      // most recent to the oldest allowed by the historical limit.
      years = [];
      for (let y = currentYear; y > minYear; y--) {
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
      if (!leagues.includes(normalizedLeague)) {
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
    for (const league of leagues) {
      for (const year of years) {
        console.info(
          `[Oldies] Fetching league ${league} for the year ${year}...`,
        );

        try {
          // Call getLeagueGames passing the specific season parameter.
          // addMissingOnly ensures we never overwrite existing matches (only insert missing ones..
          await this.getLeagueGames({
            league,
            forceUpdate: true,
            skipCascade: true, // true to avoid concurrent refresh conflicts
            season: year,
            addMissingOnly: true, // Oldies: do not overwrite, only add missing games.
          });
        } catch (error) {
          console.error(`[Oldies] Error for ${league} in ${year}:`, error);
        }
      }
    }

    console.info('[Oldies] History data recovery completed!');
    return {
      message: `History recovery for ${yearsLabel} ${leagueParam ? `for league ${leagueParam}` : ''} started successfully.`,
    };
  }
}
