import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { TeamModule } from '../teams/teams.module';
import { GamesController } from './games.controller';
import { GameService } from './games.service';
import { RefreshTimestampModule } from './refresh-timestamps.module';
import { Game, GameSchema } from './schemas/game.schema';

@Module({
  imports: [
    TeamModule,
    RefreshTimestampModule,
    ConfigModule,
    MongooseModule.forFeature([{ name: Game.name, schema: GameSchema }]),
  ],
  controllers: [GamesController],
  providers: [GameService, ApiKeyGuard],
  exports: [GameService],
})
export class GameModule {}
