import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TeamType } from '../utils/interface/team';
import { UpdateTeamDto } from './dto/update-team.dto';
import { TeamsController } from './teams.controller';
import { TeamService } from './teams.service';

// 1. Test data simulating what the database might return.
const mockTeams: TeamType[] = [
  {
    uniqueId: 'NHL-BOS',
    label: 'Boston Bruins',
    league: 'NHL',
  } as TeamType,
  {
    uniqueId: 'NBA-LAL',
    label: 'Los Angeles Lakers',
    league: 'NBA',
  } as TeamType,
];

// A single mock team for findOne and remove tests
const mockTeam: TeamType = {
  uniqueId: 'NHL-BOS',
  label: 'Boston Bruins',
  league: 'NHL',
} as TeamType;

// Mock DTO for update tests
const mockUpdateDto = {
  label: 'Boston Bruins Updated',
} as UpdateTeamDto;

// 2. Creation of a "mock" (simulation) of the TeamService.
// jest.fn() creates a mock function that we can spy on.
const mockTeamService = {
  findAll: jest.fn().mockResolvedValue(mockTeams),
  findAllLeagues: jest.fn().mockResolvedValue(['NHL', 'NBA']),
  findByLeague: jest.fn().mockResolvedValue([mockTeam]),
  findOne: jest.fn().mockResolvedValue(mockTeam),
  getTeams: jest.fn().mockResolvedValue({ success: true }),
  update: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  remove: jest.fn().mockResolvedValue(mockTeam),
  removeAll: jest.fn().mockResolvedValue({ deletedCount: 2 }),
  removeByLeague: jest.fn().mockResolvedValue({ deletedCount: 1 }),
};

describe('TeamsController', () => {
  let controller: TeamsController;
  let service: TeamService;

  beforeEach(async () => {
    // 3. Creation of a lightweight test module with the controller and the mocked service.
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TeamsController],
      providers: [
        {
          provide: TeamService,
          useValue: mockTeamService, // We replace the real service with our mock
        },
      ],
    }).compile();

    controller = module.get<TeamsController>(TeamsController);
    service = module.get<TeamService>(TeamService); // We can also retrieve the mock if needed
  });

  // Reset mocks before each test
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    it('should return an array of teams', async () => {
      expect(await controller.findAll()).toEqual(mockTeams);
      expect(service.findAll).toHaveBeenCalled();
    });
  });

  describe('findLeagues', () => {
    it('should return an array of league strings', async () => {
      const leagues = ['NHL', 'NBA'];
      expect(await controller.findLeagues()).toEqual(leagues);
      expect(service.findAllLeagues).toHaveBeenCalled();
    });
  });

  describe('findByLeague', () => {
    it('should return an array of teams for a given league', async () => {
      const league = 'NHL';
      expect(await controller.findByLeague(league)).toEqual([mockTeam]);
      expect(service.findByLeague).toHaveBeenCalledWith(league);
    });
  });

  describe('findOne', () => {
    it('should return a single team when a valid uniqueId is provided', async () => {
      const uniqueId = 'NHL-BOS';
      // The mock is already configured to return mockTeam for this uniqueId
      expect(await controller.findOne(uniqueId)).toEqual(mockTeam);
      expect(service.findOne).toHaveBeenCalledWith(uniqueId);
    });

    it('should return null when an invalid uniqueId is provided', async () => {
      const uniqueId = 'INVALID-ID';
      // We override the mock for this specific test case
      (service.findOne as jest.Mock).mockResolvedValue(null);

      expect(await controller.findOne(uniqueId)).toBeNull();
      expect(service.findOne).toHaveBeenCalledWith(uniqueId);
    });

    it('should propagate exceptions from the service', async () => {
      const uniqueId = 'ERROR-ID';
      const error = new NotFoundException(`Team with ID ${uniqueId} not found`);
      // We override the mock for this specific test case to throw an error
      (service.findOne as jest.Mock).mockRejectedValue(error);

      // We expect the controller's method to reject with the same error
      await expect(controller.findOne(uniqueId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should update a team and return the result', async () => {
      const uniqueId = 'NHL-BOS';
      expect(await controller.update(uniqueId, mockUpdateDto)).toEqual({
        modifiedCount: 1,
      });
      expect(service.update).toHaveBeenCalledWith(uniqueId, mockUpdateDto);
    });
  });

  describe('refresh', () => {
    it('should call the getTeams service method without a league parameter', async () => {
      expect(await controller.refresh()).toEqual({ success: true });
      expect(service.getTeams).toHaveBeenCalledWith(undefined);
    });

    it('should call the getTeams service method with a league parameter', async () => {
      const leagueParam = 'NHL';
      expect(await controller.refresh(leagueParam)).toEqual({ success: true });
      expect(service.getTeams).toHaveBeenCalledWith(leagueParam);
    });
  });

  describe('removeAll', () => {
    it('should remove all teams and return the result', async () => {
      expect(await controller.removeAll()).toEqual({ deletedCount: 2 });
      expect(service.removeAll).toHaveBeenCalled();
    });
  });

  describe('removeByLeague', () => {
    it('should remove all teams for a given league and return the result', async () => {
      const league = 'NHL';
      expect(await controller.removeByLeague(league)).toEqual({
        deletedCount: 1,
      });
      expect(service.removeByLeague).toHaveBeenCalledWith(league);
    });
  });

  describe('remove', () => {
    it('should remove a single team by uniqueId and return the deleted team', async () => {
      const uniqueId = 'NHL-BOS';
      expect(await controller.remove(uniqueId)).toEqual(mockTeam);
      expect(service.remove).toHaveBeenCalledWith(uniqueId);
    });
  });
});
