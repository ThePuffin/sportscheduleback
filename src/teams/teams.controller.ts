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
    const teams = await this.TeamService.findAll(undefined, { minGames });
    // Olympic deduplication on HTTP output: one entry per country and gender
    // (OLYMPICS-{MEN|WOMEN}-{PAYS}) so the selector does not display the same
    // country twice (hockey + basketball). The representative ID is unified to
    // `OLYMPICS-{GENDER}-{COUNTRY}` (e.g. `OLYMPICS-WOMEN-USA`) instead of
    // keeping a sport-specific ID such as `OLYMPICS-HOCKEY-WOMEN-USA` /
    // `OLYMPICS-BASKETBALL-WOMEN-USA`. `findAll()` is left intact to avoid
    // impacting GameService's per-sport iteration (team enrichment and league
    // discovery).
    return dedupOlympicTeams(teams);
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

/**
 * Deduplicates Olympic teams so there is a single entry per country and
 * gender (`OLYMPICS-{MEN|WOMEN}-{PAYS}`) in the HTTP output.
 *
 * The representative ID is unified to `OLYMPICS-{GENDER}-{COUNTRY}` (e.g.
 * `OLYMPICS-WOMEN-USA`) instead of keeping a sport-specific ID such as
 * `OLYMPICS-HOCKEY-WOMEN-USA` or `OLYMPICS-BASKETBALL-WOMEN-USA`. This avoids
 * arbitrarily dropping hockey (lexicographic tie-break) while still showing
 * each country delegation only once in the selector.
 *
 * Non-Olympic teams pass through unchanged. HTTP output only: GameService's
 * per-sport iteration must keep every Olympic team with its sport-specific ID,
 * so `findAll()` is left intact.
 */
function dedupOlympicTeams(teams: any[]): any[] {
  const representatives = new Map<string, any>();
  for (const team of teams ?? []) {
    const match = String(team?.uniqueId ?? '').match(
      /^OLYMPICS-(?:HOCKEY|BASKETBALL)-(MEN|WOMEN)-(.+)$/,
    );
    if (!match) {
      representatives.set(team?.uniqueId, team);
      continue;
    }
    const groupKey = `OLYMPICS-${match[1]}-${match[2]}`;
    // One entry per country and gender. The ID is unified to
    // `OLYMPICS-{GENDER}-{COUNTRY}` so neither hockey nor basketball is
    // arbitrarily favored (previous lexicographic tie-break kept basketball).
    // The first team encountered wins the group; its sport-specific ID is
    // still authoritative in the database (findAll is not deduplicated).
    if (!representatives.has(groupKey)) {
      representatives.set(groupKey, { ...team, uniqueId: groupKey });
    }
  }
  return Array.from(representatives.values());
}
