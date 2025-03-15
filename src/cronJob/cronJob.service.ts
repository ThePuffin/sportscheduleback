import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TeamService } from '../teams/teams.service';
import { GameService } from '../games/games.service';
import { League } from '../utils/enum';

@Injectable()
export class CronService {
  constructor(
    private readonly teamService: TeamService,
    private readonly gameService: GameService,
  ) {}

  @Cron('30 0 1 * *') // EVERY MONTH AT 0:30AM
  async updateTeams() {
    await this.teamService.getTeams();
  }

  @Cron('0 1 1 * *') // EVERY MONTH AT 1AM
  async updateAllGames() {
    await this.gameService.getAllGames();
  }

  @Cron('0 2 * * *') // EVERY DAY AT 2AM
  async updateMLBGames() {
    await this.gameService.getLeagueGames(League.MLB);
  }

  @Cron('0 3 * * *') // EVERY DAY AT 3AM
  async updateNBAGames() {
    await this.gameService.getLeagueGames(League.NBA);
  }

  @Cron('0 4 * * *') // EVERY DAY AT 4AM
  async updateNFLGames() {
    await this.gameService.getLeagueGames(League.NFL);
  }

  @Cron('0 5 * * *') // EVERY DAY AT 5AM
  async updateNHLGames() {
    await this.gameService.getLeagueGames(League.NHL);
  }
}
