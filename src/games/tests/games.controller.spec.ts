import { Test, TestingModule } from '@nestjs/testing';
import { CreateGameDto } from '../dto/create-game.dto';
import { UpdateGameDto } from '../dto/update-game.dto';
import { GamesController } from '../games.controller';
import { GameService } from '../games.service';

// --- Données de test (Mocks) ---
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

// --- Simulation du Service ---
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
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

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('devrait être défini', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    it('devrait retourner un tableau de matchs', async () => {
      expect(await controller.findAll()).toEqual(mockGames);
      expect(service.findAll).toHaveBeenCalled();
    });
  });

  describe('findByTeam', () => {
    it('devrait retourner les matchs pour une équipe donnée', async () => {
      const teamId = 'NHL-BOS';
      await controller.findByTeam(teamId);
      expect(service.findByTeam).toHaveBeenCalledWith(teamId);
    });
  });

  describe('filterGames', () => {
    it('devrait appeler le service avec les bons paramètres de filtre', async () => {
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
    it("devrait retourner l'intervalle de dates", async () => {
      await controller.getDateRange();
      expect(service.getDateRange).toHaveBeenCalled();
    });
  });

  describe('findByDate', () => {
    it('devrait retourner les matchs pour une date donnée', async () => {
      const date = '2024-10-10';
      await controller.findByDate(date);
      expect(service.findByDate).toHaveBeenCalledWith(date);
    });
  });

  describe('findByDateHour', () => {
    it('devrait retourner les matchs groupés par heure pour une date', async () => {
      const date = '2024-10-10';
      await controller.findByDateHour(date);
      expect(service.findByDateHour).toHaveBeenCalledWith(date);
    });
  });

  describe('findByLeague', () => {
    it('devrait retourner les matchs pour une ligue', async () => {
      const league = 'NHL';
      await controller.findByLeague(league);
      expect(service.findByLeague).toHaveBeenCalledWith(league, undefined);
    });

    it('devrait retourner les matchs pour une ligue avec une limite', async () => {
      const league = 'NHL';
      const maxResults = 5;
      await controller.findByLeague(league, maxResults);
      expect(service.findByLeague).toHaveBeenCalledWith(league, maxResults);
    });
  });

  describe('findOne', () => {
    it('devrait retourner un seul match', async () => {
      const uniqueId = '2024-NHL-123';
      await controller.findOne(uniqueId);
      expect(service.findOne).toHaveBeenCalledWith(uniqueId);
    });
  });

  describe('create', () => {
    it('devrait appeler le service pour créer un match', async () => {
      await controller.create(mockCreateDto);
      expect(service.create).toHaveBeenCalledWith(mockCreateDto);
    });
  });

  describe('refresh', () => {
    it('devrait rafraîchir tous les matchs', async () => {
      await controller.refresh();
      expect(service.getAllGames).toHaveBeenCalled();
    });
  });

  describe('refreshByLeague', () => {
    it('devrait rafraîchir les matchs pour une ligue', async () => {
      const league = 'NHL';
      await controller.refreshByLeague(league);
      expect(service.getLeagueGames).toHaveBeenCalledWith(league, true, true);
    });
  });

  describe('fetchScores', () => {
    it('devrait récupérer les scores des matchs', async () => {
      await controller.fetchScores();
      expect(service.fetchGamesScores).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('devrait mettre à jour un match', async () => {
      const uniqueId = '2024-NHL-123';
      await controller.update(uniqueId, mockUpdateDto);
      expect(service.update).toHaveBeenCalledWith(uniqueId, mockUpdateDto);
    });
  });

  describe('removeLeague', () => {
    it('devrait supprimer les matchs pour une ligue', async () => {
      const league = 'NHL';
      await controller.removeLeague(league);
      expect(service.removeLeague).toHaveBeenCalledWith(league);
    });
  });

  describe('removeAll', () => {
    it('devrait supprimer tous les matchs', async () => {
      await controller.removeAll();
      expect(service.removeAll).toHaveBeenCalled();
    });
  });

  describe('removeDuplicate', () => {
    it('devrait supprimer les doublons et les anciens matchs', async () => {
      await controller.removeDuplicate();
      expect(service.removeDuplicatesAndOlds).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('devrait supprimer un seul match', async () => {
      const uniqueId = '2024-NHL-123';
      await controller.remove(uniqueId);
      expect(service.remove).toHaveBeenCalledWith(uniqueId);
    });
  });
});
