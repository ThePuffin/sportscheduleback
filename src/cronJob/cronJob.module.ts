import { TeamModule } from '../teams/teams.module';
import { GameModule } from '../games/games.module';
import { RefreshTimestampModule } from '../games/refresh-timestamps.module';
import { Module } from '@nestjs/common';
import { CronService } from './cronJob.service';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  providers: [CronService],
  imports: [
    TeamModule,
    GameModule,
    RefreshTimestampModule,
    ScheduleModule.forRoot(),
  ],
})
export class CronModule {}
