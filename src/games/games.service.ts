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
import { needRefresh } from '../utils/utils';
import { CreateGameDto } from './dto/create-game.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { RefreshTimestampService } from './refresh-timestamps.service';
import { Game } from './schemas/game.schema';

@Injectable()
export class GameService {
  private isFetchingGames: { [league: string]: boolean } = {};
  private manualRefreshInProgress: { [league: string]: boolean } = {};
  private isFetchingScores: boolean = false;
  private refreshChain: Promise<any> = Promise.resolve();
  constructor(
    @InjectModel(Game.name) public gameModel: Model<Game>,
    private readonly teamService: TeamService,
    private readonly refreshTimestampService: RefreshTimestampService,
  ) {}

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
    return {
      ...game,
      homeTeamRecord:
        game.seriesSummary || game.homeTeamRecord || homeTeam?.record || '',
      awayTeamRecord:
        game.seriesStatus ||
        game.seriesSummary ||
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

  async getLeagueGames(
    league: string,
    forceUpdate = false,
    skipCascade = false,
  ): Promise<any> {
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

      const now = new Date();

      if (!forceUpdate) {
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
          !needRefresh(normalizedLeague, { data: gamesForLeague })
        ) {
          return; // Skip silently, data is fresh
        }
      }

      if (forceUpdate) {
        const todayTimestamps =
          await this.refreshTimestampService.getTodayManualTimestamps(
            normalizedLeague,
          );
        if (todayTimestamps.length >= 2) {
          throw new HttpException(
            `Refresh for league ${normalizedLeague} is limited to 2 times per day.`,
            249,
          );
        }
      }

      console.info(
        `Data for ${normalizedLeague} is stale. Refreshing in background...`,
      );

      // Add current timestamp
      await this.refreshTimestampService.addTimestamp(
        normalizedLeague,
        forceUpdate ? 'manual' : 'auto',
      );

      const todayStr = readableDate(now);
      await this.gameModel.updateMany(
        {
          league: normalizedLeague,
          gameDate: { $gte: todayStr },
          isActive: true,
        },
        { $set: { isActive: false } },
      );

      // Fetch teams and logos for the league
      const leagueTeams = await this.teamService.findAll([normalizedLeague]);
      const leagueLogos = await this.getTeamsLogo(leagueTeams);

      let gamesObj = {};
      if (normalizedLeague === League.PWHL) {
        const hockeyData = new HockeyData();
        gamesObj = await hockeyData.getHockeySchedule(
          leagueTeams,
          leagueLogos,
          normalizedLeague,
          forceUpdate,
        );
      } else {
        gamesObj = await getTeamsSchedule(
          leagueTeams,
          normalizedLeague,
          leagueLogos,
          forceUpdate,
        );
      }

      // Flatten the games object into an array
      const games = Object.values(gamesObj).flat() as any[];

      if (games && games.length > 0) {
        for (const game of games) {
          game.updateDate = new Date().toISOString();
          game.isActive = true;
          await this.create(game);
        }
      }
      return games;
    } finally {
      this.isFetchingGames[normalizedLeague] = false;
      if (skipCascade) {
        this.manualRefreshInProgress[normalizedLeague] = false;
      }
    }
  }

  async getAllGames(forceUpdate = false): Promise<Game[]> {
    let teams = await this.teamService.findAll();
    if (!teams.length) {
      console.info('No teams found in DB. Fetching teams...');
      teams = (await this.teamService.getTeams()) || [];
    }
    const leagues = Array.from(new Set(teams.map((team) => team.league)));

    for (const league of leagues) {
      await this.getLeagueGames(league, forceUpdate, false);
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
      { $match: { isActive: true } },
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
          await this.getLeagueGames(league, false);
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
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      startDate = readableDate(oneYearAgo);
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
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      startDate = readableDate(oneYearAgo);
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
          if (!needRefresh(currentLeague, { data: filteredGamesForLeague })) {
            continue;
          }

          this.refreshChain = this.refreshChain.then(() =>
            this.getLeagueGames(currentLeague, false).catch((err) =>
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
      const filteredGames = games
        .filter(({ gameStatus, startTimeUTC }) => {
          const now = new Date();
          const isStartedForMoreThan12Hours =
            new Date(startTimeUTC) <
            new Date(now.getTime() - 12 * 60 * 60 * 1000);
          return (
            (gameStatus !== 'FINISHED' && !isStartedForMoreThan12Hours) ||
            gameStatus === 'FINISHED'
          );
        })
        .filter(({ homeTeamId, teamSelectedId }) => {
          return homeTeamId === teamSelectedId;
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

    const tenMonthsAgo = new Date();
    tenMonthsAgo.setMonth(tenMonthsAgo.getMonth() - 10);

    // 1. Delete games older than 10 months directly in DB for efficiency
    const deleteResult = await this.gameModel.deleteMany({
      startTimeUTC: { $lt: tenMonthsAgo.toISOString() },
    });
    console.info(
      `Deleted ${deleteResult.deletedCount} games older than 10 months.`,
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
                `[fetchGamesScores] Erreur lors de la récupération PWHL pour ${date}:`,
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
          await this.getLeagueGames(league, true);
        }
      }

      await this.fixScoreIssue();
      await this.removeOldGamesWithoutScore();

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
          this.getAllGames();
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

          if (!needRefresh(currentLeague, { data: filteredGamesForLeague })) {
            continue;
          }
          this.refreshChain = this.refreshChain.then(() =>
            this.getLeagueGames(currentLeague, false, true).catch((err) =>
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
      const filteredGames = games
        .filter(({ gameStatus, startTimeUTC }) => {
          const now = new Date();
          const isStartedForMoreThan12Hours =
            new Date(startTimeUTC) <
            new Date(now.getTime() - 12 * 60 * 60 * 1000);
          return (
            (gameStatus !== 'FINISHED' && !isStartedForMoreThan12Hours) ||
            gameStatus === 'FINISHED'
          );
        })
        .filter(({ homeTeamId, teamSelectedId }) => {
          return homeTeamId === teamSelectedId;
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
}
