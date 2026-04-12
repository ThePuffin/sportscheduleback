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
      homeTeamRecord: homeTeam?.record || '',
      awayTeamRecord: awayTeam?.record || '',
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
        const now = new Date();
        const existingStartTime = existingGame.startTimeUTC
          ? new Date(existingGame.startTimeUTC)
          : null;
        const dtoStartTime = gameDto.startTimeUTC
          ? new Date(gameDto.startTimeUTC)
          : null;
        const isExistingGamePast =
          existingStartTime && existingStartTime.getTime() < now.getTime();
        const isDtoGamePast =
          dtoStartTime && dtoStartTime.getTime() < now.getTime();

        if (isExistingGamePast || isDtoGamePast) {
          return existingGame;
        }

        if (
          gameDto.homeTeamScore === null &&
          existingGame.homeTeamScore != null
        ) {
          delete gameDto.homeTeamScore;
        }
        if (
          gameDto.awayTeamScore === null &&
          existingGame.awayTeamScore != null
        ) {
          delete gameDto.awayTeamScore;
        }
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
        );
      } else {
        gamesObj = await getTeamsSchedule(
          leagueTeams,
          normalizedLeague,
          leagueLogos,
        );
      }

      // Flatten the games object into an array
      const games = Object.values(gamesObj).flat() as any[];

      if (games && games.length > 0) {
        for (const game of games) {
          game.updateDate = new Date().toISOString();
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
      const filteredGames = games.filter(({ homeTeamId, teamSelectedId }) => {
        return homeTeamId === teamSelectedId;
      });
      return filteredGames.map((game: any) =>
        this._enrichGameWithTeamData(game, teamsMap),
      );
    }
  }

  async update(uniqueId: string, updateGameDto: UpdateGameDto) {
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

  async fetchGamesWithoutScores(): Promise<Game[]> {
    const twoHoursAgo = new Date();
    twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);

    // match started at least 2 hours ago and score is null or missing
    const gamesWithoutScores = await this.gameModel
      .find({
        $or: [{ homeTeamScore: null }, { awayTeamScore: null }],
      })
      .exec();
    return gamesWithoutScores;
  }

  async fetchGamesScores(): Promise<any[]> {
    if (this.isFetchingScores) {
      console.info('fetchGamesScores is already running.');
      return [];
    }
    this.isFetchingScores = true;
    try {
      const gamesWithoutScores = await this.fetchGamesWithoutScores();

      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 36 * 60 * 60 * 1000);
      const gamesToDelete = gamesWithoutScores.filter(
        (game) => new Date(game.startTimeUTC) < oneDayAgo,
      );
      const gamesToProcess = gamesWithoutScores.filter(
        (game) => new Date(game.startTimeUTC) >= oneDayAgo,
      );

      for (const game of gamesToDelete) {
        if (Object.values(CollegeLeague).includes(game.league as any)) {
          await this.remove(game.uniqueId);
        }
      }

      const postponedGamesLeagues = new Set<string>();
      // number of games without scores is available in `gamesWithoutScores.length`

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
          if (league === League.PWHL) {
            const hockeyData = new HockeyData();
            try {
              const scoresPWHL = await hockeyData.getPWHLScores(date);
              if (Array.isArray(scoresPWHL)) {
                results.push(...scoresPWHL);
              }
            } catch (error) {
              // ignore fetch errors for PWHL
            }
          } else {
            try {
              const espnScores = await getESPNScores(league, date);
              if (Array.isArray(espnScores) && espnScores.length) {
                results.push(...espnScores);
              }
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
            if (individualScore?.isFinal) {
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

      for (const score of results) {
        try {
          const isPostponed =
            score.status === 'Postponed' ||
            score.status?.type?.name === 'STATUS_POSTPONED' ||
            score.status?.type?.detail?.includes('TBD');

          if (isPostponed) {
            postponedGamesLeagues.add(score.league);
          }
          if (!score.isFinal && !isPostponed) {
            continue;
          }

          // try to find by uniqueId exact first
          let game = null as any;
          if (score.uniqueId) {
            game = await this.gameModel
              .findOne({
                uniqueId: score.uniqueId,
                league: score.league,
                $or: [{ homeTeamScore: null }, { awayTeamScore: null }],
              })
              .exec();
          }
          // exact uniqueId match result available in `game`

          // try matching DB uniqueId that ends with ESPN id
          if (!game && score.uniqueId) {
            try {
              const regex = new RegExp(`${score.uniqueId}$`);
              game = await this.gameModel
                .findOne({
                  uniqueId: { $regex: regex },
                  league: score.league,
                  $or: [{ homeTeamScore: null }, { awayTeamScore: null }],
                })
                .exec();
            } catch (e) {
              // ignore regex errors
            }
            // uniqueId suffix match result available in `game`
          }

          // fallback: match by home/away ids + gameDate (allow using team shorts when ids missing)
          if (!game && (score.startTimeUTC || score.gameDate)) {
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
              game = await this.gameModel
                .findOne({
                  homeTeamId: candidateHomeId,
                  awayTeamId: candidateAwayId,
                  gameDate,
                  league: score.league,
                  isActive: true,
                  $or: [{ homeTeamScore: null }, { awayTeamScore: null }],
                })
                .exec();
            }
            // teams+date match result available in `game`
            // skipped teams+date match when ids missing
          }

          // additional fallback: match by home/away short codes + gameDate when ids/league missing
          if (
            !game &&
            (score.startTimeUTC || score.gameDate) &&
            score.homeTeamShort &&
            score.awayTeamShort
          ) {
            const gameDate =
              score.gameDate || readableDate(new Date(score.startTimeUTC));
            try {
              game = await this.gameModel
                .findOne({
                  homeTeamShort: score.homeTeamShort,
                  awayTeamShort: score.awayTeamShort,
                  gameDate,
                  league: score.league,
                  isActive: true,
                  $or: [{ homeTeamScore: null }, { awayTeamScore: null }],
                })
                .exec();
            } catch (e) {
              // ignore
            }
          }

          if (
            !game &&
            score.startTimeUTC &&
            score.homeTeamId &&
            score.awayTeamId
          ) {
            const start = new Date(score.startTimeUTC);
            const from = new Date(
              start.getTime() - 5 * 60 * 1000,
            ).toISOString();
            const to = new Date(start.getTime() + 5 * 60 * 1000).toISOString();
            game = await this.gameModel
              .findOne({
                startTimeUTC: { $gte: from, $lte: to },
                homeTeamId: score.homeTeamId,
                awayTeamId: score.awayTeamId,
                isActive: true,
                league: score.league,
                $or: [{ homeTeamScore: null }, { awayTeamScore: null }],
              })
              .exec();
          }

          if (game) {
            if (isPostponed) {
              await this.remove(game.uniqueId);
              continue;
            }

            const needsUpdate =
              game.homeTeamScore === null ||
              game.homeTeamScore === undefined ||
              game.awayTeamScore === null ||
              game.awayTeamScore === undefined;
            if (needsUpdate) {
              const updated = await this.gameModel
                .findOneAndUpdate(
                  { _id: game._id },
                  {
                    homeTeamScore: score.homeTeamScore,
                    awayTeamScore: score.awayTeamScore,
                    isActive: true,
                    updateDate: new Date().toISOString(),
                    gameClock: score.gameClock,
                    gamePeriod: score.gamePeriod,
                    gameStatus:
                      score.gameStatus === 'SCHEDULED'
                        ? 'FINISHED'
                        : score.gameStatus,
                  },
                  { new: true },
                )
                .lean()
                .exec();
              if (updated) {
                if (score.homeTeamRecord && game.homeTeamId) {
                  await this.teamService.updateRecord(
                    game.homeTeamId,
                    score.homeTeamRecord,
                  );
                }
                if (score.awayTeamRecord && game.awayTeamId) {
                  await this.teamService.updateRecord(
                    game.awayTeamId,
                    score.awayTeamRecord,
                  );
                }
                updated.homeTeamRecord = score.homeTeamRecord;
                updated.awayTeamRecord = score.awayTeamRecord;
                appliedUpdates.push(updated);
              }
            }
          }
        } catch (err) {
          // ignore update errors
        }
      }

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

      return appliedUpdates.length ? appliedUpdates : results;
    } catch (error) {
      console.error('Error fetching games scores:', error);
      return [];
    } finally {
      this.isFetchingScores = false;
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
      } else {
        espnGames.push(game);
      }
    }

    if (pwhlGames.length > 0) {
      const dates = new Set<string>();
      pwhlGames.forEach((g) => {
        if (g.gameDate) dates.add(g.gameDate);
      });
      const hockeyData = new HockeyData();
      for (const date of dates) {
        try {
          const scores = await hockeyData.getPWHLScores(date);
          if (Array.isArray(scores)) {
            allScores.push(...scores);
          }
        } catch (error) {
          console.error(`Error fetching PWHL scores for ${date}:`, error);
        }
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
        game.homeTeamScore = matchedScore.homeTeamScore;
        game.awayTeamScore = matchedScore.awayTeamScore;
        game.isActive =
          matchedScore.isActive === undefined
            ? game.isActive
            : matchedScore.isActive;

        game.updateDate = new Date().toISOString();

        game.gameClock = matchedScore.gameClock;
        game.gamePeriod = matchedScore.gamePeriod;

        // Only update gameStatus from API data, don't resolve to FINISHED
        // FINISHED status is only assigned in fetchGamesScores()
        if (matchedScore.gameStatus) {
          game.gameStatus = matchedScore.gameStatus;
        }

        updatedGames.push(game);
      } else {
        updatedGames.push(game);
      }
    }

    return updatedGames;
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
      const filteredGames = games.filter(({ homeTeamId, teamSelectedId }) => {
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
    // Priority 1: Check if game is truly finished
    if (score.isFinal) {
      return 'FINISHED';
    }

    // Priority 2: If API provides explicit game status (like "1st", "Top", "Bot", etc.), use it
    if (score.gameStatus) {
      const gameStatus = score.gameStatus.toUpperCase();
      // Game status indicators that mean the game is in progress
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
      if (gameStatus.includes('FINAL') || gameStatus.includes('ENDED')) {
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
        // Check if postponed
        if (
          score.status?.type?.name === 'STATUS_POSTPONED' ||
          score.status?.type?.detail?.includes('TBD')
        ) {
          return 'POSTPONED';
        }
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
    if (score.homeTeamScore != null && score.awayTeamScore != null) {
      return 'IN_PROGRESS';
    }

    // Default: Scheduled
    return 'SCHEDULED';
  }
}
