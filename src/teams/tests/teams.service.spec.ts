import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import * as fs from 'node:fs';
import { Game } from '../../games/schemas/game.schema';
import { TeamType } from '../../utils/interface/team';
import { Team } from '../schemas/team.schema';
import { TeamService } from '../teams.service';

// Mock the fs module to avoid writing to disk during tests
jest.mock('node:fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
  },
}));

// A mocked team object
const mockTeam: TeamType = {
  uniqueId: 'NHL-BOS',
  label: 'Boston Bruins',
  league: 'NHL',
  wins: 10,
  losses: 5,
  otLosses: 2,
  color: '#FFB81C',
  backgroundColor: '#000000',
} as TeamType;

// We only mock the model methods used in the tested functions
const mockTeamModel = {
  findOneAndDelete: jest.fn(),
  deleteMany: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
  updateOne: jest.fn(),
  updateMany: jest.fn(),
};

// The Game model is injected into TeamService so it can count a team's active
// games for `GET /teams?minGames=…`.
const mockGameModel = {
  aggregate: jest.fn(),
};

/**
 * Builds the `.aggregate(...).exec()` chain used by `countActiveGamesByTeam()`
 * and makes it resolve with `rows`.
 */
const mockGameAggregate = (rows: Array<{ _id: string; count: number }>) => {
  mockGameModel.aggregate.mockReturnValue({
    exec: jest.fn().mockResolvedValue(rows),
  });
};

/**
 * Builds the `.find(...).sort(...).lean().exec()` chain of `findAll()` and
 * makes it resolve with `teams`.
 */
const mockTeamFind = (teams: any[]) => {
  const exec = jest.fn().mockResolvedValue(teams);
  const lean = jest.fn().mockReturnValue({ exec });
  const sort = jest.fn().mockReturnValue({ lean });
  (mockTeamModel.find as jest.Mock).mockReturnValue({ sort });
};

