import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import * as fs from 'node:fs';
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
});
