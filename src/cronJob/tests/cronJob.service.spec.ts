import { Test, TestingModule } from '@nestjs/testing';
import { GameService } from '../../games/games.service';
import { TeamService } from '../../teams/teams.service';
import { League } from '../../utils/enum';
import * as utils from '../../utils/utils';
import { CronService } from '../cronJob.service';

describe('CronService', () => {
  let service: CronService;

  const mockTeamService = {
    getTeams: jest.fn(),
  };

  const mockGameService = {
    maxYearBeforeDelete: 10,
    getSeasonStatus: jest.fn(),
    getOldiesGames: jest.fn(),
    fetchGamesScores: jest.fn().mockResolvedValue([]),
    getLeagueGames: jest.fn().mockResolvedValue([]),
    getAllGames: jest.fn().mockResolvedValue([]),
    purgeOldestMonth: jest.fn().mockResolvedValue({ action: 'none' }),
    purgeStaleTeamsWithoutGames: jest.fn(),
    getLastRecoveryTimestamp: jest.fn().mockResolvedValue(null),
    addRecoveryTimestamp: jest.fn().mockResolvedValue(undefined),
    isScoreRecoveryRunning: false,
    // Mocked Mongoose model: chainable find/sort/limit/lean/exec returning [].
    // Empty array per league → rotation calls needRefresh(league, { data: [] }),
    // which returns true (nothing stored → refresh needed).
    gameModel: {
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockReturnValue({
              exec: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CronService,
        { provide: TeamService, useValue: mockTeamService },
        { provide: GameService, useValue: mockGameService },
      ],
    }).compile();

    service = module.get<CronService>(CronService);
  });

  describe('getOldGames', () => {
    it('picks a year strictly between minYear and currentYear - 1 (never currentYear)', async () => {
      const currentYear = new Date().getFullYear();
      // Select the first league and max random float (0.999999) -> must map to currentYear - 1
      jest
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0.999999);

      mockGameService.getSeasonStatus.mockResolvedValue({
        league: League.NFL,
        season: currentYear - 1,
        obtained: 3,
        stored: 2,
        complete: false,
        isCurrentSeason: false,
      });

      await service.getOldGames();

      // Must be called with currentYear - 1, not currentYear
      expect(mockGameService.getSeasonStatus).toHaveBeenCalledWith(
        expect.any(String),
        currentYear - 1,
      );
      expect(mockGameService.getOldiesGames).toHaveBeenCalledWith(
        String(currentYear - 1),
        expect.any(String),
      );
      (Math.random as any).mockRestore();
    });

    it('should skip a past complete season without refreshing it', async () => {
      // Select the first league and the first (past) year in the range (minYear).
      jest.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0);

      // All seasons complete (including past ones) -> nothing to refresh
      mockGameService.getSeasonStatus.mockResolvedValue({
        obtained: 3,
        stored: 3,
        complete: true,
        isCurrentSeason: false,
      });

      // Stub console to avoid noise
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();

      await service.getOldGames();

      // No season was refreshed because all years are already complete & past
      expect(mockGameService.getOldiesGames).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'no modification; will be retried on a later day',
        ),
      );

      consoleSpy.mockRestore();
      (Math.random as jest.Mock).mockRestore();
    });

    it('should refresh a past incomplete season', async () => {
      const currentYear = new Date().getFullYear();
      const minYear = currentYear - mockGameService.maxYearBeforeDelete;
      // Select the first league and minYear: random = 0
      jest
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0);

      // Past season incomplete -> it is refreshed
      mockGameService.getSeasonStatus.mockResolvedValue({
        league: League.NFL,
        season: minYear,
        obtained: 3,
        stored: 2,
        complete: false,
        isCurrentSeason: false,
      });

      await service.getOldGames();

      expect(mockGameService.getOldiesGames).toHaveBeenCalledWith(
        String(minYear),
        expect.any(String),
      );
      (Math.random as jest.Mock).mockRestore();
    });
  });

  describe('onModuleInit', () => {
    it('schedules a season-gated recovery fetch (getAllGames with today) at restart — only if no recovery ran in the last 6h', async () => {
      jest.useFakeTimers();
      try {
        await service.onModuleInit();
        await jest.advanceTimersByTimeAsync(120000);

        expect(mockGameService.getAllGames).toHaveBeenCalledWith(
          false,
          expect.any(Date),
        );
        expect(mockGameService.addRecoveryTimestamp).toHaveBeenCalled();
        // the pre-existing 30 s score recovery also fires within the window
        expect(mockGameService.fetchGamesScores).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('skips the recovery fetch when a recovery timestamp is younger than 6h', async () => {
      mockGameService.getLastRecoveryTimestamp.mockResolvedValueOnce(
        new Date(), // recent recovery → skip
      );
      jest.useFakeTimers();
      try {
        await service.onModuleInit();
        await jest.advanceTimersByTimeAsync(120000);

        expect(mockGameService.getAllGames).not.toHaveBeenCalled();
        expect(mockGameService.addRecoveryTimestamp).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('refreshLeaguesOneByOne (league rotation)', () => {
    beforeEach(() => {
      (service as any).rotationDayKey = '';
      (service as any).rotatingLeagueCursor = 0;
      (service as any).rotatingLeaguesDone = false;
      (service as any).isRotatingLeagueInProgress = false;
      mockGameService.isScoreRecoveryRunning = false;
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not run before the 4 AM NY window', async () => {
      jest.useFakeTimers();
      // 06:00Z = 02:00 America/New_York (EDT) — window still closed
      jest.setSystemTime(new Date('2026-09-13T06:00:00Z'));

      await service.refreshLeaguesOneByOne();

      expect(mockGameService.getLeagueGames).not.toHaveBeenCalled();
    });

    it('does not run after the 11 AM NY window', async () => {
      jest.useFakeTimers();
      // 16:00Z = 12:00 America/New_York (EDT) — window closed
      jest.setSystemTime(new Date('2026-09-13T16:00:00Z'));

      await service.refreshLeaguesOneByOne();

      expect(mockGameService.getLeagueGames).not.toHaveBeenCalled();
    });

    it('refreshes ONE league per tick in enum order (season-gated)', async () => {
      jest.useFakeTimers();
      // 08:00Z = 04:00 America/New_York (EDT) — window opens
      jest.setSystemTime(new Date('2026-09-13T08:00:00Z'));
      const seasonSpy = jest.spyOn(utils, 'isCurrentSeason').mockResolvedValue(true);
      const playoffsSpy = jest.spyOn(utils, 'isPlayoffsPeriod').mockResolvedValue(false);

      await service.refreshLeaguesOneByOne();
      await service.refreshLeaguesOneByOne();
      await service.refreshLeaguesOneByOne();

      expect(mockGameService.getLeagueGames).toHaveBeenCalledTimes(3);
      expect(mockGameService.getLeagueGames).toHaveBeenNthCalledWith(1, {
        league: League.NHL,
      });
      expect(mockGameService.getLeagueGames).toHaveBeenNthCalledWith(2, {
        league: League.NFL,
      });
      expect(mockGameService.getLeagueGames).toHaveBeenNthCalledWith(3, {
        league: League.NBA,
      });

      seasonSpy.mockRestore();
      playoffsSpy.mockRestore();
    });

    it('skips recently-refreshed leagues without fetching (slot still consumed)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-13T08:00:00Z'));
      // needRefresh governs the rotation (1/3/7-day freshness): NHL was
      // refreshed recently → skipped; NFL is stale → fetched.
      const needRefreshSpy = jest
        .spyOn(utils, 'needRefresh')
        .mockImplementation(async (league) => league === League.NFL);

      await service.refreshLeaguesOneByOne(); // NHL → fresh → skipped
      expect(mockGameService.getLeagueGames).not.toHaveBeenCalled();

      await service.refreshLeaguesOneByOne(); // NFL → stale → fetched
      expect(mockGameService.getLeagueGames).toHaveBeenCalledTimes(1);
      expect(mockGameService.getLeagueGames).toHaveBeenCalledWith({
        league: League.NFL,
      });

      needRefreshSpy.mockRestore();
    });

    it('stops once the list is complete until the next day', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-13T08:00:00Z'));
      const seasonSpy = jest.spyOn(utils, 'isCurrentSeason').mockResolvedValue(true);
      const playoffsSpy = jest.spyOn(utils, 'isPlayoffsPeriod').mockResolvedValue(false);
      const total = Object.values(League).length;

      for (let i = 0; i < total; i++) {
        await service.refreshLeaguesOneByOne();
      }
      expect(mockGameService.getLeagueGames).toHaveBeenCalledTimes(total);

      // Same day, after the 11 AM window → idle
      jest.setSystemTime(new Date('2026-09-13T20:00:00Z'));
      await service.refreshLeaguesOneByOne();
      expect(mockGameService.getLeagueGames).toHaveBeenCalledTimes(total);

      // Next day, 4 AM NY window → new cycle from the top
      jest.setSystemTime(new Date('2026-09-14T08:00:00Z'));
      await service.refreshLeaguesOneByOne();
      expect(mockGameService.getLeagueGames).toHaveBeenCalledTimes(total + 1);
      expect(mockGameService.getLeagueGames).toHaveBeenLastCalledWith({
        league: League.NHL,
      });

      seasonSpy.mockRestore();
      playoffsSpy.mockRestore();
    });

    it('postpones a tick while the score recovery cycle runs (slot not consumed)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-13T08:00:00Z'));
      const seasonSpy = jest.spyOn(utils, 'isCurrentSeason').mockResolvedValue(true);
      const playoffsSpy = jest.spyOn(utils, 'isPlayoffsPeriod').mockResolvedValue(false);
      mockGameService.isScoreRecoveryRunning = true;

      await service.refreshLeaguesOneByOne();
      expect(mockGameService.getLeagueGames).not.toHaveBeenCalled();

      mockGameService.isScoreRecoveryRunning = false;
      await service.refreshLeaguesOneByOne();
      expect(mockGameService.getLeagueGames).toHaveBeenCalledWith({
        league: League.NHL,
      });

      seasonSpy.mockRestore();
      playoffsSpy.mockRestore();
    });

    it('skips the fast crons while the rotation is running (no overlap)', async () => {
      (service as any).isRotatingLeagueInProgress = true;

      await service.fetchAndApplyScores();
      expect(mockGameService.fetchGamesScores).not.toHaveBeenCalled();

      await service.checkLeagueGamesAvailability();
      expect(mockGameService.getLeagueGames).not.toHaveBeenCalled();

      (service as any).isRotatingLeagueInProgress = false;
    });
  });

  describe('purgeOldestMonth (twice-daily time-based purge)', () => {
    it('calls gameService.purgeOldestMonth', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      mockGameService.purgeOldestMonth = jest.fn().mockResolvedValue({
        action: 'purged',
        purgedYear: 2016,
        purgedMonth: 9,
        deletedCount: 296,
        remainingYears: [2016, 2017],
      });

      await service.purgeOldestMonth();

      expect(mockGameService.purgeOldestMonth).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[Cron] Purged 296 games from 2016-09. Remaining years: 2016, 2017',
      );
      consoleSpy.mockRestore();
    });

    it('logs when no games to purge', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      mockGameService.purgeOldestMonth = jest
        .fn()
        .mockResolvedValue({ action: 'none' });

      await service.purgeOldestMonth();

      expect(consoleSpy).toHaveBeenCalledWith('[Cron] No games to purge.');
      consoleSpy.mockRestore();
    });

    it('logs purged month details', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      mockGameService.purgeOldestMonth = jest.fn().mockResolvedValue({
        action: 'purged',
        purgedYear: 2016,
        purgedMonth: 9,
        deletedCount: 296,
        remainingYears: [2016, 2017],
      });

      await service.purgeOldestMonth();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Cron] Purged 296 games from 2016-09. Remaining years: 2016, 2017',
      );
      consoleSpy.mockRestore();
    });

    it('handles errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockGameService.purgeOldestMonth = jest
        .fn()
        .mockRejectedValue(new Error('DB error'));

      await service.purgeOldestMonth();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Cron] Error running monthly purge:',
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe('purgeStaleTeams (weekly stale-teams purge)', () => {
    it('refreshes teams first then purges and logs the result', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      mockTeamService.getTeams = jest.fn().mockResolvedValue([]);
      mockGameService.purgeStaleTeamsWithoutGames = jest
        .fn()
        .mockResolvedValue({
          action: 'purged',
          candidates: 2,
          deletedCount: 1,
          deletedIds: ['NHL-TOR'],
        });

      await service.purgeStaleTeams();

      expect(mockTeamService.getTeams).toHaveBeenCalled();
      expect(
        mockGameService.purgeStaleTeamsWithoutGames,
      ).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[Cron] Purged 1 stale team(s): NHL-TOR',
      );
      consoleSpy.mockRestore();
    });

    it('logs when there is nothing to purge', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      mockTeamService.getTeams = jest.fn().mockResolvedValue([]);
      mockGameService.purgeStaleTeamsWithoutGames = jest
        .fn()
        .mockResolvedValue({
          action: 'none',
          candidates: 0,
          deletedCount: 0,
          deletedIds: [],
        });

      await service.purgeStaleTeams();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Cron] No stale teams to purge (0 candidate(s)).',
      );
      consoleSpy.mockRestore();
    });

    it('handles errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockTeamService.getTeams = jest
        .fn()
        .mockRejectedValue(new Error('DB error'));

      await service.purgeStaleTeams();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Cron] Error running stale teams purge:',
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });
});
