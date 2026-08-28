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

  const mockGameModel = {
    find: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(),
    countDocuments: jest.fn(),
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

  describe('getSeasonStatus', () => {
    let fetchUniqueSpy: jest.SpyInstance;

    beforeEach(() => {
      // Stub the dry-run fetch to avoid real network calls
      fetchUniqueSpy = jest
        .spyOn(service as any, '_fetchUniqueGames')
        .mockResolvedValue([
          { uniqueId: 'g1' },
          { uniqueId: 'g2' },
          { uniqueId: 'g3' },
        ]);
      mockGameModel.countDocuments.mockResolvedValue(3);
    });

    afterEach(() => {
      fetchUniqueSpy.mockRestore();
    });

    it('should mark a past season as complete when all obtained games are stored', async () => {
      // A past season (isCurrentSeason returns false for the representative date)
      const isCurrentSeasonSpy = jest
        .spyOn(utils, 'isCurrentSeason')
        .mockResolvedValue(false);

      const status = await service.getSeasonStatus(League.NHL, 2023);

      expect(status).toEqual({
        league: League.NHL,
        season: 2023,
        obtained: 3,
        stored: 3,
        complete: true,
        isCurrentSeason: false,
      });
      expect(mockGameModel.countDocuments).toHaveBeenCalledWith({
        league: League.NHL,
        uniqueId: { $in: ['g1', 'g2', 'g3'] },
      });

      isCurrentSeasonSpy.mockRestore();
    });

    it('should mark a past season as incomplete when DB has fewer games than the API', async () => {
      const isCurrentSeasonSpy = jest
        .spyOn(utils, 'isCurrentSeason')
        .mockResolvedValue(false);
      mockGameModel.countDocuments.mockResolvedValue(2);

      const status = await service.getSeasonStatus(League.NBA, 2022);

      expect(status.complete).toBe(false);
      expect(status.stored).toBe(2);
      expect(status.obtained).toBe(3);

      isCurrentSeasonSpy.mockRestore();
    });

    it('should not trust the comparison for the current season (always complete)', async () => {
      // Current season -> isCurrentSeason returns true
      const isCurrentSeasonSpy = jest
        .spyOn(utils, 'isCurrentSeason')
        .mockResolvedValue(true);
      // DB would be partial (e.g. mid-season)
      mockGameModel.countDocuments.mockResolvedValue(1);

      const status = await service.getSeasonStatus(League.MLB, 2024);

      expect(status.isCurrentSeason).toBe(true);
      expect(status.complete).toBe(true);
      expect(status.stored).toBe(1);

      isCurrentSeasonSpy.mockRestore();
    });

    it('should short-circuit for PWHL seasons before 2024 (no-op complete)', async () => {
      const status = await service.getSeasonStatus(League.PWHL, 2023);

      expect(status).toEqual({
        league: League.PWHL,
        season: 2023,
        obtained: 0,
        stored: 0,
        complete: true,
        isCurrentSeason: false,
      });
      // Should not hit the fetch nor the DB count
      expect(fetchUniqueSpy).not.toHaveBeenCalled();
      expect(mockGameModel.countDocuments).not.toHaveBeenCalled();
    });
  });

  describe('getOldiesGames', () => {
    let getLeagueGamesSpy: jest.SpyInstance;

    beforeEach(() => {
      mockTeamService.findAll.mockResolvedValue([
        { league: League.NHL },
        { league: League.PWHL },
      ]);
      getLeagueGamesSpy = jest
        .spyOn(service, 'getLeagueGames')
        .mockResolvedValue([]);
    });

    afterEach(() => {
      getLeagueGamesSpy.mockRestore();
    });

    it('should throw when an explicit year is out of the allowed range', async () => {
      const currentYear = new Date().getFullYear();
      const tooOld = currentYear - service.maxYearBeforeDelete - 1;

      await expect(service.getOldiesGames(String(tooOld))).rejects.toThrow(
        'The year parameter must be a valid year',
      );
      expect(getLeagueGamesSpy).not.toHaveBeenCalled();
    });

    it('should loop over the last 5 seasons when no year is specified', async () => {
      const currentYear = new Date().getFullYear();
      const expectedYears = [];
      for (
        let y = currentYear;
        y > currentYear - service.maxYearBeforeDelete;
        y--
      ) {
        expectedYears.push(y);
      }

      const result = await service.getOldiesGames(undefined, League.NHL);

      // One league x each of the last 5 years
      expect(getLeagueGamesSpy).toHaveBeenCalledTimes(expectedYears.length);
      for (const year of expectedYears) {
        expect(getLeagueGamesSpy).toHaveBeenCalledWith(
          expect.objectContaining({ league: League.NHL, season: year }),
        );
      }
      expect(result.message).toContain('History recovery');
    });

    it('should process a single explicit year with a league filter', async () => {
      const currentYear = new Date().getFullYear();

      const result = await service.getOldiesGames(
        String(currentYear - 1),
        League.NHL,
      );

      expect(getLeagueGamesSpy).toHaveBeenCalledTimes(1);
      expect(getLeagueGamesSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          league: League.NHL,
          season: currentYear - 1,
        }),
      );
      expect(result.message).toContain(String(currentYear - 1));
    });
  });
  describe('removeStaleUnresolvedGames', () => {
    it('should remove active games unresolved for more than the max age', async () => {
      const removeSpy = jest
        .spyOn(service, 'remove')
        .mockResolvedValue({} as any);
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();

      const staleGames = [
        { uniqueId: 'PWHL-foo', league: League.PWHL },
        { uniqueId: 'NHL-bar', league: League.NHL },
      ];
      mockGameModel.exec.mockResolvedValue(staleGames);

      await (service as any).removeStaleUnresolvedGames(90);

      expect(removeSpy).toHaveBeenCalledTimes(2);
      expect(removeSpy).toHaveBeenCalledWith('PWHL-foo');
      expect(removeSpy).toHaveBeenCalledWith('NHL-bar');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('active game(s) unresolved'),
      );

      removeSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('should not call remove when there is no stale game', async () => {
      const removeSpy = jest
        .spyOn(service, 'remove')
        .mockResolvedValue({} as any);
      mockGameModel.exec.mockResolvedValue([]);

      await (service as any).removeStaleUnresolvedGames(90);

      expect(removeSpy).not.toHaveBeenCalled();
      removeSpy.mockRestore();
    });
  });
});
