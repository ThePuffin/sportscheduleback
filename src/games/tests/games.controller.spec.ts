import { Test, TestingModule } from '@nestjs/testing';
import { CreateGameDto } from '../dto/create-game.dto';
import { UpdateGameDto } from '../dto/update-game.dto';
import { GamesController } from '../games.controller';
import { GameService } from '../games.service';

// --- Test data (Mocks) ---
const mockGame = {
  uniqueId: '2024-NHL-123',
  homeTeam: 'Boston Bruins',
  awayTeam: 'Buffalo Sabres',
};
const mockGames = [mockGame];
const mockCreateDto: CreateGameDto = {
  uniqueId: '2024-NHL-456',
} as CreateGameDto;
const mockUpdateDto = { homeTeamScore: 3 } as UpdateGameDto;

// --- Service Simulation ---
const mockGameService = {
  findAll: jest.fn().mockResolvedValue(mockGames),
  findByTeam: jest.fn().mockResolvedValue({ '2024-10-10': [mockGame] }),
  filterGames: jest.fn().mockResolvedValue({ '2024-10-10': [mockGame] }),
  getDateRange: jest
    .fn()
    .mockResolvedValue({ minDate: '2024-01-01', maxDate: '2024-12-31' }),
  findByDate: jest.fn().mockResolvedValue(mockGames),
  findByDateHour: jest.fn().mockResolvedValue({ '19:00': mockGames }),
  findByLeague: jest.fn().mockResolvedValue(mockGames),
  findOne: jest.fn().mockResolvedValue(mockGame),
  create: jest.fn().mockResolvedValue(mockGame),
  getAllGames: jest.fn().mockResolvedValue(mockGames),
  getLeagueGames: jest.fn().mockResolvedValue(mockGames),
  fetchGamesScores: jest.fn().mockResolvedValue([{ success: true }]),
  update: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  removeLeague: jest.fn().mockResolvedValue({ deletedCount: 10 }),
  removeAll: jest.fn().mockResolvedValue({ deletedCount: 100 }),
  removeDuplicatesAndOlds: jest.fn().mockResolvedValue({ success: true }),
  remove: jest.fn().mockResolvedValue(mockGame),
};

describe('GamesController', () => {
  let controller: GamesController;
  let service: GameService;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      controllers: [GamesController],
      providers: [
        {
          provide: GameService,
          useValue: mockGameService,
        },
      ],
    }).compile();

    controller = module.get<GamesController>(GamesController);
    service = module.get<GameService>(GameService);
  });

  afterEach(async () => {
    await module.close();
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    it('should return an array of games', async () => {
      expect(await controller.findAll()).toEqual(mockGames);
      expect(service.findAll).toHaveBeenCalled();
    });
  });

  describe('findByTeam', () => {
    it('should return games for a given team', async () => {
      const teamId = 'NHL-BOS';
      await controller.findByTeam(teamId);
      expect(service.findByTeam).toHaveBeenCalledWith(teamId);
    });
  });

  describe('filterGames', () => {
    it('should call the service with the correct filter parameters', async () => {
      const query = {
        startDate: '2024-10-01',
        endDate: '2024-10-31',
        teamSelectedIds: 'NHL-BOS,NBA-LAL',
      };
      await controller.filterGames(
        query.startDate,
        query.endDate,
        query.teamSelectedIds,
      );
      expect(service.filterGames).toHaveBeenCalledWith(query);
    });
  });

  describe('getDateRange', () => {
    it('should return the date range', async () => {
      await controller.getDateRange();
      expect(service.getDateRange).toHaveBeenCalled();
    });
  });

  describe('findByDate', () => {
    it('should return games for a given date', async () => {
      const date = '2024-10-10';
      await controller.findByDate(date);
      expect(service.findByDate).toHaveBeenCalledWith(date);
    });
  });

  describe('findByDateHour', () => {
    it('should return games grouped by hour for a date', async () => {
      const date = '2024-10-10';
      await controller.findByDateHour(date);
      expect(service.findByDateHour).toHaveBeenCalledWith(date);
    });
  });

  describe('findByLeague', () => {
    it('should return games for a league', async () => {
      const league = 'NHL';
      await controller.findByLeague(league);
      expect(service.findByLeague).toHaveBeenCalledWith(league, undefined);
    });

    it('should return games for a league with a limit', async () => {
      const league = 'NHL';
      const maxResults = 5;
      await controller.findByLeague(league, maxResults);
      expect(service.findByLeague).toHaveBeenCalledWith(league, maxResults);
    });
  });

  describe('findOne', () => {
    it('should return a single game', async () => {
      const uniqueId = '2024-NHL-123';
      await controller.findOne(uniqueId);
      expect(service.findOne).toHaveBeenCalledWith(uniqueId);
    });
  });

  describe('create', () => {
    it('should call the service to create a game', async () => {
      await controller.create(mockCreateDto);
      expect(service.create).toHaveBeenCalledWith(mockCreateDto);
    });
  });

  describe('refresh', () => {
    it('should refresh all games', async () => {
      await controller.refresh();
      expect(service.getAllGames).toHaveBeenCalled();
    });
  });

  describe('refreshByLeague', () => {
    it('should refresh games for a league', async () => {
      const league = 'NHL';
      await controller.refreshByLeague(league);
      expect(service.getLeagueGames).toHaveBeenCalledWith(league, true, true);
    });
  });

  describe('fetchScores', () => {
    it('should fetch game scores', async () => {
      await controller.fetchScores();
      expect(service.fetchGamesScores).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update a game', async () => {
      const uniqueId = '2024-NHL-123';
      await controller.update(uniqueId, mockUpdateDto);
      expect(service.update).toHaveBeenCalledWith(uniqueId, mockUpdateDto);
    });
  });

  describe('removeLeague', () => {
    it('should remove games for a league', async () => {
      const league = 'NHL';
      await controller.removeLeague(league);
      expect(service.removeLeague).toHaveBeenCalledWith(league);
    });
  });

  describe('removeAll', () => {
    it('should remove all games', async () => {
      await controller.removeAll();
      expect(service.removeAll).toHaveBeenCalled();
    });
  });

  describe('removeDuplicate', () => {
    it('should remove duplicates and old games', async () => {
      await controller.removeDuplicate();
      expect(service.removeDuplicatesAndOlds).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should remove a single game', async () => {
      const uniqueId = '2024-NHL-123';
      await controller.remove(uniqueId);
      expect(service.remove).toHaveBeenCalledWith(uniqueId);
    });
  });
});
