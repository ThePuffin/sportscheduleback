import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { TeamService } from '../../teams/teams.service';
import { League } from '../../utils/enum';
import * as utils from '../../utils/utils';
import { GameService } from '../games.service';
import { RefreshTimestampService } from '../refresh-timestamps.service';
import { Game } from '../schemas/game.schema';

describe('GameService', () => {
  let service: GameService;
  let gameModel: any;
  let teamService: TeamService;

  const mockGameModel = {
    find: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(),
  };

  const mockTeamService = {
    countByLeague: jest.fn(),
    findAll: jest.fn(),
  };

  const mockRefreshTimestampService = {
    getLastRefresh: jest.fn(),
    addTimestamp: jest.fn(),
    getTodayManualTimestamps: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameService,
        {
          provide: getModelToken(Game.name),
          useValue: mockGameModel,
        },
        {
          provide: TeamService,
          useValue: mockTeamService,
        },
        {
          provide: RefreshTimestampService,
          useValue: mockRefreshTimestampService,
        },
      ],
    }).compile();

    service = module.get<GameService>(GameService);
    gameModel = module.get(getModelToken(Game.name));
    teamService = module.get<TeamService>(TeamService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkLeagueGamesAvailability', () => {
    it('should skip execution if already running', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      // Access private member to simulate it's already running
      (service as any).isCheckingAvailability = true;

      await service.checkLeagueGamesAvailability();

      expect(consoleSpy).toHaveBeenCalledWith(
        'checkLeagueGamesAvailability is already running.',
      );
      consoleSpy.mockRestore();
    });

    it('should trigger getLeagueGames when games count is below threshold (30% of teams)', async () => {
      // Mock isCurrentSeason to return true only for NHL to isolate the test
      const isCurrentSeasonSpy = jest
        .spyOn(utils, 'isCurrentSeason')
        .mockImplementation(async (league) => league === League.NHL);
      const getLeagueGamesSpy = jest
        .spyOn(service, 'getLeagueGames')
        .mockResolvedValue([]);

      // Setup: 10 teams in NHL, but only 2 games found in DB (2 < 10 * 0.3)
      mockTeamService.countByLeague.mockResolvedValue(10);
      mockGameModel.exec.mockResolvedValue([
        { uniqueId: 'game1' },
        { uniqueId: 'game2' },
      ]);

      await service.checkLeagueGamesAvailability();

      expect(getLeagueGamesSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          league: League.NHL,
          forceUpdate: true,
          skipCascade: false,
          maxRecall: 5,
        }),
      );

      isCurrentSeasonSpy.mockRestore();
    });

    it('should not refresh games if count is above or equal to threshold', async () => {
      const isCurrentSeasonSpy = jest
        .spyOn(utils, 'isCurrentSeason')
        .mockImplementation(async (league) => league === League.NHL);
      const getLeagueGamesSpy = jest
        .spyOn(service, 'getLeagueGames')
        .mockResolvedValue([]);
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();

      // Setup: 10 teams, 4 games found (4 >= 10 * 0.3)
      mockTeamService.countByLeague.mockResolvedValue(10);
      mockGameModel.exec.mockResolvedValue([{}, {}, {}, {}]);

      await service.checkLeagueGamesAvailability();

      expect(getLeagueGamesSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ league: League.NHL }),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Found 4 games for league NHL in the next 7 days. No refresh needed.',
        ),
      );

      consoleSpy.mockRestore();
      isCurrentSeasonSpy.mockRestore();
    });
  });
});
