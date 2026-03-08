import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CronModule } from './cronJob/cronJob.module';
import { GameModule } from './games/games.module';
import { TeamModule } from './teams/teams.module';

const databaseUri =
  process?.env?.DATABASE_URI || 'mongodb://localhost:27017/sportSchedule';
const dbName = process?.env?.DATABASE_NAME || 'sportSchedule';
const username = process?.env?.DATABASE_USER || '';
const password = process?.env?.DATABASE_PASS || '';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Rend la config accessible partout sans réimporter ConfigModule
    }),
    CronModule,
    MongooseModule.forRoot(databaseUri, {
      dbName,
      useBigInt64: true,
      auth: { username, password },
    }),
    TeamModule,
    GameModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
