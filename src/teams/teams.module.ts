import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { Team, TeamSchema } from './schemas/team.schema';
import { TeamsController } from './teams.controller';
import { TeamService } from './teams.service';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: Team.name, schema: TeamSchema }]),
  ],
  controllers: [TeamsController],
  providers: [TeamService, ApiKeyGuard],
  exports: [TeamService],
})
export class TeamModule {}
