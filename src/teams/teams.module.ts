import { Module } from '@nestjs/common';
import { TeamService } from './teams.service';
import { MongooseModule } from '@nestjs/mongoose';
import { TeamsController } from './teams.controller';
import { Team, TeamSchema } from './schemas/team.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Team.name, schema: TeamSchema }]),
  ],
  controllers: [TeamsController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
