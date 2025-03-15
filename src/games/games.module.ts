import { Module } from '@nestjs/common';
import { GameService } from './games.service';
import { MongooseModule } from '@nestjs/mongoose';
import { GamesController } from './games.controller';
import { Game, GameSchema } from './schemas/game.schema';
import { TeamModule } from '../teams/teams.module';

@Module({
  imports: [
    TeamModule,
    MongooseModule.forFeature([{ name: Game.name, schema: GameSchema }]),
  ],
  controllers: [GamesController],
  providers: [GameService],
  exports: [GameService],
})
export class GameModule {}
