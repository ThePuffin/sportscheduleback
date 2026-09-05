import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DeleteResult } from 'mongodb';
import { Model } from 'mongoose';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CollegeLeague, League } from '../utils/enum';
import { getESPNTeams } from '../utils/fetchData/espnAllData';
import { HockeyData } from '../utils/fetchData/hockeyData';
import { HistoricalTeams } from '../utils/HistoricalTeams';
import { TeamType } from '../utils/interface/team';
import { UniversityLogos } from '../utils/UniversityLogos';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { Team } from './schemas/team.schema';

@Injectable()
export class TeamService {
  private isFetchingTeams: { [league: string]: boolean } = {};
  constructor(@InjectModel(Team.name) public teamModel: Model<Team>) {}

  async create(
    teamDto: CreateTeamDto | UpdateTeamDto | TeamType,
    skipGenerateFiles: boolean = false,
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

    // Skip regenerating files during batch imports for performance
    // Files will be regenerated once at the end of the batch
    if (process.env.NODE_ENV === 'development') {
      if (!skipGenerateFiles) {
        try {
          await this.generateLeaguesTeamsAndColorsFiles();
        } catch (err) {
          console.error('Failed to regenerate league/team files:', err);
        }
      }
    }

    return record;
  }

  async getTeams(leagueParam?: string): Promise<any> {
    const leagueKey = leagueParam ? leagueParam.toUpperCase() : 'ALL';
    if (this.isFetchingTeams[leagueKey]) {
      console.info(`getTeams is already running.`);
      return;
    }
    try {
      this.isFetchingTeams[leagueKey] = true;
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
          // Skip file generation during batch import for performance
          const saved = await this.create(activeTeam, true);
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

      // Generate files once after all teams have been imported
      if (process.env.NODE_ENV === 'development') {
        await this.generateLeaguesTeamsAndColorsFiles();
      }
      return allActivesTeams;
    } catch (error) {
      console.error(error);
      throw new Error('Error fetching teams: ' + error.message);
    } finally {
      this.isFetchingTeams[leagueKey] = false;
    }
  }

  async updateRecords(updates: { uniqueId: string; record: string }[]) {
    for (const { uniqueId, record } of updates) {
      await this.updateRecord(uniqueId, record);
    }
  }

