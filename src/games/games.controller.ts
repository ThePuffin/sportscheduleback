import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CreateGameDto } from './dto/create-game.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { GameService } from './games.service';

@Controller('games')
export class GamesController {
  constructor(private readonly GameService: GameService) {}

  @Get()
  async findAll(): Promise<any[]> {
    return this.GameService.findAll();
  }
  @Get('/team/:teamSelectedId')
  findByTeam(@Param('teamSelectedId') teamSelectedId: string) {
    return this.GameService.findByTeam(teamSelectedId);
  }

  @Get('/filter')
  async filterGames(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('teamSelectedIds') teamSelectedIds: string,
  ): Promise<any> {
    return this.GameService.filterGames({
      startDate,
      endDate,
      teamSelectedIds,
    });
  }

  @Get('/date/:gameDate')
  findByDate(@Param('gameDate') gameDate: string) {
    return this.GameService.findByDate(gameDate);
  }

  @Get(':uniqueId')
  findOne(@Param('uniqueId') uniqueId: string) {
    return this.GameService.findOne(uniqueId);
  }

  @Post()
  async create(@Body() createGameDto: CreateGameDto) {
    this.GameService.create(createGameDto);
  }

  @Post('refresh/all')
  async refresh() {
    return this.GameService.getAllGames();
  }

  @Post('/refresh/:league')
  async refreshByLeague(@Param('league') league: string) {
    return this.GameService.getLeagueGames(league);
  }

  @Patch(':uniqueId')
  update(
    @Param('uniqueId') uniqueId: string,
    @Body() updateGameDto: UpdateGameDto,
  ) {
    return this.GameService.update(uniqueId, updateGameDto);
  }

  @Delete('/league/:league')
  removeLeague(@Param('league') league: string) {
    return this.GameService.removeLeague(league);
  }

  @Delete('all')
  removeAll() {
    return this.GameService.removeAll();
  }

  @Delete('duplicate')
  removeDuplicate() {
    return this.GameService.removeDuplicatesAndOlds();
  }

  @Delete(':uniqueId')
  remove(@Param('uniqueId') uniqueId: string) {
    return this.GameService.remove(uniqueId);
  }
}
