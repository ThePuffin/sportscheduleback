import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { League } from '../utils/enum';
import { getESPNTeams } from '../utils/fetchData/espnAllData';
import { HockeyData } from '../utils/fetchData/hockeyData';
import { TeamType } from '../utils/interface/team';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { Team } from './schemas/team.schema';

@Injectable()
export class TeamService {
  private isFetchingTeams: boolean = false;
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
    if (this.isFetchingTeams) {
      console.info(`getTeams is already running.`);
      return;
    }
    try {
      this.isFetchingTeams = true;

      const hockeyData = new HockeyData();
      const activeTeams = await hockeyData.getNhlTeams();
      const leagues = [League.NFL, League.NBA, League.MLB, League.WNBA];
      for (const league of leagues) {
        const teams = await getESPNTeams(league);
        if (teams.length) {
          activeTeams.push(...teams);
        }
      }
      let updateNumber = 0;
      for (const activeTeam of activeTeams) {
        activeTeam.updateDate = new Date().toISOString();
        await this.create(activeTeam);
        updateNumber++;
        console.info(
          'updated:',
          activeTeam?.label,
          '(',
          updateNumber,
          '/',
          activeTeams.length,
          ')',
        );
      }

      return activeTeams;
    } catch (error) {
      console.error(error);
      throw new Error('Error fetching teams: ' + error.message);
    } finally {
      this.isFetchingTeams = false;
    }
  }

  async findAll(): Promise<Team[]> {
    const allTeams = await this.teamModel.find().sort({ label: 1 }).exec();
    if (!allTeams?.length) {
      return this.getTeams();
    }
    const firstTeam = allTeams[0];
    const lastMonth = new Date();
    lastMonth.setDate(lastMonth.getMonth() - 1);
    if (new Date(firstTeam.updateDate) < lastMonth) {
      this.getTeams();
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
    await this.teamModel.deleteMany({});
    const teams = await this.teamModel.find().exec();
    for (const team of teams) {
      await this.remove(team.uniqueId);
    }
  }
}
