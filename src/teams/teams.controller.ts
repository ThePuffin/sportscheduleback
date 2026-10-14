import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { TeamType } from '../utils/interface/team';
import { UpdateTeamDto } from './dto/update-team.dto';
import { TeamService } from './teams.service';

@Controller('teams')
export class TeamsController {
  constructor(private readonly TeamService: TeamService) {}

  @Get()
  async findAll(@Query('minGames') minGames?: string): Promise<TeamType[]> {
    // `minGames` is inclusive: `?minGames=4` returns only the teams with at
    // least 4 active games (past or upcoming). Omitted / invalid / `0` keeps
    // the unfiltered catalog — the behavior every existing caller relies on.
    return this.TeamService.findAll(undefined, { minGames });
  }

  @Get('/leagues')
  async findLeagues(): Promise<string[]> {
    return this.TeamService.findAllLeagues();
  }

  @Get('/league/:league')
  findByLeague(@Param('league') league: string) {
    return this.TeamService.findByLeague(league);
  }

  @Get(':uniqueId')
  findOne(@Param('uniqueId') uniqueId: string) {
    return this.TeamService.findOne(uniqueId);
  }

  @Post('refresh')
  async refresh(@Query('leagueParam') leagueParam?: string) {
    return this.TeamService.getTeams(leagueParam);
  }

  @UseGuards(ApiKeyGuard)
  @Patch(':uniqueId')
  update(
    @Param('uniqueId') uniqueId: string,
    @Body() updateTeamDto: UpdateTeamDto,
  ) {
    return this.TeamService.update(uniqueId, updateTeamDto);
  }

  @UseGuards(ApiKeyGuard)
  @Delete('all')
  removeAll() {
    return this.TeamService.removeAll();
  }

  @UseGuards(ApiKeyGuard)
  @Delete('/league/:league')
  removeByLeague(@Param('league') league: string) {
    return this.TeamService.removeByLeague(league);
  }

  @UseGuards(ApiKeyGuard)
  @Delete(':uniqueId')
  remove(@Param('uniqueId') uniqueId: string) {
    return this.TeamService.remove(uniqueId);
  }
}
