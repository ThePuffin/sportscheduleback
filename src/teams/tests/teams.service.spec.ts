import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import { TeamType } from '../../utils/interface/team';
import { Team } from '../schemas/team.schema';
import { TeamService } from '../teams.service';

// A mocked team object
const mockTeam: TeamType = {
  uniqueId: 'NHL-BOS',
  label: 'Boston Bruins',
  league: 'NHL',
  wins: 10,
  losses: 5,
  otLosses: 2,
} as TeamType;

// We only mock the model methods used in the tested functions
const mockTeamModel = {
  findOneAndDelete: jest.fn(),
  deleteMany: jest.fn(),
  find: jest.fn(),
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

  describe('remove', () => {
    it('should remove a team by its uniqueId and return the deleted document', async () => {
      const uniqueId = 'NHL-BOS';
      // Mock chain calls: findOneAndDelete(...).exec()
      (model.findOneAndDelete as jest.Mock).mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockTeam),
      });

      const result = await service.remove(uniqueId);

      expect(model.findOneAndDelete).toHaveBeenCalledWith({ uniqueId });
      expect(result).toEqual(mockTeam);
    });
  });

  describe('removeByLeague', () => {
    it('should remove all teams from a league and return the operation result', async () => {
      const league = 'NHL';
      const deleteResult = { deletedCount: 15, acknowledged: true };

      // Spy on console.log to avoid polluting test output
      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      // Mock chain calls: deleteMany(...).exec()
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

      // Restore console.log
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

      // Check that deleteMany was called with an empty object
      expect(model.deleteMany).toHaveBeenCalledWith({});
      // Check that find is no longer called
      expect(model.find).not.toHaveBeenCalled();
      // Check that the operation result is correctly returned
      expect(result).toEqual(deleteResult);
    });
  });
});
