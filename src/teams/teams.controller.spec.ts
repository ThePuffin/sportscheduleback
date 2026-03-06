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


});