describe('TeamService', () => {
  let service: TeamService;
  let model: Model<Team>;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        TeamService,
        {
          provide: getModelToken(Team.name),
          useValue: mockTeamModel,
        },
        {
          provide: getModelToken(Game.name),
          useValue: mockGameModel,
        },
      ],
    }).compile();

    service = module.get<TeamService>(TeamService);
    model = module.get<Model<Team>>(getModelToken(Team.name));

    // Reset mocks before each test
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await module.close();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('purgeNonD1Teams', () => {
    it.each(['NCAAMH', 'NCAAWH'])(
      'purges stale non-D1 teams from %s rosters',
      async (league) => {
        const retainedId = `${league}-D1`;
        const removedId = `${league}-NON-D1`;
        (model.find as jest.Mock).mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockReturnValue({
              exec: jest.fn().mockResolvedValue([
                { uniqueId: retainedId, isActive: true },
                { uniqueId: removedId, isActive: true },
              ]),
            }),
          }),
        });
        (model.deleteMany as jest.Mock).mockReturnValue({
          exec: jest
            .fn()
            .mockResolvedValue({ acknowledged: true, deletedCount: 1 }),
        });

        const deletedIds = await service.purgeNonD1Teams(league, [
          { uniqueId: retainedId } as TeamType,
        ]);

        expect(deletedIds).toEqual([removedId]);
        expect(model.deleteMany).toHaveBeenCalledWith({
          $or: [{ uniqueId: { $in: [removedId] } }],
        });
      },
    );
  });

  describe('countActiveGamesByTeam', () => {
    it('groups the ACTIVE regular-season/playoff games by teamSelectedId', async () => {
      mockGameAggregate([
        { _id: 'NHL-BOS', count: 12 },
        { _id: 'NHL-TOR', count: 4 },
      ]);

      const counts = await service.countActiveGamesByTeam();

      // Only active games count, `teamSelectedId` is the grouping key (a match
      // is stored twice, so homeTeamId/awayTeamId would double-count), and
      // preseason games (phase 1) are excluded so a team that only plays
      // exhibitions never reaches the threshold.
      expect(mockGameModel.aggregate).toHaveBeenCalledWith([
        {
          $match: {
            isActive: true,
            recordSeasonType: { $ne: 1 },
          },
        },
        { $group: { _id: '$teamSelectedId', count: { $sum: 1 } } },
      ]);
      expect(counts.get('NHL-BOS')).toBe(12);
      expect(counts.get('NHL-TOR')).toBe(4);
    });

    it('keeps games with no phase at all (legacy documents and the PWHL feed)', async () => {
      // The filter must be a `$ne: 1`, never an `$in: [2, 3]`: documents stored
      // before `recordSeasonType` existed — and the whole PWHL feed, which
      // reports no phase — carry no value, and an `$in` would silently hide
      // those real teams.
      mockGameAggregate([{ _id: 'NHL-BOS', count: 3 }]);

      await service.countActiveGamesByTeam();

      const [pipeline] = mockGameModel.aggregate.mock.calls[0];
      const match = pipeline[0].$match;
      expect(match.recordSeasonType).toEqual({ $ne: 1 });
      expect(match.recordSeasonType).not.toEqual({ $in: [2, 3] });
    });

    it('skips the empty teamSelectedId of the synthetic placeholder rows', async () => {
      mockGameAggregate([
        { _id: '', count: 3 },
        { _id: 'NHL-BOS', count: 1 },
      ]);

      const counts = await service.countActiveGamesByTeam();

      expect(counts.has('')).toBe(false);
      expect(counts.size).toBe(1);
    });

    it('reuses the memoised result within the TTL', async () => {
      mockGameAggregate([{ _id: 'NHL-BOS', count: 12 }]);

      await service.countActiveGamesByTeam();
      await service.countActiveGamesByTeam();

      expect(mockGameModel.aggregate).toHaveBeenCalledTimes(1);
    });

    it('re-runs the aggregation once the TTL has expired', async () => {
      mockGameAggregate([{ _id: 'NHL-BOS', count: 12 }]);
      await service.countActiveGamesByTeam();

      // Jump past the 5-minute cache TTL.
      const later = Date.now() + 6 * 60 * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(later);
      mockGameAggregate([{ _id: 'NHL-BOS', count: 13 }]);

      const counts = await service.countActiveGamesByTeam();

      expect(mockGameModel.aggregate).toHaveBeenCalledTimes(2);
      expect(counts.get('NHL-BOS')).toBe(13);
      jest.spyOn(Date, 'now').mockRestore();
    });

    it('clearActiveGameCountCache forces a fresh aggregation', async () => {
      mockGameAggregate([{ _id: 'NHL-BOS', count: 12 }]);
      await service.countActiveGamesByTeam();

      service.clearActiveGameCountCache();
      mockGameAggregate([{ _id: 'NHL-BOS', count: 20 }]);
      const counts = await service.countActiveGamesByTeam();

      expect(mockGameModel.aggregate).toHaveBeenCalledTimes(2);
      expect(counts.get('NHL-BOS')).toBe(20);
    });
  });

  describe('findAll minGames filter', () => {
    const teams = [
      { uniqueId: 'NHL-BOS', label: 'Boston Bruins', league: 'NHL' },
      { uniqueId: 'NHL-TOR', label: 'Toronto Maple Leafs', league: 'NHL' },
      { uniqueId: 'NHL-VGK', label: 'Vegas Golden Knights', league: 'NHL' },
    ];

    it('keeps only the teams reaching the inclusive minGames threshold', async () => {
      mockTeamFind(teams);
      mockGameAggregate([
        { _id: 'NHL-BOS', count: 12 },
        { _id: 'NHL-TOR', count: 4 },
        // NHL-VGK has 3 games → below the "more than 3" threshold of 4.
        { _id: 'NHL-VGK', count: 3 },
      ]);

      const result = await service.findAll(undefined, { minGames: 4 });

      expect(result.map((t) => t.uniqueId)).toEqual(['NHL-BOS', 'NHL-TOR']);
    });

    it('drops the teams with no game at all', async () => {
      mockTeamFind(teams);
      mockGameAggregate([{ _id: 'NHL-BOS', count: 1 }]);

      const result = await service.findAll(undefined, { minGames: 1 });

      expect(result.map((t) => t.uniqueId)).toEqual(['NHL-BOS']);
    });

    it('does not run any aggregation when no minGames is given', async () => {
      mockTeamFind(teams);

      const result = await service.findAll();

      expect(result).toHaveLength(3);
      expect(mockGameModel.aggregate).not.toHaveBeenCalled();
    });

    it.each([
      ['0', 'zero threshold'],
      ['', 'empty string'],
      ['abc', 'non-numeric'],
      ['-5', 'negative'],
    ])('treats %s (%s) as "no filter"', async (minGames: string) => {
      mockTeamFind(teams);

      const result = await service.findAll(undefined, { minGames });

      expect(result).toHaveLength(3);
      expect(mockGameModel.aggregate).not.toHaveBeenCalled();
    });

    it('truncates a fractional threshold instead of rounding it up', async () => {
      mockTeamFind(teams);
      mockGameAggregate([
        { _id: 'NHL-TOR', count: 4 },
        { _id: 'NHL-VGK', count: 3 },
      ]);

      // 3.9 must behave as 3 (truncated), not 4 (rounded): rounding it up would
      // silently drop NHL-VGK, which does reach the requested threshold.
      const result = await service.findAll(undefined, { minGames: '3.9' });

      expect(mockGameModel.aggregate).toHaveBeenCalledTimes(1);
      expect(result.map((t) => t.uniqueId)).toEqual(['NHL-TOR', 'NHL-VGK']);
    });

    it('still applies the league filter alongside minGames', async () => {
      mockTeamFind(teams);
      mockGameAggregate([{ _id: 'NHL-BOS', count: 12 }]);

      await service.findAll(['NHL'], { minGames: 4 });

      expect(mockTeamModel.find).toHaveBeenCalledWith({
        league: { $in: ['NHL'] },
        // The selection list never offers retired teams either.
        isActive: { $ne: false },
      });
    });

    it('drops teams marked isActive=false even when they reach the threshold', async () => {
      mockTeamFind([
        ...teams,
        {
          uniqueId: 'NHL-ARI',
          label: 'Arizona Coyotes',
          league: 'NHL',
          isActive: false,
        },
      ]);
      mockGameAggregate([
        { _id: 'NHL-BOS', count: 12 },
        { _id: 'NHL-TOR', count: 4 },
        { _id: 'NHL-VGK', count: 3 },
        // The retired team has plenty of counted games: only its `isActive`
        // flag keeps it out of the selection.
        { _id: 'NHL-ARI', count: 30 },
      ]);

      const result = await service.findAll(undefined, { minGames: 4 });

      expect(result.map((t) => t.uniqueId)).toEqual(['NHL-BOS', 'NHL-TOR']);
      expect(mockTeamModel.find).toHaveBeenCalledWith({
        isActive: { $ne: false },
      });
    });

    it('keeps inactive teams in the unfiltered catalog (display is never filtered)', async () => {
      mockTeamFind([
        ...teams,
        {
          uniqueId: 'NHL-ARI',
          label: 'Arizona Coyotes',
          league: 'NHL',
          isActive: false,
        },
      ]);

      const result = await service.findAll();

      expect(result.map((t) => t.uniqueId)).toEqual([
        'NHL-BOS',
        'NHL-TOR',
        'NHL-VGK',
        'NHL-ARI',
      ]);
      expect(mockTeamModel.find).toHaveBeenCalledWith({});
      expect(mockGameModel.aggregate).not.toHaveBeenCalled();
    });

    it('also drops inactive teams on the bootstrap branch (empty query)', async () => {
      // The Mongo filter cannot apply there: the teams come straight from
      // `getTeams()`, so `filterByMinGames()` has to repeat the guard.
      mockTeamFind([]);
      jest.spyOn(service, 'getTeams').mockResolvedValue([
        { uniqueId: 'NHL-BOS', label: 'Boston Bruins', league: 'NHL' },
        {
          uniqueId: 'NHL-ARI',
          label: 'Arizona Coyotes',
          league: 'NHL',
          isActive: false,
        },
      ]);
      mockGameAggregate([
        { _id: 'NHL-BOS', count: 12 },
        { _id: 'NHL-ARI', count: 30 },
      ]);

      const result = await service.findAll(undefined, { minGames: 4 });

      expect(result.map((t) => t.uniqueId)).toEqual(['NHL-BOS']);
    });
  });

  describe('addRecord', () => {
    it('should add a record string with wins and losses', () => {
      const team = { wins: 10, losses: 5 };
      const result = service['addRecord'](team);
      expect(result.record).toBe('10-5');
      expect(result.wins).toBe(10);
    });

    it('should add a record string with wins, losses, and ties', () => {
      const team = { wins: 10, losses: 5, ties: 2 };
      const result = service['addRecord'](team);
      expect(result.record).toBe('10-5-2');
    });

    it('should prioritize otLosses over ties', () => {
      const team = { wins: 10, losses: 5, ties: 2, otLosses: 3 };
      const result = service['addRecord'](team);
      expect(result.record).toBe('10-5-3');
    });

    it('should handle undefined wins/losses as 0', () => {
      const team = { label: 'New Team' };
      const result = service['addRecord'](team);
      expect(result.record).toBe('0-0');
    });

    it('should not add ties if the value is null or undefined', () => {
      const teamWithNull = { wins: 10, losses: 5, ties: null };
      const resultWithNull = service['addRecord'](teamWithNull);
      expect(resultWithNull.record).toBe('10-5');

      const teamWithUndefined = { wins: 10, losses: 5, ties: undefined };
      const resultWithUndefined = service['addRecord'](teamWithUndefined);
      expect(resultWithUndefined.record).toBe('10-5');
    });
  });

  describe('resetLeagueRecords', () => {
    it('zeroes wins/losses/ties/otLosses for every team of the league', async () => {
      mockTeamModel.updateMany.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 32 }),
      });

      const modified = await service.resetLeagueRecords('NHL');

      expect(mockTeamModel.updateMany).toHaveBeenCalledWith(
        { league: 'NHL' },
        { $set: { wins: 0, losses: 0, ties: 0, otLosses: 0 } },
      );
      expect(modified).toBe(32);
    });

    it('returns 0 when nothing was modified', async () => {
      mockTeamModel.updateMany.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      });

      const modified = await service.resetLeagueRecords('PWHL');

      expect(modified).toBe(0);
    });
  });

  describe('Colors Merge Logic (parseExistingColorBlocks & mergeColorsContent)', () => {
    it('should parse existing colors with single/double quotes and whitespace variations', () => {
      const existingContent = `
        export const ColorsTeamEnum = {
          'NHL-BOS': {
            color: '#FFB81C',
            backgroundColor: '#000000',
          },
          "NCAA-ALA": { color: "#9E1B32" , backgroundColor: "#FFFFFF" }
        };
      `;

      const parsed = service['parseExistingColorBlocks'](existingContent);
      expect(parsed.size).toBe(2);
      expect(parsed.get('NHL-BOS')).toEqual({
        color: '#FFB81C',
        backgroundColor: '#000000',
      });
      expect(parsed.get('NCAA-ALA')).toEqual({
        color: '#9E1B32',
        backgroundColor: '#FFFFFF',
      });
    });

    it('should merge new entries without deleting old entries (additive-only)', () => {
      const existingContent = `  'NHL-BOS': {\n    color: '#000000',\n    backgroundColor: '#ffffff',\n  },`;
      const newEntries = [
        { uniqueId: 'NHL-BOS', color: '#FFB81C', backgroundColor: '#000000' }, // Update
        { uniqueId: 'NHL-MTL', color: '#AF1E2D', backgroundColor: '#192168' }, // Add
      ];

      const merged = service['mergeColorsContent'](existingContent, newEntries);

      // The old team (BOS) must be updated
      expect(merged).toContain(
        "'NHL-BOS': {\n    color: '#FFB81C',\n    backgroundColor: '#000000',\n  }",
      );
      // The new team (MTL) must be added
      expect(merged).toContain(
        "'NHL-MTL': {\n    color: '#AF1E2D',\n    backgroundColor: '#192168',\n  }",
      );
    });

    it('should preserve curated colors when the database still has placeholders', () => {
      const existingContent = `  'PWHL-DET': {\n    color: '#C0C0C0',\n    backgroundColor: '#000000',\n  },`;
      const newEntries = [
        {
          uniqueId: 'PWHL-DET',
          color: '#ffffff',
          backgroundColor: '#000000',
        },
        { uniqueId: 'PWHL-HAM' },
      ];

      const merged = service['mergeColorsContent'](existingContent, newEntries);

      expect(merged).toContain(
        "'PWHL-DET': {\n    color: '#C0C0C0',\n    backgroundColor: '#000000',\n  }",
      );
      expect(merged).toContain(
        "'PWHL-HAM': {\n    color: '#ffffff',\n    backgroundColor: '#000000',\n  }",
      );
    });

    it('should keep two non-default colors with the darkest as background', () => {
      const merged = service['mergeColorsContent']('', [
        { uniqueId: 'NHL-BOS', color: '#FFB81C', backgroundColor: '#000000' },
      ]);

      // Gold is lighter than black: it stays the foreground, black the bg.
      expect(merged).toContain(
        "'NHL-BOS': {\n    color: '#FFB81C',\n    backgroundColor: '#000000',\n  }",
      );
    });

    it('should swap when the incoming background is lighter than the color', () => {
      const merged = service['mergeColorsContent']('', [
        { uniqueId: 'TST-A', color: '#111111', backgroundColor: '#EEEEEE' },
      ]);

      expect(merged).toContain(
        "'TST-A': {\n    color: '#EEEEEE',\n    backgroundColor: '#111111',\n  }",
      );
    });

    it('should preserve the stored side when only one incoming side is provided', () => {
      const existingContent = `  'NHL-BOS': {\n    color: '#FFB81C',\n    backgroundColor: '#000000',\n  },`;
      const merged = service['mergeColorsContent'](existingContent, [
        { uniqueId: 'NHL-BOS', color: '#FFB81C' },
      ]);

      // No default dragged in: the stored black background is kept.
      expect(merged).toContain(
        "'NHL-BOS': {\n    color: '#FFB81C',\n    backgroundColor: '#000000',\n  }",
      );
    });

    it('should keep an existing pair when ESPN only knows one side (white background marker)', () => {
      const existingContent = `  'NCAAB-CAM': {\n    color: '#006847',\n    backgroundColor: '#8C9091',\n  },`;
      const merged = service['mergeColorsContent'](existingContent, [
        { uniqueId: 'NCAAB-CAM', color: '#006847', backgroundColor: '#ffffff' },
      ]);

      // The '#ffffff' background is the "no information" marker: the stored
      // real background must be kept, not overwritten with white. The pair
      // is reordered darkest-as-background ('#006847' is darker than grey).
      expect(merged).toContain(
        "'NCAAB-CAM': {\n    color: '#8C9091',\n    backgroundColor: '#006847',\n  }",
      );
    });

    it('should keep an existing pair when ESPN only knows one side (black color marker)', () => {
      const existingContent = `  'TST-B': {\n    color: '#C8102E',\n    backgroundColor: '#003DA5',\n  },`;
      const merged = service['mergeColorsContent'](existingContent, [
        { uniqueId: 'TST-B', color: '#000000', backgroundColor: '#003DA5' },
      ]);

      expect(merged).toContain(
        "'TST-B': {\n    color: '#C8102E',\n    backgroundColor: '#003DA5',\n  }",
      );
    });

    it('should keep existing entries even if they are missing from new entries', () => {
      const existingContent = `  'OLD-TEAM': {\n    color: '#123456',\n    backgroundColor: '#654321',\n  },`;
      const newEntries = [
        { uniqueId: 'NEW-TEAM', color: '#FFFFFF', backgroundColor: '#000000' },
      ];

      const merged = service['mergeColorsContent'](existingContent, newEntries);

      expect(merged).toContain("'OLD-TEAM'");
      expect(merged).toContain("'NEW-TEAM'");
    });
  });

  describe('Logos Merge Logic (parseExistingLogoBlocks & mergeLogosContent)', () => {
    it('should parse existing logos correctly', () => {
      const existingContent = `
        'BOS': 'http://logo.com/bos.png',
        "ALA": "http://logo.com/ala.png",
      `;

      const parsed = service['parseExistingLogoBlocks'](existingContent);
      expect(parsed.get('BOS')).toBe('http://logo.com/bos.png');
      expect(parsed.get('ALA')).toBe('http://logo.com/ala.png');
    });

    it('should preserve existing logo if new logo entry is empty', () => {
      const existingContent = `  'ALA': 'http://logo.com/existing_ala.png',`;
      const newLogos = new Map<string, string>([
        ['ALA', ''], // Empty value
        ['TEX', 'http://logo.com/tex.png'], // New addition
      ]);

      const merged = service['mergeLogosContent'](existingContent, newLogos);

      // Must not overwrite the existing logo with an empty string
      expect(merged).toContain("'ALA': 'http://logo.com/existing_ala.png'");
      expect(merged).toContain("'TEX': 'http://logo.com/tex.png'");
    });

    it('should update existing logo if new logo entry is valid', () => {
      const existingContent = `  'ALA': 'http://logo.com/old_ala.png',`;
      const newLogos = new Map<string, string>([
        ['ALA', 'http://logo.com/new_ala.png'],
      ]);

      const merged = service['mergeLogosContent'](existingContent, newLogos);

      expect(merged).toContain("'ALA': 'http://logo.com/new_ala.png'");
    });
  });

  describe('readExistingFile', () => {
    it('should return file content if file exists', async () => {
      (fs.promises.readFile as jest.Mock).mockResolvedValue('content_data');

      const content = await service['readExistingFile']('some/path.ts');
      expect(content).toBe('content_data');
    });

    it('should return empty string if file reading fails', async () => {
      (fs.promises.readFile as jest.Mock).mockRejectedValue(
        new Error('File not found'),
      );

      const content = await service['readExistingFile']('invalid/path.ts');
      expect(content).toBe('');
    });
  });

  describe('generateLeaguesTeamsAndColorsFiles', () => {
    it('should execute merge and write files', async () => {
      const mockTeams = [
        {
          uniqueId: 'NCAA-ALA',
          label: 'Alabama',
          league: 'NCAA',
          color: '#9E1B32',
          backgroundColor: '#FFFFFF',
          teamLogo: 'http://logo.png',
        },
      ];

      // Mock DB query
      const findChain = {
        sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(mockTeams),
      };
      (model.find as jest.Mock).mockReturnValue(findChain);
      jest.spyOn(service, 'findAllLeagues').mockResolvedValue(['NCAA']);
      (fs.promises.readFile as jest.Mock).mockResolvedValue('');
      (fs.promises.writeFile as jest.Mock).mockResolvedValue(undefined);

      await service['generateLeaguesTeamsAndColorsFiles']();

      // Verify that the 6 file writes (Leagues, Teams, 2x Colors, 2x Logos) took place
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(6);
    });
  });

  describe('dedupOlympicTeams', () => {
    it('keeps a single Olympic entry per country and gender (unified representative ID)', () => {
      const teams = [
        {
          uniqueId: 'OLYMPICS-HOCKEY-MEN-CAN',
          label: 'Canada',
          league: 'OLYMPICS-HOCKEY',
        },
        {
          uniqueId: 'OLYMPICS-BASKETBALL-MEN-CAN',
          label: 'Canada',
          league: 'OLYMPICS-BASKETBALL',
        },
        {
          uniqueId: 'OLYMPICS-BASKETBALL-WOMEN-USA',
          label: 'USA',
          league: 'OLYMPICS-BASKETBALL',
        },
        { uniqueId: 'NHL-BOS', label: 'Boston Bruins', league: 'NHL' },
      ];

      const result = service['dedupOlympicTeams'](teams);

      expect(result).toHaveLength(3);
      // First team in the group wins; its ID is unified to
      // `OLYMPICS-{GENDER}-{COUNTRY}` (no sport segment, neither hockey nor
      // basketball arbitrarily favored).
      expect(result.map((t) => t.uniqueId)).toEqual([
        'OLYMPICS-MEN-CAN',
        'OLYMPICS-WOMEN-USA',
        'NHL-BOS',
      ]);
      expect(result[0].uniqueId).toBe('OLYMPICS-MEN-CAN');
      expect(result[1].uniqueId).toBe('OLYMPICS-WOMEN-USA');
    });

    it('does not deduplicate non-Olympic teams', () => {
      const teams = [
        { uniqueId: 'NHL-BOS', label: 'Boston Bruins', league: 'NHL' },
        { uniqueId: 'NHL-TOR', label: 'Toronto Maple Leafs', league: 'NHL' },
        { uniqueId: 'NBA-LAL', label: 'Lakers', league: 'NBA' },
      ];

      expect(
        service['dedupOlympicTeams'](teams).map((t) => t.uniqueId),
      ).toEqual(['NHL-BOS', 'NHL-TOR', 'NBA-LAL']);
    });

    it('gère un tableau vide ou undefined', () => {
      expect(service['dedupOlympicTeams']([])).toEqual([]);
      expect(
        service['dedupOlympicTeams'](undefined as unknown as any[]),
      ).toEqual([]);
    });
  });

  describe('remove', () => {
    it('should remove a team by its uniqueId and return the deleted document', async () => {
      const uniqueId = 'NHL-BOS';
      (model.findOneAndDelete as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockTeam),
      });

      const result = await service.remove(uniqueId);

      expect(model.findOneAndDelete).toHaveBeenCalledWith({ uniqueId });
      expect(result).toEqual(mockTeam);
    });
  });

  describe('deleteManyByIds', () => {
    it('should return 0 deletedCount when ids array is empty', async () => {
      const result = await service.deleteManyByIds([]);
      expect(result).toEqual({ acknowledged: true, deletedCount: 0 });
      expect(model.deleteMany).not.toHaveBeenCalled();
    });

    it('should call deleteMany with $or filter: uniqueId for all, _id only for valid ObjectIds', async () => {
      const ids = ['NHL-BOS', '60c72b2f9b1d8b2b3c8e4f5a'];
      const deleteResult = { deletedCount: 2, acknowledged: true };

      (model.deleteMany as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(deleteResult),
      });

      const result = await service.deleteManyByIds(ids);

      expect(model.deleteMany).toHaveBeenCalledWith({
        $or: [
          { uniqueId: { $in: ids } },
          { _id: { $in: ['60c72b2f9b1d8b2b3c8e4f5a'] } },
        ],
      });
      expect(result).toEqual(deleteResult);
    });

    it('should not include the _id branch when ids are plain text uniqueIds (no ObjectId)', async () => {
      // Regression test: "PWHL-DET" (and similar textual ids) used to trigger a
      // CastError because they were pushed into $in on the `_id` ObjectId field.
      const ids = ['PWHL-DET', 'PWHL-MTL'];
      const deleteResult = { deletedCount: 4, acknowledged: true };

      (model.deleteMany as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(deleteResult),
      });

      const result = await service.deleteManyByIds(ids);

      expect(model.deleteMany).toHaveBeenCalledWith({
        $or: [{ uniqueId: { $in: ids } }],
      });
      expect(result).toEqual(deleteResult);
    });
  });

  describe('removeByLeague', () => {
    it('should remove all teams from a league and return the operation result', async () => {
      const league = 'NHL';
      const deleteResult = { deletedCount: 15, acknowledged: true };

      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      (model.deleteMany as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(deleteResult),
      });

      const result = await service.removeByLeague(league);

      expect(model.deleteMany).toHaveBeenCalledWith({ league });
      expect(result).toEqual(deleteResult);
      expect(consoleSpy).toHaveBeenCalledWith(
        `Removing teams with league: ${league}`,
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        `Removed ${deleteResult.deletedCount} teams`,
      );

      consoleSpy.mockRestore();
    });
  });

  describe('removeAll', () => {
    it('should call deleteMany and return the result', async () => {
      const deleteResult = { deletedCount: 20, acknowledged: true };
      (model.deleteMany as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(deleteResult),
      });

      const result = await service.removeAll();

      expect(model.deleteMany).toHaveBeenCalledWith({});
      expect(model.find).not.toHaveBeenCalled();
      expect(result).toEqual(deleteResult);
    });
  });

  describe('findStaleTeamCandidates', () => {
    const oldDate = (daysAgo: number) => {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      return d.toISOString();
    };

    it('returns teams older than the cutoff and excludes HistoricalTeams + isActive=false', async () => {
      // find() returns docs already filtered by Mongo on isActive/updateDate;
      // the service only applies the HistoricalTeams + uniqueId filter.
      const docs = [
        { uniqueId: 'NHL-BOS', updateDate: oldDate(90) },
        { uniqueId: 'NHL-ATL', updateDate: oldDate(90) }, // HistoricalTeams → excluded
        { uniqueId: '', updateDate: oldDate(90) }, // no uniqueId → excluded
      ];
      (model.find as jest.Mock).mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(docs),
        }),
      });

      const result = await service.findStaleTeamCandidates();

      expect(model.find).toHaveBeenCalledWith(
        expect.objectContaining({
          isActive: { $ne: false },
          $or: expect.any(Array),
        }),
      );
      expect(result).toEqual([
        { uniqueId: 'NHL-BOS', updateDate: docs[0].updateDate },
      ]);
    });
  });

  describe('purgeStaleTeamsWithoutGames', () => {
    const oldDate = (daysAgo: number) => {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      return d.toISOString();
    };

    const mockFind = (docs: any[]) => {
      (model.find as jest.Mock).mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(docs),
        }),
      });
    };

    it('deletes stale teams not referenced by any active game', async () => {
      mockFind([
        { uniqueId: 'NHL-BOS', league: 'NHL', updateDate: oldDate(90) },
        { uniqueId: 'NHL-TOR', league: 'NHL', updateDate: oldDate(90) },
      ]);
      (model.deleteMany as jest.Mock).mockReturnValue({
        exec: jest
          .fn()
          .mockResolvedValue({ acknowledged: true, deletedCount: 1 }),
      });

      const result = await service.purgeStaleTeamsWithoutGames(
        new Set(['NHL-BOS']),
      );

      expect(result.action).toBe('purged');
      expect(result.candidates).toBe(2);
      expect(result.deletedIds).toEqual(['NHL-TOR']);
      expect(model.deleteMany).toHaveBeenCalledWith({
        $or: [{ uniqueId: { $in: ['NHL-TOR'] } }],
      });
    });

    it('returns none when every stale team is still referenced by a game', async () => {
      mockFind([
        { uniqueId: 'NHL-BOS', league: 'NHL', updateDate: oldDate(90) },
      ]);

      const result = await service.purgeStaleTeamsWithoutGames(
        new Set(['NHL-BOS']),
      );

      expect(result.action).toBe('none');
      expect(result.deletedIds).toEqual([]);
      expect(model.deleteMany).not.toHaveBeenCalled();
    });
  });
});
