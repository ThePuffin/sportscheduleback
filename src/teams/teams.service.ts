import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CollegeLeague, League } from '../utils/enum';
import { getESPNTeams } from '../utils/fetchData/espnAllData';
import { HockeyData } from '../utils/fetchData/hockeyData';
import { TeamType } from '../utils/interface/team';
import { UniversityLogos } from '../utils/UniversityLogos';
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

    let saved: any;
    if (uniqueId) {
      saved = await this.teamModel
        .findOneAndUpdate(
          { uniqueId },
          { $set: teamDto },
          { new: true, upsert: true },
        )
        .lean()
        .exec();
    } else {
      const newTeam = new this.teamModel(teamDto);
      saved = await newTeam.save();
      saved = saved.toObject ? saved.toObject() : saved;
    }

    const record = this.addRecord({ ...saved, ...teamDto });

    // regenerate the enums/files so both front and back reflect the change.
    // doing it unconditionally keeps the constant files in sync when any
    // piece of team data is modified (including logos). the method itself
    // writes to both frontend and backend locations.
    try {
      await this.generateLeaguesTeamsAndColorsFiles();
    } catch (err) {
      console.error('Failed to regenerate league/team files:', err);
    }

    return record;
  }

  async getTeams(leagueParam?: string): Promise<any> {
    if (this.isFetchingTeams) {
      console.info(`getTeams is already running.`);
      return;
    }
    try {
      this.isFetchingTeams = true;
      const allActivesTeams: any[] = [];
      let leagues: string[] = [];
      if (leagueParam) {
        leagues = [leagueParam.toUpperCase()];
      } else {
        leagues = Object.values(League);
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
          // if ESPN didn't give us a logo, try our manual mapping before saving
          if (!activeTeam.teamLogo) {
            const parts = activeTeam.uniqueId?.split('-') || [];
            const abbrev = parts[1] || activeTeam.abbrev || '';
            if (abbrev && UniversityLogos[abbrev]) {
              activeTeam.teamLogo = UniversityLogos[abbrev];
            }
          }
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
        await this.generateLeaguesTeamsAndColorsFiles();
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
      await this.generateLeaguesTeamsAndColorsFiles();
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

  async update(uniqueId: string, updateTeamDto: UpdateTeamDto) {
    const filter = { uniqueId: uniqueId };
    const res = await this.teamModel.updateOne(filter, updateTeamDto).exec();

    // regenerate the frontend/back mapping files after any update.
    try {
      await this.generateLeaguesTeamsAndColorsFiles();
    } catch (err) {
      console.error('Failed to regenerate league/team files:', err);
    }

    return res;
  }

  async updateRecord(uniqueId: string, record: string) {
    if (!record) return;
    const parts = record.split('-');
    const wins = Number.parseInt(parts[0], 10);
    const losses = Number.parseInt(parts[1], 10);
    const ties = parts[2] ? Number.parseInt(parts[2], 10) : null;

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

  async removeByLeague(league: string): Promise<any> {
    const filter = { league: league };
    console.log(`Removing teams with league: ${league}`);
    const deleted = await this.teamModel.deleteMany(filter).exec();
    console.log(`Removed ${deleted.deletedCount} teams`);
    return deleted;
  }

  async removeAll() {
    await this.teamModel.deleteMany({});
    const teams = await this.teamModel.find().exec();
    for (const team of teams) {
      await this.remove(team.uniqueId);
    }
  }

  private async generateLeaguesTeamsAndColorsFiles() {
    try {
      const AllLeagues = await this.findAllLeagues();
      const leaguesLines = AllLeagues.map(
        (league) => `  '${league}': '${league}',`,
      );
      const leaguesFileContent = `export const LeaguesEnum: Record<string, string> = {\n${leaguesLines.join(
        '\n',
      )}\n};\n`;
      const leaguesFilePath = path.join(
        process.cwd(),
        '../frontend/constants/Leagues.tsx',
      );
      await fs.promises.writeFile(leaguesFilePath, leaguesFileContent);
      const allTeams = await this.teamModel
        .find()
        .sort({ uniqueId: 1 })
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

      // --- generate a mapping of university logos keyed by team id (abbrev) ---
      // only include college leagues so we don't duplicate professional teams.
      // we want a single entry per abbreviation and prefer the first non-empty
      // logo we encounter; later duplicates are ignored.
      const logoMap = new Map<string, string>();
      allTeams
        .filter((team: any) =>
          Object.values(CollegeLeague).includes(team.league),
        )
        .forEach((team: any) => {
          // use the portion of uniqueId after the hyphen (usually the abbreviation)
          const parts = team.uniqueId ? team.uniqueId.split('-') : [];
          let id = parts.length > 1 ? parts[1] : team.abbrev || '';
          id = id.trim().toUpperCase();
          if (!id) return;

          const logo = team.teamLogo || '';

          if (logoMap.has(id)) {
            // if we already have a non-empty logo, keep it; otherwise replace
            // the empty placeholder with whatever we have now.
            if (logoMap.get(id)) {
              return;
            }
          }
          logoMap.set(id, logo);
        });

      // --- create content for university logos file ---
      // sort by key to make output deterministic and easier to diff.
      const sortedEntries = Array.from(logoMap.entries()).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      const logoLines = sortedEntries.map(
        ([id, logo]) => `  '${id}': '${logo}',`,
      );
      const logosFileContent = `export const UniversityLogos: Record<string, string> = {\n${logoLines.join(
        '\n',
      )}\n};\n`;

      const logosFilePath = path.join(
        process.cwd(),
        '../frontend/constants/UniversityLogos.tsx',
      );
      await fs.promises.writeFile(logosFilePath, logosFileContent);

      const logosFilePathBack = path.join(
        process.cwd(),
        'src/utils/UniversityLogos.ts',
      );
      await fs.promises.writeFile(logosFilePathBack, logosFileContent);
    } catch (error) {
      console.error(
        'Error generating TeamsEnum or ColorsTeamEnum file:',
        error,
      );
    }
  }
}
