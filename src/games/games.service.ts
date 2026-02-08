import { HttpException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DeleteResult } from 'mongodb';
import * as mongoose from 'mongoose';
import { Model } from 'mongoose';
import { TeamService } from '../teams/teams.service';
import { addHours, readableDate } from '../utils/date';
import { League } from '../utils/enum';
import {
  getESPNScores,
  getTeamsSchedule,
} from '../utils/fetchData/espnAllData';
import { HockeyData } from '../utils/fetchData/hockeyData';
import { TeamType } from '../utils/interface/team';
import { needRefresh, randomNumber } from '../utils/utils';
import { CreateGameDto } from './dto/create-game.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { Game } from './schemas/game.schema';

@Injectable()
export class GameService {
  private isFetchingGames: boolean = false;
  private leagueRefreshTimestamps: { [league: string]: Date[] } = {};
  constructor(
    @InjectModel(Game.name) public gameModel: Model<Game>,
    private readonly teamService: TeamService,
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
    const logos = {};
    for (const { abbrev, teamLogo } of teams) {
      logos[abbrev] = teamLogo;
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
      homeTeamLogo: homeTeam?.teamLogo || game.homeTeamLogo,
      homeTeamLogoDark: homeTeam?.teamLogoDark || game.homeTeamLogoDark,
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

  async getLeagueGames(league: string, forceUpdate = false): Promise<any> {
    if (this.isFetchingGames) {
      console.info(`getLeagueGames is already running.`);
      return;
    }
    if (!forceUpdate) {
      const game = await this.findByLeague(league, 1);
      if (!needRefresh(league, game)) {
        console.info(`No need to refresh games for league ${league}.`);
        return;
      }
    }

    const now = new Date();
    const timestamps = this.leagueRefreshTimestamps[league] || [];

    // Filter out timestamps not from today
    const today = now.toISOString().split('T')[0];
    const todayTimestamps = timestamps.filter(
      (ts) => ts.toISOString().split('T')[0] === today,
    );

    if (forceUpdate && todayTimestamps.length >= 2) {
      throw new HttpException(
        `Refresh for league ${league} is limited to 2 times per day.`,
        249,
      );
    }

    // Add current timestamp
    this.leagueRefreshTimestamps[league] = [...todayTimestamps, now];

    this.isFetchingGames = true; // Set the flag to true
    const teams = await this.teamService.findByLeague(league);
    let currentGames = {};
    const leagueLogos = await this.getTeamsLogo(teams);

    try {
      if (league === League.PWHL) {
        const hockeyData = new HockeyData();
        currentGames = await hockeyData.getHockeySchedule(
          teams,
          leagueLogos,
          league,
        );
      } else {
        currentGames = await getTeamsSchedule(teams, league, leagueLogos);
      }
    } catch (error) {
      console.error(`Error fetching games for league ${league}:`, error);
      if (league === League.NHL) {
        try {
          const hockeyData = new HockeyData();
          currentGames = await hockeyData.getHockeySchedule(
            teams,
            leagueLogos,
            league,
          );
        } catch (error) {
          console.error('Error fetching NHL data:', error);
        }
      }
    }
    try {
      if (Object.keys(currentGames).length) {
        for (const team of teams) {
          await this.unactivateGames(team.uniqueId);
        }
      }
      let updateNumber = 0;
      for (const team in currentGames) {
        const games = currentGames[team] || [];
        if (games.length) {
          for (const game of games) {
            game.updateDate = new Date().toISOString();
            try {
              await this.create(game);
            } catch (error) {
              console.error({ error });
            }
          }
        }
        updateNumber++;
        console.info(
          'updated:',
          team,
          '(',
          updateNumber,
          '/',
          teams.length,
          ')',
        );
      }
      this.removeDuplicatesAndOlds();
      return currentGames;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('An unknown error occurred');
    } finally {
      this.isFetchingGames = false; // Reset the flag when the method finishes
    }
  }

  async getAllGames(): Promise<Game[]> {
    let currentGames = {};
    let teams = await this.teamService.findAll();
    if (!teams.length) {
      teams = await this.teamService.getTeams();
    }
    const leagues = Array.from(new Set(teams.map((team) => team.league)));

    for (const league of leagues) {
      currentGames = {
        ...currentGames,
        ...(await this.getLeagueGames(league, false)),
      };
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

  async findByTeam(teamSelectedId: string, needRefreshData = true) {
    const games = await this.filterGames({ teamSelectedIds: teamSelectedId });
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
      keys.length === 1 &&
      !games[keys[0]]?.[0]?.awayTeamShort
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
          await this.getLeagueGames(league, true);
        }
      }
      return this.filterGames({ teamSelectedIds: teamSelectedId });
    }

    return games;
  }

  async findByLeague(league: string, maxResults?: number) {
    return this.filterGames({ league: league, maxResults, selectedTeam: true });
  }

  async filterGames({
    startDate = undefined,
    endDate = undefined,
    teamSelectedIds = undefined,
    league = undefined,
    maxResults = undefined,
    selectedTeam = undefined,
  }) {
    const filter: any = { isActive: true };

    if (selectedTeam !== undefined) {
      filter.selectedTeam = selectedTeam;
    }

    if (startDate) {
      filter.gameDate = { $gte: startDate };
    } else {
      startDate = readableDate(new Date());
    }

    if (endDate) {
      filter.gameDate = { ...filter.gameDate, $lte: endDate };
    } else {
      endDate = readableDate(new Date());
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

    const filtredGames = await this.gameModel
      .find(filter)
      .sort({ startTimeUTC: 1 })
      .limit(maxResults ? Number.parseInt(maxResults, 10) : 0)
      .lean()
      .exec();

    const teams = await this.teamService.findAll();
    const teamsMap = new Map(teams.map((t) => [t.uniqueId, t]));

    const games = Array.isArray(filtredGames)
      ? filtredGames.map((game: any) =>
          this._enrichGameWithTeamData(game, teamsMap),
        )
      : [];
    const gamesByDay = {};
    const uniqueTeamSelectedIds = this.getTeams(teamSelectedIds, games);
    const dates = games.map((game) => new Date(game.gameDate));
    let minDate = new Date(Math.min(...dates.map((date) => date.getTime())));
    let maxDate = new Date(Math.max(...dates.map((date) => date.getTime())));
    minDate = new Date(startDate) > minDate ? minDate : new Date(startDate);
    maxDate = new Date(endDate) < maxDate ? maxDate : new Date(endDate);

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
        if (!gameOfDay.length && !league) {
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
      if ((league && gamesOfDay.length) || !league) {
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
      if (gameDate >= yesterdayString) {
        for (const currentLeague of Object.values(League)) {
          const filtredGames = games.filter(
            ({ isActive, awayTeamId, league }) => {
              return (
                isActive === true &&
                awayTeamId !== undefined &&
                awayTeamId !== '' &&
                league.toUpperCase() === currentLeague.toUpperCase()
              );
            },
          );

          const gamesIndex = randomNumber(filtredGames.length - 1);
          const randomGames = filtredGames[gamesIndex];
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          if (new Date(randomGames?.updateDate) < yesterday) {
            await this.getLeagueGames(currentLeague, false);
          }
        }
      }

      const teams = await this.teamService.findAll();
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

  update(uniqueId: string, updateGameDto: UpdateGameDto) {
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
    const games = await this.gameModel.find().exec();
    const tenMonthsAgo = new Date();
    tenMonthsAgo.setMonth(tenMonthsAgo.getMonth() - 10);
    const oldGames = games.filter(
      ({ startTimeUTC, homeTeamScore, awayTeamScore }) => {
        const isOld = new Date(startTimeUTC) < tenMonthsAgo;
        const hasScore =
          homeTeamScore !== null &&
          homeTeamScore !== undefined &&
          awayTeamScore !== null &&
          awayTeamScore !== undefined;
        return isOld && !hasScore;
      },
    );
    for (const oldGame of oldGames) {
      await this.remove(oldGame.uniqueId);
    }
    const duplicates = [];

    const gameMap = new Map();

    for (const game of games) {
      const key = `${game.teamSelectedId}-${game.startTimeUTC}`;
      if (gameMap.has(key)) {
        const existing = gameMap.get(key);
        const existingHasScore =
          existing.homeTeamScore !== null &&
          existing.homeTeamScore !== undefined &&
          existing.awayTeamScore !== null &&
          existing.awayTeamScore !== undefined;
        const currentHasScore =
          game.homeTeamScore !== null &&
          game.homeTeamScore !== undefined &&
          game.awayTeamScore !== null &&
          game.awayTeamScore !== undefined;

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
    const games = await this.findByTeam(teamId, false);
    const now = new Date();

    for (const date in games) {
      if (Array.isArray(games[date])) {
        for (const game of games[date]) {
          if (!game.awayTeamShort) continue;

          const gameTime = new Date(game.startTimeUTC);
          if (gameTime < now) {
            continue;
          }
          game.isActive = false;
          await this.create(game);
        }
      }
    }
  }

  async fetchGamesWithoutScores(): Promise<Game[]> {
    const twoHoursAndHalfAgo = new Date();
    twoHoursAndHalfAgo.setHours(twoHoursAndHalfAgo.getHours() - 2);
    twoHoursAndHalfAgo.setMinutes(twoHoursAndHalfAgo.getMinutes() - 30);

    // match started at least 3 hours ago and score is null or missing
    const gamesWithoutScores = await this.gameModel
      .find({
        startTimeUTC: { $lte: twoHoursAndHalfAgo.toISOString() },
        $or: [{ homeTeamScore: null }, { awayTeamScore: null }],
      })
      .exec();
    return gamesWithoutScores;
  }

  async fetchGamesScores(): Promise<any[]> {
    const gamesWithoutScores = await this.fetchGamesWithoutScores();
    const postponedGamesLeagues = new Set<string>();
    // number of games without scores is available in `gamesWithoutScores.length`

    // Group needed updates by League AND Date
    const tasks = new Map<string, Set<string>>();

    gamesWithoutScores.forEach((game) => {
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
            // ignore fetch errors for ESPN
          }
        }
      }
    }

    // Now try to update matching games in DB before returning
    const appliedUpdates: any[] = [];
    const leaguesToUpdate = new Set<string>();

    for (const score of results) {
      if (score.league) {
        leaguesToUpdate.add(score.league);
      }
      if (score.homeTeamRecord && score.homeTeamId) {
        await this.teamService.updateRecord(
          score.homeTeamId,
          score.homeTeamRecord,
        );
      }
      if (score.awayTeamRecord && score.awayTeamId) {
        await this.teamService.updateRecord(
          score.awayTeamId,
          score.awayTeamRecord,
        );
      }
    }

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
          const from = new Date(start.getTime() - 5 * 60 * 1000).toISOString();
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
                },
                { new: true },
              )
              .lean()
              .exec();
            if (updated) {
              (updated as any).homeTeamRecord = score.homeTeamRecord;
              (updated as any).awayTeamRecord = score.awayTeamRecord;
              appliedUpdates.push(updated);
            }
          }
        }
      } catch (err) {
        // ignore update errors
      }
    }

    for (const league of leaguesToUpdate) {
      await this.teamService.getTeams(league);
    }
    for (const league of postponedGamesLeagues) {
      await this.getLeagueGames(league, true);
    }

    return appliedUpdates.length ? appliedUpdates : results;
  }

  async findByDateHour(gameDate: string) {
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
      return {};
    } else {
      if (gameDate >= yesterdayString) {
        for (const currentLeague of Object.values(League)) {
          const filtredGames = games.filter(
            ({ isActive, awayTeamId, league }) => {
              return (
                isActive === true &&
                awayTeamId !== undefined &&
                awayTeamId !== '' &&
                league.toUpperCase() === currentLeague.toUpperCase()
              );
            },
          );

          const gamesIndex = randomNumber(filtredGames.length - 1);
          const randomGames = filtredGames[gamesIndex];
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          if (new Date(randomGames?.updateDate) < yesterday) {
            await this.getLeagueGames(currentLeague, false);
          }
        }
      }

      const teams = await this.teamService.findAll();
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
}
