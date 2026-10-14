import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { Game, GameSchema } from '../games/schemas/game.schema';
import { Team, TeamSchema } from './schemas/team.schema';
import { TeamsController } from './teams.controller';
import { TeamService } from './teams.service';

@Module({
  imports: [
    ConfigModule,
    // The Game model is registered here so `TeamService` can count a team's
    // active games for `GET /teams?minGames=…`. This is the Game **schema**
    // only: it does NOT import `GameModule`/`GameService`, so the dependency
    // direction stays one-way (GameModule → TeamModule) and no circular
    // dependency is introduced. `forFeature` also reuses the model already
    // compiled on the shared connection instead of recompiling it.
    MongooseModule.forFeature([
      { name: Team.name, schema: TeamSchema },
      { name: Game.name, schema: GameSchema },
    ]),
  ],
  controllers: [TeamsController],
  providers: [TeamService, ApiKeyGuard],
  exports: [TeamService],
})
export class TeamModule {}
