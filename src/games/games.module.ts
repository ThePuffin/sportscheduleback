import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TeamModule } from '../teams/teams.module';
import { GamesController } from './games.controller';
import { GameService } from './games.service';
import { RefreshTimestampModule } from './refresh-timestamps.module';
import { Game, GameSchema } from './schemas/game.schema';

@Module({
  imports: [
    TeamModule,
    RefreshTimestampModule,
    MongooseModule.forFeature([{ name: Game.name, schema: GameSchema }]),
  ],
  controllers: [GamesController],
  providers: [GameService],
  exports: [GameService],
})
export class GameModule {}
