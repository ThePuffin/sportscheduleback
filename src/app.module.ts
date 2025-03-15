import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CronModule } from './cronJob/cronJob.module';
import { MongooseModule } from '@nestjs/mongoose';
import { TeamModule } from './teams/teams.module';
import { GameModule } from './games/games.module';

const databaseUri =
  process?.env?.DATABASE_URI || 'mongodb://localhost:27017/sportSchedule';
const dbName = process?.env?.DATABASE_NAME || 'sportSchedule';
const username = process?.env?.DATABASE_USER || '';
const password = process?.env?.DATABASE_PASS || '';

@Module({
  imports: [
    CronModule,
    MongooseModule.forRoot(databaseUri, {
      dbName,
      auth: { username, password },
    }),
    TeamModule,
    GameModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