  async findAll(leagues?: string[]): Promise<any[]> {
    const filter: any = {};
    if (leagues && leagues.length > 0) {
      filter.league = { $in: leagues };
    }
    const allTeams = await this.teamModel
      .find(filter)
      .sort({ label: 1 })
      .lean()
      .exec();
    if (!allTeams?.length) {
      const teams = await this.getTeams();
      return teams.map((team) => this.addRecord(team));
    }

    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    const leaguesToCheck = new Set(allTeams.map((t) => t.league));
    for (const league of leaguesToCheck) {
      const teamsInLeague = allTeams.filter((t) => t.league === league);
      const mostRecentUpdate = teamsInLeague.reduce((max, team) => {
        const d = new Date(team.updateDate || 0);
        return new Date(Math.max(d.getTime(), max.getTime()));
      }, new Date(0));

      if (mostRecentUpdate < lastMonth) {
        console.info(
          `Teams in ${league} are older than 1 month. Refreshing in background...`,
        );
        this.getTeams(league).catch((err) =>
          console.error(`Error refreshing ${league}:`, err),
        );
      }
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
    return uniqueLeagues.sort((a, b) => a.localeCompare(b));
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
    if (process.env.NODE_ENV === 'development') {
      try {
        await this.generateLeaguesTeamsAndColorsFiles();
      } catch (err) {
        console.error('Failed to regenerate league/team files:', err);
      }
    }

    return res;
  }

  async updateRecord(uniqueId: string, record: string) {
    if (!record) return;
    const parts = record.split('-');
    const wins = Number.parseInt(parts[0], 10);
    const losses = Number.parseInt(parts[1], 10);
    const ties = parts[2] ? Number.parseInt(parts[2], 10) : null;

    const updateData: any = {
      wins,
      losses,
      updateDate: new Date().toISOString(),
    };
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

  async deleteManyByIds(ids: string[]): Promise<DeleteResult> {
    if (!ids || ids.length === 0) {
      return { acknowledged: true, deletedCount: 0 };
    }

    // Only include the `_id` (Mongo ObjectId) branch for ids that are actually valid
    // 24-char hex ObjectIds. Passing plain strings like "PWHL-DET" into $in on the
    // `_id` field makes Mongoose throw a CastError ("Cast to ObjectId failed ... at
    // path \"_id\""). The textual key is handled by `uniqueId` below.
    const validObjectIds = ids.filter(
      (id) => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id),
    );

    const conditions: Array<Record<string, unknown>> = [
      { uniqueId: { $in: ids } },
    ];
    if (validObjectIds.length > 0) {
      conditions.push({ _id: { $in: validObjectIds } });
    }

    return this.teamModel.deleteMany({ $or: conditions }).exec();
  }

  async removeByLeague(league: string): Promise<DeleteResult> {
    const filter = { league: league };
    console.log(`Removing teams with league: ${league}`);
    const deleted = await this.teamModel.deleteMany(filter).exec();
    console.log(`Removed ${deleted.deletedCount} teams`);
    return deleted;
  }

  async removeAll(): Promise<DeleteResult> {
    return this.teamModel.deleteMany({}).exec();
  }

  async countByLeague(league: string): Promise<number> {
    return this.teamModel.countDocuments({ league }).exec();
  }

  private async readExistingFile(relPath: string): Promise<string> {
    const p = path.join(process.cwd(), relPath);
    try {
      return await fs.promises.readFile(p, 'utf8');
    } catch {
      return '';
    }
  }

  private parseExistingColorBlocks(
    content: string,
  ): Map<string, { color: string; backgroundColor: string }> {
    const map = new Map<string, { color: string; backgroundColor: string }>();
    if (!content) return map;

    const re =
      /['"]([^'"]+)['"]\s*:\s*\{\s*color\s*:\s*['"]([^'"]*)['"]\s*,\s*backgroundColor\s*:\s*['"]([^'"]*)['"]\s*,?\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      map.set(m[1], { color: m[2], backgroundColor: m[3] });
    }
    return map;
  }

  private parseExistingLogoBlocks(content: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!content) return map;

    const re = /['"]([^'"]+)['"]\s*:\s*['"]((?:[^'\\]|\\.)*)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      map.set(m[1], m[2]);
    }
    return map;
  }

  private mergeColorsContent(
    existingContent: string,
    newEntries: Array<{
      uniqueId: string;
      color?: string;
      backgroundColor?: string;
    }>,
  ): string {
    const map = this.parseExistingColorBlocks(existingContent);

    for (const item of newEntries) {
      map.set(item.uniqueId, {
        color: item.color ?? '#000000',
        backgroundColor: item.backgroundColor ?? '#ffffff',
      });
    }

    const sortedKeys = Array.from(map.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
    const blocks = sortedKeys.map((key) => {
      const val = map.get(key)!;
      return `  '${key}': {\n    color: '${val.color}',\n    backgroundColor: '${val.backgroundColor}',\n  },`;
    });

    return blocks.join('\n');
  }

  private mergeLogosContent(
    existingContent: string,
    newEntries: Map<string, string>,
  ): string {
    const map = this.parseExistingLogoBlocks(existingContent);

    for (const [id, newLogo] of newEntries.entries()) {
      const existingLogo = map.get(id);
      if (newLogo || !existingLogo) {
        map.set(id, newLogo);
      }
    }

    const sortedKeys = Array.from(map.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
    const blocks = sortedKeys.map((id) => {
      const logo = map.get(id) || '';
      return `  '${id}': '${logo}',`;
    });

    return blocks.join('\n');
  }

  private async generateLeaguesTeamsAndColorsFiles() {
    try {
      // --- 1. Enums Leagues & Teams ---
      const AllLeagues = await this.findAllLeagues();
      const leaguesLines = AllLeagues.map(
        (league) => `  '${league}': '${league}',`,
      );
      const leaguesFileContent = `export const LeaguesEnum: Record<string, string> = {\n${leaguesLines.join(
        '\n',
      )}\n};\n`;
      await fs.promises.writeFile(
        path.join(process.cwd(), '../frontend/constants/Leagues.tsx'),
        leaguesFileContent,
      );

      const allTeams = await this.teamModel
        .find()
        .sort({ uniqueId: 1 })
        .lean()
        .exec();
      // Ne jamais exposer les équipes inactives/historiques dans le fichier de
      // sélection du frontend : seules les équipes actives apparaissent dans
      // Teams.tsx (filtres / favoris).
      const visibleTeams = allTeams.filter(
        (team: any) => team.isActive !== false && !HistoricalTeams[team.uniqueId],
      );
      const lines = visibleTeams.map(
        (team) => `  '${team.uniqueId}': '${team.label.replace(/'/g, "\\'")}',`,
      );
      const fileContent = `export const TeamsEnum: Record<string, string> = {\n${lines.join(
        '\n',
      )}\n};\n`;
      await fs.promises.writeFile(
        path.join(process.cwd(), '../frontend/constants/Teams.tsx'),
        fileContent,
      );

      // --- 2. ColorsTeam (Front & Back) ---
      const colorEntries = allTeams.map((team: any) => ({
        uniqueId: team.uniqueId,
        color: team.color,
        backgroundColor: team.backgroundColor,
      }));

      // Front
      const colorsPathFront = path.join(
        process.cwd(),
        '../frontend/constants/ColorsTeam.tsx',
      );
      const existingColorsFront = await this.readExistingFile(
        '../frontend/constants/ColorsTeam.tsx',
      );
      const mergedColorsFront = this.mergeColorsContent(
        existingColorsFront,
        colorEntries,
      );
      await fs.promises.writeFile(
        colorsPathFront,
        `export const ColorsTeamEnum: Record<string, { color: string; backgroundColor: string }> = {\n${mergedColorsFront}\n};\n`,
      );

      // Back
      const colorsPathBack = path.join(
        process.cwd(),
        'src/utils/ColorsTeam.ts',
      );
      const existingColorsBack = await this.readExistingFile(
        'src/utils/ColorsTeam.ts',
      );
      const mergedColorsBack = this.mergeColorsContent(
        existingColorsBack,
        colorEntries,
      );
      await fs.promises.writeFile(
        colorsPathBack,
        `export const ColorsTeamEnum: Record<string, { color: string; backgroundColor: string }> = {\n${mergedColorsBack}\n};\n`,
      );

      // --- 3. UniversityLogos (Front & Back) ---
      const logoMap = new Map<string, string>();
      allTeams
        .filter((team: any) =>
          Object.values(CollegeLeague).includes(team.league),
        )
        .forEach((team: any) => {
          const parts = team.uniqueId ? team.uniqueId.split('-') : [];
          let id = parts.length > 1 ? parts[1] : team.abbrev || '';
          id = id.trim().toUpperCase();
          if (!id) return;

          const logo = team.teamLogo || '';
          if (!logoMap.has(id) || logo) {
            logoMap.set(id, logo);
          }
        });

      // Front
      const logosPathFront = path.join(
        process.cwd(),
        '../frontend/constants/UniversityLogos.tsx',
      );
      const existingLogosFront = await this.readExistingFile(
        '../frontend/constants/UniversityLogos.tsx',
      );
      const mergedLogosFront = this.mergeLogosContent(
        existingLogosFront,
        logoMap,
      );
      await fs.promises.writeFile(
        logosPathFront,
        `export const UniversityLogos: Record<string, string> = {\n${mergedLogosFront}\n};\n`,
      );

      // Back
      const logosPathBack = path.join(
        process.cwd(),
        'src/utils/UniversityLogos.ts',
      );
      const existingLogosBack = await this.readExistingFile(
        'src/utils/UniversityLogos.ts',
      );
      const mergedLogosBack = this.mergeLogosContent(
        existingLogosBack,
        logoMap,
      );
      await fs.promises.writeFile(
        logosPathBack,
        `export const UniversityLogos: Record<string, string> = {\n${mergedLogosBack}\n};\n`,
      );
    } catch (error) {
      console.error(
        'Error generating TeamsEnum or ColorsTeamEnum file:',
        error,
      );
    }
  }
}
