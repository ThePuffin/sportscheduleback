import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CollegeLeague, League } from '../utils/enum';
import { getESPNTeams } from '../utils/fetchData/espnAllData';
import { HockeyData } from '../utils/fetchData/hockeyData';
import { TeamType } from '../utils/interface/team';
import { randomNumber } from '../utils/utils';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { Team } from './schemas/team.schema';

@Injectable()
export class TeamService {
  private isFetchingTeams: boolean = false;
  constructor(@InjectModel(Team.name) public teamModel: Model<Team>) {}

  async create(
    teamDto: CreateTeamDto | UpdateTeamDto | TeamType,
  ): Promise<any> {
    const { uniqueId } = teamDto;

    if (uniqueId) {
      const saved = await this.teamModel
        .findOneAndUpdate(
          { uniqueId },
          { $set: teamDto },
          { new: true, upsert: true },
        )
        .lean()
        .exec();
      return this.addRecord({ ...saved, ...teamDto });
    }

    const newTeam = new this.teamModel(teamDto);
    const saved = await newTeam.save();
    return this.addRecord({ ...saved.toObject(), ...teamDto });
  }

  async getTeams(leagueParam?: string): Promise<any> {
    if (this.isFetchingTeams) {
      console.info(`getTeams is already running.`);
      return;
    }
    try {
      this.isFetchingTeams = true;
      const allActivesTeams: any[] = [];
      const collegeLeagueValues = Object.values(
        CollegeLeague,
      ) as CollegeLeague[];
      let leagues: string[] = [];
      if (leagueParam) {
        leagues = [leagueParam.toUpperCase()];
      } else {
        leagues = Object.values(League).filter(
          (league) =>
            !collegeLeagueValues.includes(league as unknown as CollegeLeague),
        );
      }
      for (const league of leagues) {
        const activeTeams: TeamType[] = [];
        let teams: TeamType[] = [];
        try {
          if (league === League.PWHL) {
            const hockeyData = new HockeyData();
            teams = await hockeyData.getPWHLTeams();
          } else {
            teams = await getESPNTeams(league);
          }
        } catch (error) {
          console.error(`Error fetching teams for league ${league}:`, error);
          if (league === League.NHL) {
            const hockeyData = new HockeyData();
            teams = await hockeyData.getNHLTeams();
          }
        }
        if (teams.length) {
          activeTeams.push(...teams);
        }

        const savedTeams = [];
        let updateNumber = 0;
        for (const activeTeam of activeTeams) {
          activeTeam.updateDate = new Date().toISOString();
          const saved = await this.create(activeTeam);
          savedTeams.push(saved);
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
        allActivesTeams.push(...savedTeams);
      }

      if (process.env.NODE_ENV === 'development') {
        await this.generateTeamsAndColorsFiles();
      }

      return allActivesTeams;
    } catch (error) {
      console.error(error);
      throw new Error('Error fetching teams: ' + error.message);
    } finally {
      this.isFetchingTeams = false;
    }
  }

  async findAll(): Promise<any[]> {
    const allTeams = await this.teamModel
      .find()
      .sort({ label: 1 })
      .lean()
      .exec();
    if (!allTeams?.length) {
      const teams = await this.getTeams();
      return teams.map((team) => this.addRecord(team));
    }
    const teamIndex = randomNumber(allTeams.length - 1);
    const randomTeam = allTeams[teamIndex];
    const lastMonth = new Date();
    lastMonth.setDate(lastMonth.getMonth() - 1);
    if (new Date(randomTeam?.updateDate) < lastMonth) {
      this.getTeams();
    }
    if (process.env.NODE_ENV === 'development') {
      await this.generateTeamsAndColorsFiles();
    }
    return allTeams.map((team) => this.addRecord(team));
  }

  async findAllLeagues(): Promise<string[]> {
    const allTeams = await this.teamModel.find().exec();
    const leagues = allTeams.map((team) => team.league);
    const uniqueLeagues = Array.from(new Set(leagues));
    return uniqueLeagues.sort();
  }

  async findOne(uniqueId: string) {
    const filter = { uniqueId: uniqueId };
    const team = await this.teamModel.findOne(filter).lean().exec();
    return team ? this.addRecord(team) : null;
  }

  async findByLeague(league: string) {
    const filter = { league: league };
    const teams = await this.teamModel.find(filter).lean().exec();
    return teams.map((team) => this.addRecord(team));
  }

  update(uniqueId: string, updateTeamDto: UpdateTeamDto) {
    const filter = { uniqueId: uniqueId };
    return this.teamModel.updateOne(filter, updateTeamDto);
  }

  async updateRecord(uniqueId: string, record: string) {
    if (!record) return;
    const parts = record.split('-');
    const wins = parseInt(parts[0], 10);
    const losses = parseInt(parts[1], 10);
    const ties = parts[2] ? parseInt(parts[2], 10) : null;

    const updateData: any = { wins, losses };
    if (ties !== null) {
      const league = uniqueId.split('-')[0];
      if (league === League.NHL || league === League.PWHL) {
        updateData.otLosses = ties;
      } else {
        updateData.ties = ties;
      }
    }
    await this.teamModel.updateOne({ uniqueId }, { $set: updateData }).exec();
  }

  private addRecord(team: any) {
    const ties = team.otLosses ?? team.ties;
    const record = `${team.wins ?? 0}-${team.losses ?? 0}${
      ties !== undefined && ties !== null ? '-' + ties : ''
    }`;
    return { ...team, record };
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

  private async generateTeamsAndColorsFiles() {
    try {
      const allTeams = await this.teamModel
        .find()
        .sort({ label: 1 })
        .lean()
        .exec();
      const lines = allTeams.map(
        (team) => `  '${team.uniqueId}': '${team.label.replace(/'/g, "\\'")}',`,
      );
      const fileContent = `export const TeamsEnum: Record<string, string> = {\n${lines.join(
        '\n',
      )}\n};\n`;
      const filePath = path.join(
        process.cwd(),
        '../frontend/constants/Teams.tsx',
      );
      await fs.promises.writeFile(filePath, fileContent);

      const colorLines = allTeams.map((team: any) => {
        return `  '${team.uniqueId}': {\n    color: '${
          team.color ?? '#000000'
        }',\n    backgroundColor: '${team.backgroundColor ?? '#ffffff'}',\n  },`;
      });
      const colorsFileContent = `export const ColorsTeamEnum: Record<string, { color: string; backgroundColor: string }> = {\n${colorLines.join(
        '\n',
      )}\n};\n`;
      const colorsFilePath = path.join(
        process.cwd(),
        '../frontend/constants/ColorsTeam.tsx',
      );
      await fs.promises.writeFile(colorsFilePath, colorsFileContent);

      const colorsFilePathBack = path.join(
        process.cwd(),
        'src/utils/ColorsTeam.ts',
      );
      await fs.promises.writeFile(colorsFilePathBack, colorsFileContent);
    } catch (error) {
      console.error(
        'Error generating TeamsEnum or ColorsTeamEnum file:',
        error,
      );
    }
  }
}
