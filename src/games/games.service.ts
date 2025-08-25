import { HttpException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DeleteResult } from 'mongodb';
import * as mongoose from 'mongoose';
import { Model } from 'mongoose';
import { TeamService } from '../teams/teams.service';
import { readableDate } from '../utils/date';
import { League } from '../utils/enum';
import { getTeamsSchedule } from '../utils/fetchData/espnAllData';
import { HockeyData } from '../utils/fetchData/hockeyData';
import { TeamType } from '../utils/interface/team';
import { randomNumber } from '../utils/utils';
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
    teams.forEach(({ abbrev, teamLogo }) => {
      logos[abbrev] = teamLogo;
    });

    return logos;
  }

  async create(gameDto: CreateGameDto | UpdateGameDto): Promise<Game> {
    const { uniqueId } = gameDto;

    if (uniqueId) {
      const existingGame = await this.findOne(uniqueId);
      if (existingGame) {
        Object.assign(existingGame, gameDto);
        return await existingGame.save();
      }
    }

    const newGame = new this.gameModel(gameDto);
    return await newGame.save();
  }

  async getLeagueGames(league: string): Promise<any> {
    if (this.isFetchingGames) {
      console.info(`getLeagueGames is already running.`);
      return;
    }

    const now = new Date();
    const timestamps = this.leagueRefreshTimestamps[league] || [];

    // Filter out timestamps not from today
    const today = now.toISOString().split('T')[0];
    const todayTimestamps = timestamps.filter(
      (ts) => ts.toISOString().split('T')[0] === today,
    );

    if (todayTimestamps.length >= 2) {
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
      if (league === League.NHL) {
        const hockeyData = new HockeyData();
        currentGames = await hockeyData.getNhlSchedule(teams, leagueLogos);
      } else {
        currentGames = await getTeamsSchedule(teams, league, leagueLogos);
      }
      if (Object.keys(currentGames).length) {
        for (const team of teams) {
          await this.unactivateGames(team.uniqueId);
        }
      }
      let updateNumber = 0;
      for (const team in currentGames) {
        const games = currentGames[team];
        if (games?.length) {
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
        ...(await this.getLeagueGames(league)),
      };
    }
    return this.gameModel.find().exec();
  }

  async findAll(): Promise<Game[]> {
    const allGames = await this.gameModel
      .find({ isActive: true })
      .sort({ startTimeUTC: 1 })
      .exec();
    if (Object.keys(allGames).length === 0 || allGames?.length === 0) {
      return this.getAllGames();
    }
    return allGames;
  }

  async findOne(uniqueId: string) {
    const filter = { uniqueId: uniqueId };
    const game = await this.gameModel.findOne(filter).exec();
    return game;
  }

  async findByTeam(teamSelectedId: string) {
    return this.filterGames({ teamSelectedIds: teamSelectedId });
  }

  async filterGames({
    startDate = undefined,
    endDate = undefined,
    teamSelectedIds,
  }) {
    const filter: any = {};

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

    if (teamSelectedIds && teamSelectedIds.length > 0) {
      const teamSelected = teamSelectedIds
        .split(',')
        .map((item) => item.trim());
      filter.teamSelectedId = { $in: teamSelected };
    }

    const filtredGames = await this.gameModel
      .find(filter)
      .sort({ startTimeUTC: 1 })
      .exec();

    const games = Array.isArray(filtredGames) ? filtredGames : [];
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
        if (!gameOfDay.length) {
          gamesOfDay.push(
            new this.gameModel({
              _id: new mongoose.Types.ObjectId().toString(),
              uniqueId: teamSelectedId + currentDate,
              awayTeamId: '',
              awayTeamShort: '',
              awayTeam: '',
              homeTeamId: '',
              homeTeamShort: '',
              homeTeam: '',
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
              homeTeamLogo: '',
              color: undefined,
              backgroundColor: undefined,
            }),
          );
        } else {
          gamesOfDay.push(...gameOfDay);
        }
      });

      gamesByDay[currentDate] = gamesOfDay;
      date = new Date(date.setDate(date.getDate() + 1));
    }

    return gamesByDay;
  }

  async findByDate(gameDate: string) {
    const filter = { gameDate: gameDate, isActive: true };
    const games = await this.gameModel
      .find(filter)
      .sort({ startTimeUTC: 1 })
      .exec();

    if (!games.length) {
      const allGames = await this.findAll();
      if (!allGames.length) {
        this.getAllGames();
      }
      return [];
    } else {
      const filtredGames = games.filter(({ isActive, awayTeamId }) => {
        return (
          isActive === true && awayTeamId !== undefined && awayTeamId !== ''
        );
      });
      const gamesIndex = randomNumber(filtredGames.length - 1);
      const randomGames = filtredGames[gamesIndex];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      if (new Date(randomGames?.updateDate) < yesterday) {
        for (const league of Object.values(League)) {
          await this.getLeagueGames(league);
        }
      }

      // avoid dupplicate games
      return games.filter(({ homeTeamId, teamSelectedId }) => {
        return homeTeamId === teamSelectedId;
      });
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
    const games = await this.gameModel.find().exec();

    const now = new Date();
    const oldGames = games.filter((game) => {
      const gameDate = new Date(game.startTimeUTC);
      return gameDate < now;
    });
    for (const oldGame of oldGames) {
      await this.remove(oldGame.uniqueId);
    }
    const duplicates = [];

    const gameMap = new Map();

    for (const game of games) {
      const key = `${game.teamSelectedId}-${game.startTimeUTC}`;
      if (gameMap.has(key)) {
        duplicates.push(game);
      } else {
        gameMap.set(key, game);
      }
    }

    for (const duplicate of duplicates) {
      await this.remove(duplicate.uniqueId);
    }
  }

  async removeLeague(league: string): Promise<DeleteResult> {
    const filter = { league };
    const deleted = await this.gameModel.deleteMany(filter);
    return deleted;
  }

  async unactivateGames(teamId: string): Promise<void> {
    const games = await this.findByTeam(teamId);

    for (const date in games) {
      if (Array.isArray(games[date]) && games[date][0]?.awayTeamShort) {
        games[date][0].isActive = false;
        await this.create(games[date][0]);
      }
    }
  }
}
