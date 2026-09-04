import { Test, TestingModule } from '@nestjs/testing';
import { GameService } from '../../games/games.service';
import { TeamService } from '../../teams/teams.service';
import { CronService } from '../cronJob.service';

describe('CronService', () => {
  let service: CronService;

  const mockTeamService = {
    getTeams: jest.fn(),
  };

  const mockGameService = {
    maxYearBeforeDelete: 5,
    getSeasonStatus: jest.fn(),
    getOldiesGames: jest.fn(),
    fetchGamesScores: jest.fn().mockResolvedValue([]),
    getLeagueGames: jest.fn(),
    getAllGames: jest.fn(),
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
    it('should refresh the current season even when status is complete', async () => {
      const currentYear = new Date().getFullYear();
      // Select the first league and the current year (the last year in the range).
      jest
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0.999999);

      // getSeasonStatus returns isCurrentSeason=true for the current year
      mockGameService.getSeasonStatus.mockImplementation(
        (league: string, year: number) => {
          if (year === currentYear) {
            return {
              league,
              season: year,
              obtained: 3,
              stored: 3,
              complete: true,
              isCurrentSeason: true,
            };
          }
          return {
            league,
            season: year,
            obtained: 3,
            stored: 3,
            complete: true,
            isCurrentSeason: false,
          };
        },
      );

      await service.getOldGames();

      // The current season must be refreshed regardless of the "complete" flag
      expect(mockGameService.getOldiesGames).toHaveBeenCalledWith(
        String(currentYear),
        expect.any(String),
      );
      (Math.random as any).mockRestore();
    });

    it('should skip a past complete season without refreshing it', async () => {
      // Select the first league and the first (past) year in the range.
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
      // Select the first league and the year immediately before the current one.
      jest
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0.7);

      // One past season incomplete -> it is refreshed
      mockGameService.getSeasonStatus.mockImplementation(
        (league: string, year: number) => {
          if (year === currentYear - 1) {
            return {
              league,
              season: year,
              obtained: 3,
              stored: 2,
              complete: false,
              isCurrentSeason: false,
            };
          }
          return {
            league,
            season: year,
            obtained: 3,
            stored: 3,
            complete: true,
            isCurrentSeason: false,
          };
        },
      );

      await service.getOldGames();

      expect(mockGameService.getOldiesGames).toHaveBeenCalledWith(
        String(currentYear - 1),
        expect.any(String),
      );
      (Math.random as jest.Mock).mockRestore();
    });
  });
});
