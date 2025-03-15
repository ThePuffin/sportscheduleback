import { TeamModule } from '../teams/teams.module';
import { GameModule } from '../games/games.module';
import { Module } from '@nestjs/common';
import { CronService } from './cronJob.service';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  providers: [CronService],
  imports: [TeamModule, GameModule, ScheduleModule.forRoot()],
})
export class CronModule {}
