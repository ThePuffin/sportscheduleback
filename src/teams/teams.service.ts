import { Model } from 'mongoose';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Team } from './schemas/team.schema';
import { League } from '../utils/enum';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { HockeyData } from '../utils/fetchData/hockeyData';
import { getESPNTeams } from '../utils/fetchData/espnAllData';
import { TeamType } from '../utils/interface/team';

@Injectable()
export class TeamService {
  constructor(@InjectModel(Team.name) public teamModel: Model<Team>) {}

  async create(
    teamDto: CreateTeamDto | UpdateTeamDto | TeamType,
  ): Promise<Team> {
    const { uniqueId } = teamDto;

    if (uniqueId) {
      const existingTeam = await this.findOne(uniqueId);
      if (existingTeam) {
        Object.assign(existingTeam, teamDto);
        return await existingTeam.save();
      }
    }

    const newTeam = new this.teamModel(teamDto);
    return await newTeam.save();
  }

  async getTeams(): Promise<any> {
    const hockeyData = new HockeyData();
    const activeTeams = await hockeyData.getNhlTeams();
    const leagues = [League.NFL, League.NBA, League.MLB];
    for (const league of leagues) {
      const teams = await getESPNTeams(league);
      if (teams.length) {
        activeTeams.push(...teams);
      }
    }

    for (const activeTeam of activeTeams) {
      await this.create(activeTeam);
    }

    return activeTeams;
  }

  async findAll(): Promise<Team[]> {
    const allTeams = await this.teamModel.find().sort({ label: 1 }).exec();
    if (!allTeams?.length) {
      return this.getTeams();
    }
    return allTeams;
  }

  async findOne(uniqueId: string) {
    const filter = { uniqueId: uniqueId };
    const team = await this.teamModel.findOne(filter).exec();
    return team;
  }

  async findByLeague(league: string) {
    const filter = { league: league };
    const team = await this.teamModel.find(filter).exec();
    return team;
  }

  update(uniqueId: string, updateTeamDto: UpdateTeamDto) {
    const filter = { uniqueId: uniqueId };
    return this.teamModel.updateOne(filter, updateTeamDto);
  }

  async remove(uniqueId: string) {
    const filter = { uniqueId: uniqueId };

    const deleted = await this.teamModel.findOneAndDelete(filter).exec();
    return deleted;
  }

  async removeAll() {
    const teams = await this.teamModel.find().exec();
    for (const team of teams) {
      await this.remove(team.uniqueId);
    }
  }
}
