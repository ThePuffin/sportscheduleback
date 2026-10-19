import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { TeamService } from '../../teams/teams.service';
import { Colors, DEFAULT_TEAM_COLORS } from '../../utils/Colors';
import { League } from '../../utils/enum';
import { HockeyData } from '../../utils/fetchData/hockeyData';
import * as utils from '../../utils/utils';
import { GameService } from '../games.service';
import { RefreshTimestampService } from '../refresh-timestamps.service';
import { Game } from '../schemas/game.schema';

describe('GameService', () => {
  let service: GameService;

  const mockGameModel = {
    find: jest.fn().mockReturnThis(),
    findOne: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(),
    countDocuments: jest.fn(),
    distinct: jest.fn(),
    aggregate: jest.fn(),
    deleteMany: jest.fn(),
    // Default to an exec-able result: several paths chain `.exec()` on it
    // (record propagation, series propagation, deactivation).
    updateMany: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(undefined),
    }),
    findOneAndDelete: jest.fn(),
    updateOne: jest.fn(),
  };

  const mockTeamService = {
    countByLeague: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn().mockResolvedValue(undefined),
    deleteManyByIds: jest.fn(),
    takeLastPurgedNonD1Ids: jest.fn().mockReturnValue([]),
    purgeStaleTeamsWithoutGames: jest.fn(),
    updateRecord: jest.fn().mockResolvedValue(undefined),
    updateRecords: jest.fn().mockResolvedValue(undefined),
    resetLeagueRecords: jest.fn().mockResolvedValue(0),
    clearActiveGameCountCache: jest.fn(),
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

  describe('_resolveTeamColors', () => {
    afterEach(() => {
      delete (Colors as any)['NCAAF-COLORTEST'];
    });

    it('keeps stored colors when they are not the placeholder', () => {
      const colors = (service as any)._resolveTeamColors({
        uniqueId: 'NCAAB-DUKE',
        color: '#00539b',
        backgroundColor: '#ffffff',
      });

      expect(colors).toEqual({
        color: '#00539b',
        backgroundColor: '#ffffff',
      });
    });

    it('borrows the colors from the same university in another college league', () => {
      Colors['NCAAF-COLORTEST'] = {
        color: '#111111',
        backgroundColor: '#222222',
      };

      const colors = (service as any)._resolveTeamColors(
        { color: '#ffffff', backgroundColor: '#000000' },
        'NCAAB-COLORTEST',
      );

      expect(colors).toEqual({
        color: '#111111',
        backgroundColor: '#222222',
      });
    });

    it('uses the default placeholder for non-college leagues', () => {
      const colors = (service as any)._resolveTeamColors(
        { color: '#ffffff', backgroundColor: '#000000' },
        'NHL-NOPE',
      );

      expect(colors).toEqual(DEFAULT_TEAM_COLORS);
    });

    it('treats stored degenerate (color === background) colors as unknown and borrows from another league', () => {
      Colors['NCAAF-COLORTEST'] = {
        color: '#111111',
        backgroundColor: '#222222',
      };

      const colors = (service as any)._resolveTeamColors(
        { color: '#000000', backgroundColor: '#000000' },
        'NCCABB-COLORTEST',
      );

      expect(colors).toEqual({
        color: '#111111',
        backgroundColor: '#222222',
      });
    });

    it('falls back to the default placeholder when the stored colors are degenerate and no league helps', () => {
      const colors = (service as any)._resolveTeamColors(
        { color: '#000000', backgroundColor: '#000000' },
        'NHL-NOPE',
      );

      expect(colors).toEqual(DEFAULT_TEAM_COLORS);
    });
  });

  describe('syncGameWithScore — PWHL historical records', () => {
    it('persists the season record without replacing the current team record', async () => {
      const save = jest.fn().mockResolvedValue(undefined);
      const game: any = {
        league: League.PWHL,
        gameStatus: 'SCHEDULED',
        homeTeamId: 'PWHL-BOS',
        awayTeamId: 'PWHL-MIN',
        homeTeamScore: 3,
        awayTeamScore: 1,
        startTimeUTC: '2024-05-29T23:00:00.000Z',
        save,
      };

      await (service as any).syncGameWithScore(
        {
          gameStatus: 'FINISHED',
          isFinal: true,
          homeTeamScore: 3,
          awayTeamScore: 1,
          homeTeamRecord: '19-6-3',
          awayTeamRecord: '16-8-4',
        },
        game,
      );

      expect(game.homeTeamRecord).toBe('19-6-3');
      expect(game.awayTeamRecord).toBe('16-8-4');
      expect(mockTeamService.updateRecord).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncGameWithScore — series info', () => {
    const buildGame = () =>
      ({
        league: League.MLB,
        // Already FINISHED: the record-derivation branch only runs on the
        // LIVE → FINISHED transition and is irrelevant to these assertions.
        gameStatus: 'FINISHED',
        homeTeamId: 'MLB-MIL',
        awayTeamId: 'MLB-LAD',
        homeTeamScore: 7,
        awayTeamScore: 4,
        startTimeUTC: '2026-10-12T21:00:00.000Z',
        seriesSummary: 'NLCS - Game 2',
        seriesStatus: 'MIL leads 2-1',
        save: jest.fn().mockResolvedValue(undefined),
      }) as any;

    beforeEach(() => {
      // The series propagation below chains `.exec()` on `updateMany`.
      mockGameModel.updateMany.mockReturnValue({
        exec: jest.fn().mockResolvedValue(undefined),
      });
    });

    it('keeps stored series fields when the fresh payload carries none', async () => {
      const game = buildGame();

      await (service as any).syncGameWithScore(
        {
          gameStatus: 'FINISHED',
          isFinal: true,
          homeTeamScore: 7,
          awayTeamScore: 4,
          homeTeamRecord: '103-59',
          awayTeamRecord: '100-62',
          seriesSummary: '',
          seriesStatus: '',
        },
        game,
      );

      expect(game.seriesSummary).toBe('NLCS - Game 2');
      expect(game.seriesStatus).toBe('MIL leads 2-1');
      expect(game.save).toHaveBeenCalledTimes(1);
    });

    it('overwrites stored series fields with a fresh non-empty value', async () => {
      const game = buildGame();

      await (service as any).syncGameWithScore(
        {
          gameStatus: 'FINISHED',
          isFinal: true,
          homeTeamScore: 7,
          awayTeamScore: 4,
          homeTeamRecord: '103-59',
          awayTeamRecord: '100-62',
          seriesSummary: 'NLCS - Game 3',
          seriesStatus: 'MIL leads 3-1',
        },
        game,
      );

      expect(game.seriesSummary).toBe('NLCS - Game 3');
      expect(game.seriesStatus).toBe('MIL leads 3-1');
    });

    it('keeps a stored series evolution when the fresh status is not an evolution', async () => {
      const game = buildGame();

      await (service as any).syncGameWithScore(
        {
          gameStatus: 'FINISHED',
          isFinal: true,
          homeTeamScore: 7,
          awayTeamScore: 4,
          homeTeamRecord: '103-59',
          awayTeamRecord: '100-62',
          seriesSummary: 'NLCS - Game 3',
          // A round label must never replace a stored evolution, otherwise
          // the display would fall back from "MIL leads 2-1" to
          // "NLCS - Game 3".
          seriesStatus: 'NLCS - Game 3',
        },
        game,
      );

      expect(game.seriesStatus).toBe('MIL leads 2-1');
      // The round label itself still follows the fresh payload.
      expect(game.seriesSummary).toBe('NLCS - Game 3');
    });

    it('updates a stored non-evolution label with any fresh non-empty value', async () => {
      const game = buildGame();
      // PWHL labels every game "Game N": not an evolution, so the previous
      // non-empty rule still applies to it.
      game.seriesStatus = 'Game 2';

      await (service as any).syncGameWithScore(
        {
          gameStatus: 'FINISHED',
          isFinal: true,
          homeTeamScore: 7,
          awayTeamScore: 4,
          seriesSummary: 'Game 3',
          seriesStatus: 'Game 3',
        },
        game,
      );

      expect(game.seriesStatus).toBe('Game 3');
    });

    it('never lets a game-number label overwrite a stored evolution', async () => {
      const game = buildGame();

      await (service as any).syncGameWithScore(
        {
          gameStatus: 'FINISHED',
          isFinal: true,
          homeTeamScore: 7,
          awayTeamScore: 4,
          seriesSummary: 'NLCS - Game 3',
          seriesStatus: 'Game 3',
        },
        game,
      );

      expect(game.seriesStatus).toBe('MIL leads 2-1');
      expect(game.seriesSummary).toBe('NLCS - Game 3');
    });

    it('propagates the refreshed record onto the season games of both teams', async () => {
      const propagateSpy = jest
        .spyOn(service as any, '_propagateTeamRecordToSeasonGames')
        .mockResolvedValue(0);
      const game = buildGame();

      await (service as any).syncGameWithScore(
        {
          gameStatus: 'FINISHED',
          isFinal: true,
          homeTeamScore: 7,
          awayTeamScore: 4,
          homeTeamRecord: '103-59',
          awayTeamRecord: '100-62',
        },
        game,
      );

      expect(propagateSpy).toHaveBeenCalledWith('MLB', 'MLB-MIL', '103-59');
      expect(propagateSpy).toHaveBeenCalledWith('MLB', 'MLB-LAD', '100-62');
      propagateSpy.mockRestore();
    });

    it('replaces a stored series evolution when the fresh payload has no seriesStatus but a valid seriesSummary evolution', async () => {
      const game = buildGame();
      // Reproduces the reported bug: stored "CLE leads series 2-1", ESPN
      // reports the current evolution only in seriesSummary ("Series tied 2-2")
      // while seriesStatus comes back empty.
      game.seriesStatus = 'CLE leads series 2-1';
      game.seriesSummary = 'ALDS - Game 3';

      await (service as any).syncGameWithScore(
        {
          gameStatus: 'FINISHED',
          isFinal: true,
          homeTeamScore: 7,
          awayTeamScore: 3,
          homeTeamRecord: '100-62',
          awayTeamRecord: '97-65',
          seriesSummary: 'Series tied 2-2',
          seriesStatus: '',
        },
        game,
      );

      expect(game.seriesSummary).toBe('Series tied 2-2');
      expect(game.seriesStatus).toBe('Series tied 2-2');
      expect(game.save).toHaveBeenCalledTimes(1);
    });

    it('propagates the refreshed series status to all other games of the same series', async () => {
      const game = buildGame();
      game._id = 'game-4-id';
      game.seriesStatus = 'CLE leads series 2-1';
      game.seriesSummary = 'ALDS - Game 4';

      await (service as any).syncGameWithScore(
        {
          gameStatus: 'FINISHED',
          isFinal: true,
          homeTeamScore: 7,
          awayTeamScore: 3,
          seriesSummary: 'Series tied 2-2',
          seriesStatus: '',
        },
        game,
      );

      // The primary game is updated.
      expect(game.seriesStatus).toBe('Series tied 2-2');

      // All other games of the same series (same league, same two teams,
      // either home/away direction) are updated too.
      expect(mockGameModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          league: League.MLB,
          _id: { $ne: 'game-4-id' },
          $or: [
            { homeTeamId: 'MLB-MIL', awayTeamId: 'MLB-LAD' },
            { homeTeamId: 'MLB-LAD', awayTeamId: 'MLB-MIL' },
          ],
          seriesSummary: { $exists: true, $nin: [null, ''] },
          seriesStatus: { $ne: 'Series tied 2-2' },
        }),
        { $set: { seriesStatus: 'Series tied 2-2' } },
      );
    });

    it('replaces a stale stored seriesStatus when ESPN seriesStatus is stale but seriesSummary is more advanced', async () => {
      const game = buildGame();
      game.seriesStatus = 'CLE leads series 2-1';
      game.seriesSummary = 'ALCS - Game 4';

      // ESPN reports seriesStatus with the OLD value ("CLE leads series 2-1")
      // but seriesSummary with the NEW, more advanced value ("Series tied 2-2").
      await (service as any).syncGameWithScore(
        {
          gameStatus: 'FINISHED',
          isFinal: true,
          homeTeamScore: 3,
          awayTeamScore: 5,
          seriesSummary: 'Series tied 2-2',
          seriesStatus: 'CLE leads series 2-1',
        },
        game,
      );

      // seriesStatus must be replaced by the more advanced evolution from
      // seriesSummary (total 4 > total 3).
      expect(game.seriesSummary).toBe('Series tied 2-2');
      expect(game.seriesStatus).toBe('Series tied 2-2');
      expect(game.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('create — playoff series fields', () => {
    const buildStoredGame = () =>
      ({
        uniqueId: 'MLB-MIL-LAD-2026-10-14-3',
        league: League.MLB,
        seriesSummary: 'NLCS - Game 3',
        seriesStatus: 'MIL leads 3-0',
        save: jest.fn().mockResolvedValue(undefined),
      }) as any;

    const givenStoredGame = (game: any) => {
      // `findOne()` chains `.exec()` on the model mock.
      mockGameModel.exec.mockResolvedValue(game);
    };

    it('keeps a stored series evolution when the refresh payload carries no status', async () => {
      const stored = buildStoredGame();
      givenStoredGame(stored);

      await service.create({
        uniqueId: stored.uniqueId,
        // The team-schedule endpoint used by the refresh cron carries no
        // `series.summary` at all, so the mapping emits an empty status.
        seriesStatus: '',
        seriesSummary: 'NLCS - Game 3',
      } as any);

      expect(stored.seriesStatus).toBe('MIL leads 3-0');
      expect(stored.seriesSummary).toBe('NLCS - Game 3');
      expect(stored.save).toHaveBeenCalledTimes(1);
    });

    it('keeps a stored series evolution when the fresh status is a round label', async () => {
      const stored = buildStoredGame();
      givenStoredGame(stored);

      await service.create({
        uniqueId: stored.uniqueId,
        seriesStatus: 'NLDS - Game 3',
        seriesSummary: 'NLDS - Game 3',
      } as any);

      expect(stored.seriesStatus).toBe('MIL leads 3-0');
    });

    it('replaces a stored series evolution with a fresh evolution', async () => {
      const stored = buildStoredGame();
      givenStoredGame(stored);

      await service.create({
        uniqueId: stored.uniqueId,
        seriesStatus: 'MIL wins series 4-0',
        seriesSummary: 'NLCS - Game 4',
      } as any);

      expect(stored.seriesStatus).toBe('MIL wins series 4-0');
      expect(stored.seriesSummary).toBe('NLCS - Game 4');
    });

    it('accepts a tied-series evolution as a replacement', async () => {
      const stored = buildStoredGame();
      stored.seriesStatus = 'MIL leads 3-2';
      givenStoredGame(stored);

      await service.create({
        uniqueId: stored.uniqueId,
        seriesStatus: 'Series tied 3-3',
      } as any);

      expect(stored.seriesStatus).toBe('Series tied 3-3');
    });

    it('keeps a stored round label when the fresh summary is empty', async () => {
      const stored = buildStoredGame();
      givenStoredGame(stored);

      await service.create({
        uniqueId: stored.uniqueId,
        seriesSummary: '',
      } as any);

      expect(stored.seriesSummary).toBe('NLCS - Game 3');
    });

    it('stores a series evolution on a game that has none', async () => {
      const stored = buildStoredGame();
      stored.seriesSummary = '';
      stored.seriesStatus = '';
      givenStoredGame(stored);

      await service.create({
        uniqueId: stored.uniqueId,
        seriesStatus: 'MIL leads 3-0',
        seriesSummary: 'NLCS - Game 3',
      } as any);

      expect(stored.seriesStatus).toBe('MIL leads 3-0');
      expect(stored.seriesSummary).toBe('NLCS - Game 3');
    });

    it('never moves a decided series backwards (wins 4-0 kept over leads 3-0)', async () => {
      const stored = buildStoredGame();
      stored.seriesStatus = 'MIL wins series 4-0';
      givenStoredGame(stored);

      await service.create({
        uniqueId: stored.uniqueId,
        seriesStatus: 'MIL leads 3-0',
        seriesSummary: 'NLCS - Game 4',
      } as any);

      expect(stored.seriesStatus).toBe('MIL wins series 4-0');
    });

    it('rejects an impossible fresh evolution (8-0) and self-heals it later', async () => {
      const stored = buildStoredGame();
      givenStoredGame(stored);

      await service.create({
        uniqueId: stored.uniqueId,
        seriesStatus: 'MIL wins series 8-0',
        seriesSummary: 'NLCS - Game 4',
      } as any);

      expect(stored.seriesStatus).toBe('MIL leads 3-0');

      await service.create({
        uniqueId: stored.uniqueId,
        seriesStatus: 'MIL wins series 4-0',
        seriesSummary: 'NLCS - Game 4',
      } as any);

      expect(stored.seriesStatus).toBe('MIL wins series 4-0');
    });

    it('never replaces a stored evolution with a game-number label', async () => {
      const stored = buildStoredGame();
      givenStoredGame(stored);

      await service.create({
        uniqueId: stored.uniqueId,
        seriesStatus: 'Game 3',
        seriesSummary: 'NLCS - Game 3',
      } as any);

      expect(stored.seriesStatus).toBe('MIL leads 3-0');

      await service.create({
        uniqueId: stored.uniqueId,
        seriesStatus: 'NLCS - Game 4',
        seriesSummary: 'NLCS - Game 4',
      } as any);

      expect(stored.seriesStatus).toBe('MIL leads 3-0');
    });

    it('reroutes a game-number label to the summary when no status is stored', async () => {
      const stored = buildStoredGame();
      stored.seriesStatus = '';
      stored.seriesSummary = '';
      givenStoredGame(stored);

      await service.create({
        uniqueId: stored.uniqueId,
        seriesStatus: 'Game 3',
      } as any);

      expect(stored.seriesStatus ?? '').toBe('');
      expect(stored.seriesSummary).toBe('Game 3');
    });
  });

  describe('_propagateTeamRecordToSeasonGames', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('writes the record onto the current-season regular-season games of the team', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));

      const updated = await (service as any)._propagateTeamRecordToSeasonGames(
        'NHL',
        'NHL-OTT',
        '5-2-0',
      );

      // The mocked model resolves no result: nothing to count.
      expect(updated).toBe(0);
      expect(mockGameModel.updateMany).toHaveBeenCalledTimes(1);
      const [filter, pipeline] = mockGameModel.updateMany.mock.calls[0];
      expect(filter).toEqual({
        league: 'NHL',
        isActive: true,
        gameDate: { $gte: '2026-10-01' },
        recordSeasonType: { $in: [2, null] },
        $or: [{ homeTeamId: 'NHL-OTT' }, { awayTeamId: 'NHL-OTT' }],
        $expr: expect.any(Object),
      });
      expect(pipeline[0].$set.homeTeamRecord.$cond).toEqual([
        { $eq: ['$homeTeamId', 'NHL-OTT'] },
        '5-2-0',
        '$homeTeamRecord',
      ]);
      // The opponent's side of each game keeps its own value.
      expect(pipeline[0].$set.awayTeamRecord.$cond).toEqual([
        { $eq: ['$awayTeamId', 'NHL-OTT'] },
        '5-2-0',
        '$awayTeamRecord',
      ]);
    });

    it('never touches games outside the regular season window (off-season)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));

      await (service as any)._propagateTeamRecordToSeasonGames(
        'NHL',
        'NHL-OTT',
        '5-2-0',
      );

      expect(mockGameModel.updateMany).not.toHaveBeenCalled();
    });

    it('leaves the season games alone once the playoffs have started', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));

      await (service as any)._propagateTeamRecordToSeasonGames(
        'NHL',
        'NHL-OTT',
        '5-2-0',
      );

      expect(mockGameModel.updateMany).not.toHaveBeenCalled();
    });

    it('skips leagues without a usable season window', async () => {
      await (service as any)._propagateTeamRecordToSeasonGames(
        'OLYMPICS',
        'OLYMPICS-MEN-FIN-W',
        '3-1-0',
      );

      expect(mockGameModel.updateMany).not.toHaveBeenCalled();
    });

    it('fails soft when the write rejects', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockGameModel.updateMany.mockReturnValueOnce({
        exec: jest.fn().mockRejectedValue(new Error('disk full')),
      });

      const updated = await (service as any)._propagateTeamRecordToSeasonGames(
        'NHL',
        'NHL-OTT',
        '5-2-0',
      );

      expect(updated).toBe(0);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('_persistMissingHistoricalGameTeams', () => {
    it('stores unknown historical teams as inactive records with their ESPN ids', async () => {
      mockTeamService.findAll.mockResolvedValue([{ uniqueId: 'NHL-BOS' }]);

      const count = await (service as any)._persistMissingHistoricalGameTeams(
        'NHL',
        [
          {
            homeTeamId: 'NHL-ARI',
            homeTeamESPNId: '12',
            homeTeam: 'Arizona Coyotes',
            homeTeamShort: 'ARI',
            homeTeamLogo: 'https://example.test/ari.png',
            awayTeamId: 'NHL-BOS',
            awayTeamESPNId: '1',
            awayTeam: 'Boston Bruins',
            awayTeamShort: 'BOS',
          },
          {
            homeTeamId: 'NHL-ARI',
            homeTeamESPNId: '12',
            homeTeam: 'Arizona Coyotes',
            homeTeamShort: 'ARI',
          },
        ],
      );

      expect(count).toBe(1);
      expect(mockTeamService.create).toHaveBeenCalledTimes(1);
      expect(mockTeamService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          uniqueId: 'NHL-ARI',
          id: '12',
          abbrev: 'ARI',
          label: 'Arizona Coyotes',
          league: 'NHL',
          isActive: false,
        }),
        true,
      );
    });
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

  describe('_enrichGameWithTeamData Olympic logos', () => {
    it('uses gender-independent country flags for missing team and game logos', () => {
      const enriched = (service as any)._enrichGameWithTeamData(
        {
          homeTeamId: 'OLYMPICS-WOMEN-FIN-W',
          homeTeamShort: 'FIN-W',
          homeTeamLogo: '',
          homeTeamLogoDark: '',
          awayTeamId: 'OLYMPICS-MEN-KOR-M',
          awayTeamShort: 'KOR-M',
          awayTeamLogo: '',
          awayTeamLogoDark: '',
        },
        new Map(),
      );

      expect(enriched.homeTeamLogo).toBe(
        'https://a.espncdn.com/i/teamlogos/countries/500/fin.png',
      );
      expect(enriched.homeTeamLogoDark).toBe(enriched.homeTeamLogo);
      expect(enriched.awayTeamLogo).toBe(
        'https://a.espncdn.com/i/teamlogos/countries/500/kor.png',
      );
      expect(enriched.awayTeamLogoDark).toBe(enriched.awayTeamLogo);
    });

    it('preserves existing logos for non-Olympic games', () => {
      const game = {
        homeTeamId: 'NHL-BOS',
        homeTeamShort: 'BOS',
        homeTeamLogo: 'https://example.test/bos.png',
        homeTeamLogoDark: 'https://example.test/bos-dark.png',
        awayTeamId: 'NHL-TOR',
        awayTeamShort: 'TOR',
        awayTeamLogo: 'https://example.test/tor.png',
        awayTeamLogoDark: 'https://example.test/tor-dark.png',
      };

      const enriched = (service as any)._enrichGameWithTeamData(
        game,
        new Map(),
      );

      expect(enriched.homeTeamLogo).toBe(game.homeTeamLogo);
      expect(enriched.homeTeamLogoDark).toBe(game.homeTeamLogoDark);
      expect(enriched.awayTeamLogo).toBe(game.awayTeamLogo);
      expect(enriched.awayTeamLogoDark).toBe(game.awayTeamLogoDark);
    });
  });

  describe('_enrichGameWithTeamData playoff status and records', () => {
    it('shows the playoff series status in priority of the season record', () => {
      const game = {
        homeTeamId: 'MLB-MIL',
        awayTeamId: 'MLB-LAD',
        homeTeamRecord: '103-59',
        awayTeamRecord: '100-62',
        recordSeasonType: 3,
        seriesSummary: 'NLCS - Game 2',
        seriesStatus: 'MIL leads 2-1',
      };

      const enriched = (service as any)._enrichGameWithTeamData(
        game,
        new Map(),
      );

      // Both record slots show the series status (display-time only).
      expect(enriched.homeTeamRecord).toBe('MIL leads 2-1');
      expect(enriched.awayTeamRecord).toBe('MIL leads 2-1');
      // The raw fields pass through untouched.
      expect(enriched.seriesSummary).toBe('NLCS - Game 2');
      expect(enriched.seriesStatus).toBe('MIL leads 2-1');
    });

    it('falls back to the series label when the status is empty (finished playoff game)', () => {
      const game = {
        homeTeamId: 'MLB-MIL',
        awayTeamId: 'MLB-LAD',
        homeTeamRecord: '103-59',
        awayTeamRecord: '100-62',
        recordSeasonType: 3,
        seriesSummary: 'NLCS - Game 2',
        seriesStatus: '',
      };

      const enriched = (service as any)._enrichGameWithTeamData(
        game,
        new Map(),
      );

      expect(enriched.homeTeamRecord).toBe('NLCS - Game 2');
      expect(enriched.awayTeamRecord).toBe('NLCS - Game 2');
    });

    it('keeps the season record for a playoff game without any series info', () => {
      const game = {
        homeTeamId: 'NFL-CHI',
        awayTeamId: 'NFL-DET',
        homeTeamRecord: '1-0-0',
        awayTeamRecord: '0-1-0',
        recordSeasonType: 3,
        seriesSummary: '',
        seriesStatus: '',
      };

      const enriched = (service as any)._enrichGameWithTeamData(
        game,
        new Map(),
      );

      expect(enriched.homeTeamRecord).toBe('1-0-0');
      expect(enriched.awayTeamRecord).toBe('0-1-0');
    });

    it('shows the playoff round label of a single-game round', () => {
      const game = {
        homeTeamId: 'NFL-CHI',
        awayTeamId: 'NFL-DET',
        homeTeamRecord: '1-0-0',
        awayTeamRecord: '0-1-0',
        recordSeasonType: 3,
        seriesSummary: 'NFC Wild Card',
        seriesStatus: '',
      };

      const enriched = (service as any)._enrichGameWithTeamData(
        game,
        new Map(),
      );

      expect(enriched.homeTeamRecord).toBe('NFC Wild Card');
      expect(enriched.awayTeamRecord).toBe('NFC Wild Card');
      expect(enriched.seriesSummary).toBe('NFC Wild Card');
    });

    it('keeps the season record for regular-season games even with a series note', () => {
      const game = {
        homeTeamId: 'MLB-NYY',
        awayTeamId: 'MLB-BOS',
        homeTeamRecord: '80-60',
        awayTeamRecord: '75-65',
        recordSeasonType: 2,
        seriesSummary: 'Regular Season',
        seriesStatus: 'NYY leads 2-1',
      };

      const enriched = (service as any)._enrichGameWithTeamData(
        game,
        new Map(),
      );

      expect(enriched.homeTeamRecord).toBe('80-60');
      expect(enriched.awayTeamRecord).toBe('75-65');
    });

    it('decides from the label for legacy documents without a stored phase', () => {
      const playoffLegacy = (service as any)._enrichGameWithTeamData(
        {
          homeTeamId: 'MLB-LAD',
          awayTeamId: 'MLB-MIL',
          homeTeamRecord: '100-62',
          awayTeamRecord: '103-59',
          seriesSummary: 'ALCS - Game 2',
          seriesStatus: '',
        },
        new Map(),
      );
      expect(playoffLegacy.homeTeamRecord).toBe('ALCS - Game 2');
      expect(playoffLegacy.awayTeamRecord).toBe('ALCS - Game 2');

      const regularLegacy = (service as any)._enrichGameWithTeamData(
        {
          homeTeamId: 'MLB-NYY',
          awayTeamId: 'MLB-BOS',
          homeTeamRecord: '80-60',
          awayTeamRecord: '75-65',
          seriesSummary: 'Game 2 of 3',
          seriesStatus: '',
        },
        new Map(),
      );
      expect(regularLegacy.homeTeamRecord).toBe('80-60');
      expect(regularLegacy.awayTeamRecord).toBe('75-65');
    });
  });

  describe('computed series status (no stored seriesStatus)', () => {
    let gameSeq = 0;
    const playoffGame = (overrides: any = {}) => {
      gameSeq += 1;
      return {
        uniqueId: `g${gameSeq}`,
        league: 'MLB',
        gameDate: '2026-10-15',
        startTimeUTC: `2026-10-15T2${gameSeq % 10}:00:00Z`,
        homeTeamId: 'MLB-MIL',
        awayTeamId: 'MLB-LAD',
        homeTeamShort: 'MIL',
        awayTeamShort: 'LAD',
        recordSeasonType: 3,
        seriesStatus: '',
        seriesSummary: '',
        ...overrides,
      };
    };

    beforeEach(() => {
      gameSeq = 0;
    });

    // NOTE: `playoffGame()` auto-assigns a distinct `uniqueId` AND a distinct
    // start time per game, so fixtures built without explicit overrides are
    // never mistaken for duplicates (same teams at the same hour) by the
    // slot-dedupe of `_computeSeriesStatus`.

    describe('_computeSeriesStatus', () => {
      it('prefers the last game stored evolution over recomputation (decided series)', () => {
        const seriesGames = [
          { ...playoffGame(), homeTeamScore: 5, awayTeamScore: 3 },
          {
            ...playoffGame(),
            uniqueId: 'g4',
            startTimeUTC: '2026-10-16T23:00:00Z',
            gameDate: '2026-10-16',
            homeTeamScore: 6,
            awayTeamScore: 4,
            // Clincher (16 oct.): authoritative final status.
            seriesStatus: 'MIL wins series 4-0',
          },
        ];
        const current = { ...playoffGame(), uniqueId: 'g1' };
        expect((service as any)._computeSeriesStatus(seriesGames, current)).toBe(
          'MIL wins series 4-0',
        );
      });

      it('shows the ongoing-series status from the last game on every game', () => {
        const seriesGames = [
          {
            ...playoffGame(),
            startTimeUTC: '2026-10-15T23:00:00Z',
            homeTeamScore: 6,
            awayTeamScore: 2,
            seriesStatus: 'MIL leads 3-0',
          },
          { ...playoffGame(), uniqueId: 'g4', startTimeUTC: '2026-10-18T23:00:00Z' },
        ];
        const future = {
          ...playoffGame(),
          uniqueId: 'g4',
          startTimeUTC: '2026-10-18T23:00:00Z',
        };
        expect((service as any)._computeSeriesStatus(seriesGames, future)).toBe(
          'MIL leads 3-0',
        );
      });

      it('ignores an impossible stored evolution ("8-0") and computes instead', () => {
        const seriesGames = [
          { ...playoffGame(), homeTeamScore: 5, awayTeamScore: 3 },
          {
            ...playoffGame(),
            uniqueId: 'g2',
            homeTeamScore: 2,
            awayTeamScore: 4,
            seriesStatus: 'MIL wins series 8-0',
          },
          { ...playoffGame(), uniqueId: 'g3', homeTeamScore: 1, awayTeamScore: 7 },
        ];
        const current = { ...playoffGame() };
        expect((service as any)._computeSeriesStatus(seriesGames, current)).toBe(
          'LAD leads 2-1',
        );
      });

      it('never counts more than 7 games (duplicate rows cannot make 8-0)', () => {
        const seriesGames = Array.from({ length: 8 }, (_, i) => ({
          ...playoffGame(),
          uniqueId: `dup-${i}`,
          startTimeUTC: `2026-10-1${i % 7}T23:00:00Z`,
          homeTeamScore: 6,
          awayTeamScore: 2,
        }));
        const current = { ...playoffGame() };
        expect((service as any)._computeSeriesStatus(seriesGames, current)).toBe('');
      });

      it('counts a duplicated fixture (same teams, same time) only once', () => {
        const fixture = {
          ...playoffGame(),
          startTimeUTC: '2026-10-15T23:00:00Z',
          homeTeamScore: 6,
          awayTeamScore: 2,
        };
        const seriesGames = [
          fixture,
          // Same fixture stored under a second id (re-fetch twin row).
          { ...fixture, uniqueId: 'g2-twin' },
          {
            ...playoffGame(),
            uniqueId: 'g3',
            startTimeUTC: '2026-10-16T23:00:00Z',
            homeTeamScore: 1,
            awayTeamScore: 7,
          },
        ];
        const current = {
          ...playoffGame(),
          uniqueId: 'g3',
          startTimeUTC: '2026-10-16T23:00:00Z',
        };
        // 1 win each — not 2-1: the twin row must not count twice.
        expect((service as any)._computeSeriesStatus(seriesGames, current)).toBe(
          'Series tied 1-1',
        );
      });

      it('counts a duplicated fixture with swapped home/away only once', () => {
        const seriesGames = [
          {
            ...playoffGame(),
            startTimeUTC: '2026-10-15T23:00:00Z',
            homeTeamScore: 6,
            awayTeamScore: 2,
          },
          {
            ...playoffGame(),
            uniqueId: 'g2-swapped',
            startTimeUTC: '2026-10-15T23:00:00Z',
            // Same fixture, sides swapped in the stored row.
            homeTeamId: 'MLB-LAD',
            awayTeamId: 'MLB-MIL',
            homeTeamShort: 'LAD',
            awayTeamShort: 'MIL',
            homeTeamScore: 2,
            awayTeamScore: 6,
          },
          {
            ...playoffGame(),
            uniqueId: 'g3',
            startTimeUTC: '2026-10-16T23:00:00Z',
            homeTeamScore: 6,
            awayTeamScore: 2,
          },
        ];
        const current = {
          ...playoffGame(),
          uniqueId: 'g3',
          startTimeUTC: '2026-10-16T23:00:00Z',
        };
        // Only 2 distinct fixtures played (both MIL wins): no evolution yet
        // from a single fixture counted twice, and no doubled 3-0.
        expect((service as any)._computeSeriesStatus(seriesGames, current)).toBe(
          'MIL leads 2-0',
        );
      });

      it('returns "X leads Y-Z" when one team leads', () => {
        const seriesGames = [
          { ...playoffGame(), homeTeamScore: 5, awayTeamScore: 3 },
          { ...playoffGame(), uniqueId: 'g2', homeTeamScore: 2, awayTeamScore: 4 },
          { ...playoffGame(), uniqueId: 'g3', homeTeamScore: 1, awayTeamScore: 7 },
        ];
        const current = { ...playoffGame() };
        const result = (service as any)._computeSeriesStatus(seriesGames, current);
        expect(result).toBe('LAD leads 2-1');
      });

      it('returns "Series tied Y-Y" when wins are equal', () => {
        const seriesGames = [
          { ...playoffGame(), homeTeamScore: 5, awayTeamScore: 3 },
          { ...playoffGame(), uniqueId: 'g2', homeTeamScore: 2, awayTeamScore: 4 },
        ];
        const current = { ...playoffGame() };
        const result = (service as any)._computeSeriesStatus(seriesGames, current);
        expect(result).toBe('Series tied 1-1');
      });

      it("returns '' when no game has been played yet", () => {
        const seriesGames = [
          { ...playoffGame(), homeTeamScore: null, awayTeamScore: null },
          { ...playoffGame(), uniqueId: 'g2', homeTeamScore: null, awayTeamScore: null },
        ];
        const current = { ...playoffGame() };
        const result = (service as any)._computeSeriesStatus(seriesGames, current);
        expect(result).toBe('');
      });

      it('ignores games with missing scores when counting', () => {
        const seriesGames = [
          { ...playoffGame(), homeTeamScore: 5, awayTeamScore: 3 },
          { ...playoffGame(), uniqueId: 'g2', homeTeamScore: null, awayTeamScore: null },
        ];
        const current = { ...playoffGame() };
        const result = (service as any)._computeSeriesStatus(seriesGames, current);
        // Un seul match joué : pas d'évolution de série, on laisse tomber sur seriesSummary.
        expect(result).toBe('');
      });

      it('returns "X wins series Y-Z" when a team reaches 4 wins', () => {
        const seriesGames = [
          { ...playoffGame(), homeTeamScore: 3, awayTeamScore: 5 },
          { ...playoffGame(), uniqueId: 'g2', homeTeamScore: 1, awayTeamScore: 4 },
          { ...playoffGame(), uniqueId: 'g3', homeTeamScore: 2, awayTeamScore: 5 },
          { ...playoffGame(), uniqueId: 'g4', homeTeamScore: 3, awayTeamScore: 6 },
        ];
        const current = { ...playoffGame() };
        const result = (service as any)._computeSeriesStatus(seriesGames, current);
        expect(result).toBe('LAD wins series 4-0');
      });

      it('returns "X wins series Y-Z" for a best-of-5 clincher (3 wins, 5 games)', () => {
        const seriesGames = [
          { ...playoffGame(), homeTeamScore: 5, awayTeamScore: 3 },
          { ...playoffGame(), uniqueId: 'g2', homeTeamScore: 1, awayTeamScore: 4 },
          { ...playoffGame(), uniqueId: 'g3', homeTeamScore: 2, awayTeamScore: 5 },
          { ...playoffGame(), uniqueId: 'g4', homeTeamScore: 6, awayTeamScore: 1 },
          { ...playoffGame(), uniqueId: 'g5', homeTeamScore: 2, awayTeamScore: 3 },
        ];
        const current = { ...playoffGame() };
        const result = (service as any)._computeSeriesStatus(seriesGames, current);
        expect(result).toBe('LAD wins series 3-2');
      });

      it('returns "X leads Y-Z" when home/away sides swap between games', () => {
        const seriesGames = [
          { ...playoffGame(), homeTeamScore: 5, awayTeamScore: 3 },
          {
            ...playoffGame(),
            uniqueId: 'g2',
            homeTeamId: 'MLB-LAD',
            awayTeamId: 'MLB-MIL',
            homeTeamShort: 'LAD',
            awayTeamShort: 'MIL',
            homeTeamScore: 1,
            awayTeamScore: 4,
          },
        ];
        const current = { ...playoffGame() };
        const result = (service as any)._computeSeriesStatus(seriesGames, current);
        expect(result).toBe('MIL leads 2-0');
      });
    });

    describe('_precomputeSeriesStatus', () => {
      it('computes and stores status for playoff games without seriesStatus', async () => {
        const games = [
          {
            ...playoffGame(),
            uniqueId: 'g1',
            gameDate: '2026-10-15',
            startTimeUTC: '2026-10-15T23:00:00Z',
            seriesStatus: '',
            seriesSummary: '',
          },
          {
            ...playoffGame(),
            uniqueId: 'g2',
            gameDate: '2026-10-15',
            startTimeUTC: '2026-10-15T23:00:00Z',
            seriesStatus: '',
            seriesSummary: '',
          },
        ];

        mockGameModel.find.mockReturnValue({
          sort: jest.fn().mockReturnThis(),
          lean: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([
            {
              ...playoffGame(),
              uniqueId: 'db1',
              startTimeUTC: '2026-10-13T23:00:00Z',
              gameDate: '2026-10-13',
              homeTeamScore: 5,
              awayTeamScore: 3,
            },
            {
              ...playoffGame(),
              uniqueId: 'db2',
              startTimeUTC: '2026-10-14T23:00:00Z',
              gameDate: '2026-10-14',
              homeTeamScore: 2,
              awayTeamScore: 4,
            },
            {
              ...playoffGame(),
              uniqueId: 'db3',
              startTimeUTC: '2026-10-15T23:00:00Z',
              gameDate: '2026-10-15',
              homeTeamScore: 1,
              awayTeamScore: 7,
            },
          ]),
        });

        await (service as any)._precomputeSeriesStatus(games);

        const map = (service as any)._computedSeriesStatusMap;
        expect(map.get('g1')).toBe('LAD leads 2-1');
        expect(map.get('g2')).toBe('LAD leads 2-1');
      });

      it('skips games that already have a stored seriesStatus', async () => {
        const games = [
          {
            ...playoffGame(),
            uniqueId: 'g1',
            seriesStatus: 'MIL leads 2-1',
            seriesSummary: 'NLCS - Game 3',
          },
        ];

        await (service as any)._precomputeSeriesStatus(games);

        const map = (service as any)._computedSeriesStatusMap;
        expect(map.size).toBe(0);
        expect(mockGameModel.find).not.toHaveBeenCalled();
      });

      it('does nothing when no game needs computation', async () => {
        await (service as any)._precomputeSeriesStatus([
          { ...playoffGame(), seriesStatus: 'MIL leads 2-1' },
          { ...playoffGame(), recordSeasonType: 2 },
        ]);
        const map = (service as any)._computedSeriesStatusMap;
        expect(map.size).toBe(0);
      });
    });

    describe('_playoffSeriesDisplay with computed status', () => {
      it('shows the computed evolution instead of the series label', () => {
        const game = {
          ...playoffGame(),
          uniqueId: 'g1',
          seriesStatus: '',
          seriesSummary: 'NLCS - Game 3',
          recordSeasonType: 3,
        };
        (service as any)._computedSeriesStatusMap.set('g1', 'MIL leads 3-0');

        const enriched = (service as any)._enrichGameWithTeamData(
          game,
          new Map(),
        );

        expect(enriched.homeTeamRecord).toBe('MIL leads 3-0');
        expect(enriched.awayTeamRecord).toBe('MIL leads 3-0');
        expect(enriched.seriesStatus).toBe('');
        expect(enriched.seriesSummary).toBe('NLCS - Game 3');
      });

      it('keeps the stored seriesStatus when both exist', () => {
        const game = {
          ...playoffGame(),
          seriesStatus: 'MIL leads 3-0',
          seriesSummary: 'NLCS - Game 4',
          recordSeasonType: 3,
        };
        (service as any)._computedSeriesStatusMap.set(game.uniqueId, 'LAD leads 3-1');

        const enriched = (service as any)._enrichGameWithTeamData(
          game,
          new Map(),
        );

        expect(enriched.homeTeamRecord).toBe('MIL leads 3-0');
        expect(enriched.seriesStatus).toBe('MIL leads 3-0');
      });

      it('falls back to series summary when no computed status exists', () => {
        const game = {
          ...playoffGame(),
          seriesStatus: '',
          seriesSummary: 'NLCS - Game 2',
          recordSeasonType: 3,
        };

        const enriched = (service as any)._enrichGameWithTeamData(
          game,
          new Map(),
        );

        expect(enriched.homeTeamRecord).toBe('NLCS - Game 2');
        expect(enriched.awayTeamRecord).toBe('NLCS - Game 2');
      });

      it('keeps the season record for a legacy playoff game without computed status', () => {
        const game = {
          homeTeamId: 'MLB-LAD',
          awayTeamId: 'MLB-MIL',
          homeTeamRecord: '100-62',
          awayTeamRecord: '103-59',
          seriesSummary: 'ALCS - Game 2',
          seriesStatus: '',
        };
        (service as any)._computedSeriesStatusMap.clear();

        const enriched = (service as any)._enrichGameWithTeamData(
          game,
          new Map(),
        );

        expect(enriched.homeTeamRecord).toBe('ALCS - Game 2');
        expect(enriched.awayTeamRecord).toBe('ALCS - Game 2');
      });
    });
  });

  describe('refreshCurrentSeasonRecords', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should only fetch in-season leagues and persist their tallies', async () => {
      const inSeason = jest.spyOn(utils, 'isCurrentSeason');
      inSeason.mockImplementation(
        async (league: string) => league === League.NHL,
      );
      jest.spyOn(utils, 'isPlayoffsPeriod').mockResolvedValue(false);

      const fetchSpy = jest
        .spyOn(service as any, '_fetchUniqueGames')
        .mockImplementation(
          async (
            _league: string,
            _season: number | undefined,
            teamRecords?: Map<string, string>,
          ) => {
            teamRecords?.set('NHL-BOS', '20-15-5');
            teamRecords?.set('NHL-TOR', '18-17-5');
            return [];
          },
        );
      const updateRecordsSpy = jest
        .spyOn(mockTeamService as any, 'updateRecords')
        .mockResolvedValue(undefined);

      const result = await service.refreshCurrentSeasonRecords();

      expect(result.leagues).toEqual([League.NHL]);
      expect(result.updatedTeams).toBe(2);
      // Only the in-season league was fetched, with no season (current one)
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        League.NHL,
        undefined,
        expect.any(Map),
      );
      expect(updateRecordsSpy).toHaveBeenCalledWith([
        { uniqueId: 'NHL-BOS', record: '20-15-5' },
        { uniqueId: 'NHL-TOR', record: '18-17-5' },
      ]);
    });

    it('should include leagues in playoffs even outside the regular season', async () => {
      jest.spyOn(utils, 'isCurrentSeason').mockResolvedValue(false);
      jest
        .spyOn(utils, 'isPlayoffsPeriod')
        .mockImplementation(async (league: string) => league === League.NBA);

      jest
        .spyOn(service as any, '_fetchUniqueGames')
        .mockImplementation(
          async (
            _league: string,
            _season: number | undefined,
            teamRecords?: Map<string, string>,
          ) => {
            teamRecords?.set('NBA-LAL', '40-20');
            return [];
          },
        );
      const updateRecordsSpy = jest
        .spyOn(mockTeamService as any, 'updateRecords')
        .mockResolvedValue(undefined);

      const result = await service.refreshCurrentSeasonRecords();

      expect(result.leagues).toEqual([League.NBA]);
      expect(updateRecordsSpy).toHaveBeenCalledWith([
        { uniqueId: 'NBA-LAL', record: '40-20' },
      ]);
    });

    it('should skip every league when none is in season and write nothing', async () => {
      jest.spyOn(utils, 'isCurrentSeason').mockResolvedValue(false);
      jest.spyOn(utils, 'isPlayoffsPeriod').mockResolvedValue(false);
      const fetchSpy = jest.spyOn(service as any, '_fetchUniqueGames');
      const updateRecordsSpy = jest.spyOn(
        mockTeamService as any,
        'updateRecords',
      );

      const result = await service.refreshCurrentSeasonRecords();

      expect(result).toEqual({ leagues: [], updatedTeams: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(updateRecordsSpy).not.toHaveBeenCalled();
    });

    it('should keep processing the other leagues when one fetch fails', async () => {
      jest
        .spyOn(utils, 'isCurrentSeason')
        .mockImplementation(async (league: string) =>
          [League.NHL, League.NBA].includes(league as never),
        );
      jest.spyOn(utils, 'isPlayoffsPeriod').mockResolvedValue(false);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);

      jest
        .spyOn(service as any, '_fetchUniqueGames')
        .mockImplementation(async (league: string) => {
          if (league === League.NHL) throw new Error('ESPN down');
          return [];
        });
      const updateRecordsSpy = jest
        .spyOn(mockTeamService as any, 'updateRecords')
        .mockResolvedValue(undefined);

      const result = await service.refreshCurrentSeasonRecords();

      expect(result.leagues).toEqual([League.NHL, League.NBA]);
      expect(updateRecordsSpy).not.toHaveBeenCalled();
    });

    it("propagates the fresh tallies onto each team's season games", async () => {
      jest
        .spyOn(utils, 'isCurrentSeason')
        .mockImplementation(async (league: string) => league === League.NHL);
      jest.spyOn(utils, 'isPlayoffsPeriod').mockResolvedValue(false);
      jest
        .spyOn(service as any, '_fetchUniqueGames')
        .mockImplementation(
          async (
            _league: string,
            _season: number | undefined,
            teamRecords?: Map<string, string>,
          ) => {
            teamRecords?.set('NHL-BOS', '20-15-5');
            return [];
          },
        );
      jest
        .spyOn(mockTeamService as any, 'updateRecords')
        .mockResolvedValue(undefined);
      const propagateSpy = jest
        .spyOn(service as any, '_propagateTeamRecordToSeasonGames')
        .mockResolvedValue(0);

      await service.refreshCurrentSeasonRecords();

      expect(propagateSpy).toHaveBeenCalledWith(
        League.NHL,
        'NHL-BOS',
        '20-15-5',
      );
    });

    it('should never persist any game', async () => {
      jest
        .spyOn(utils, 'isCurrentSeason')
        .mockImplementation(async (league: string) => league === League.NHL);
      jest.spyOn(utils, 'isPlayoffsPeriod').mockResolvedValue(false);
      const fetchSpy = jest
        .spyOn(service as any, '_fetchUniqueGames')
        .mockResolvedValue([{ uniqueId: 'NHL-BOS-NHL-TOR' }]);
      const createSpy = jest.spyOn(service, 'create');
      jest.spyOn(mockGameModel, 'deleteMany').mockReturnValue({
        exec: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      } as any);

      await service.refreshCurrentSeasonRecords();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockGameModel.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('finalizeFinishedSeasonRecords', () => {
    // Helper: build a chainable query mock whose terminal `exec` resolves `value`.
    const chain = (value: any) => {
      const q: any = {
        sort: jest.fn(() => q),
        select: jest.fn(() => q),
        lean: jest.fn(() => q),
        exec: jest.fn().mockResolvedValue(value),
      };
      return q;
    };

    const monthsAgoIso = (months: number) => {
      const d = new Date();
      d.setMonth(d.getMonth() - months);
      return d.toISOString();
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('finalizes a league whose last game started more than 2 months ago', async () => {
      // The most recent game of the league is 3 months old → season is over.
      // Only NHL has a stored game; every other league's lookup returns null.
      mockGameModel.findOne.mockImplementation((filter: any) =>
        filter.league === League.NHL
          ? chain({ startTimeUTC: monthsAgoIso(3) })
          : chain(null),
      );
      // Two past games, same phase. g1 is missing its record; g2 carries the
      // tally. Tallies stay consistent with the 2 games held so `getSeasonFinals`
      // verifies them (a 40-30-12 tally would imply 82 games → truncated).
      mockGameModel.find.mockReturnValue(
        chain([
          {
            uniqueId: 'g1',
            homeTeamId: 'NHL-BOS',
            awayTeamId: 'NHL-TOR',
            homeTeamRecord: '',
            awayTeamRecord: '',
            recordSeasonType: 2,
          },
          {
            uniqueId: 'g2',
            homeTeamId: 'NHL-BOS',
            awayTeamId: 'NHL-TOR',
            homeTeamRecord: '1-0-0',
            awayTeamRecord: '0-1-0',
            recordSeasonType: 2,
          },
        ]),
      );
      mockGameModel.updateOne.mockReturnValue(chain({ modifiedCount: 1 }));
      const resetSpy = jest
        .spyOn(mockTeamService as any, 'resetLeagueRecords')
        .mockResolvedValue(2);

      const result = await service.finalizeFinishedSeasonRecords();

      // Only NHL has a stored game; the other leagues have none (findOne → null).
      expect(result.leagues).toEqual([League.NHL]);
      // BOS/TOR final tallies are frozen onto the game that was missing one.
      expect(mockGameModel.updateOne).toHaveBeenCalledWith(
        { uniqueId: 'g1' },
        { $set: { homeTeamRecord: '1-0-0', awayTeamRecord: '0-1-0' } },
      );
      expect(resetSpy).toHaveBeenCalledWith(League.NHL);
      expect(result.teamsReset).toBe(2);
    });

    it('leaves a league alone when its last game started within 2 months', async () => {
      // Season still considered running: last game 1 month ago.
      mockGameModel.findOne.mockReturnValue(
        chain({ startTimeUTC: monthsAgoIso(1) }),
      );
      const resetSpy = jest
        .spyOn(mockTeamService as any, 'resetLeagueRecords')
        .mockResolvedValue(0);

      const result = await service.finalizeFinishedSeasonRecords();

      expect(result.leagues).toEqual([]);
      expect(result.gamesUpdated).toBe(0);
      expect(result.teamsReset).toBe(0);
      expect(mockGameModel.find).not.toHaveBeenCalled();
      expect(resetSpy).not.toHaveBeenCalled();
    });

    it('skips a league with no games at all', async () => {
      mockGameModel.findOne.mockReturnValue(chain(null));
      const resetSpy = jest
        .spyOn(mockTeamService as any, 'resetLeagueRecords')
        .mockResolvedValue(0);

      const result = await service.finalizeFinishedSeasonRecords();

      expect(result).toEqual({ leagues: [], gamesUpdated: 0, teamsReset: 0 });
      expect(resetSpy).not.toHaveBeenCalled();
    });

    it('keeps processing other leagues when one throws', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      // NHL is over (finalize), NBA lookup throws.
      mockGameModel.findOne.mockImplementation((filter: any) => {
        if (filter.league === League.NBA) throw new Error('db down');
        return chain({ startTimeUTC: monthsAgoIso(5) });
      });
      mockGameModel.find.mockReturnValue(chain([]));
      const resetSpy = jest
        .spyOn(mockTeamService as any, 'resetLeagueRecords')
        .mockResolvedValue(0);

      const result = await service.finalizeFinishedSeasonRecords();

      // Every league except NBA (and the ones with no games) got finalized.
      expect(result.leagues).toContain(League.NHL);
      expect(result.leagues).not.toContain(League.NBA);
      expect(resetSpy).toHaveBeenCalledWith(League.NHL);
      expect(resetSpy).not.toHaveBeenCalledWith(League.NBA);
    });

    it('keeps a playoff game-specific tally when freezing a finished season', async () => {
      mockGameModel.findOne.mockReturnValue(
        chain({ startTimeUTC: monthsAgoIso(4) }),
      );
      // A single playoff game already carrying its own tally: phase 3 keeps the
      // game-specific record (never stamped with a later game's number).
      mockGameModel.find.mockReturnValue(
        chain([
          {
            uniqueId: 'p1',
            homeTeamId: 'NFL-CHI',
            awayTeamId: 'NFL-DET',
            homeTeamRecord: '1-0-0',
            awayTeamRecord: '0-1-0',
            recordSeasonType: 3,
          },
        ]),
      );
      mockGameModel.updateOne.mockReturnValue(chain({ modifiedCount: 1 }));
      jest
        .spyOn(mockTeamService as any, 'resetLeagueRecords')
        .mockResolvedValue(1);

      await service.finalizeFinishedSeasonRecords();

      expect(mockGameModel.updateOne).toHaveBeenCalledWith(
        { uniqueId: 'p1' },
        { $set: { homeTeamRecord: '1-0-0', awayTeamRecord: '0-1-0' } },
      );
    });
  });

  describe('findRecentFormGames', () => {
    // `jest.clearAllMocks()` does not reset implementations, so the `find`
    // override below would leak into every other suite of this file.
    afterEach(() => {
      mockGameModel.find.mockReset();
      mockGameModel.find.mockReturnThis();
    });

    it('matches the team on BOTH home and away sides', async () => {
      let filter: any = null;
      mockGameModel.find.mockImplementation((f: any) => {
        filter = f;
        return {
          sort: () => ({
            limit: () => ({
              select: () => ({ lean: () => ({ exec: async () => [] }) }),
            }),
          }),
        };
      });

      await service.findRecentFormGames('MLS-SKC-CITY');

      expect(filter).toEqual({
        isActive: true,
        $or: [{ homeTeamId: 'MLS-SKC-CITY' }, { awayTeamId: 'MLS-SKC-CITY' }],
        homeTeamScore: { $ne: null },
        awayTeamScore: { $ne: null },
      });
    });

    it('requires both scores IN the query, not after the limit', async () => {
      let filter: any = null;
      mockGameModel.find.mockImplementation((f: any) => {
        filter = f;
        return {
          sort: () => ({
            limit: () => ({
              select: () => ({ lean: () => ({ exec: async () => [] }) }),
            }),
          }),
        };
      });

      await service.findRecentFormGames('NHL-BOS');

      // Regression: with no `before` bound (an upcoming game), a team's most
      // recent games by date are its scheduled fixtures. `limit` is applied by
      // the database, so filtering the scores afterwards let those fixtures
      // consume the whole budget and the row came back empty. The condition
      // therefore has to be part of the query itself.
      expect(filter.homeTeamScore).toEqual({ $ne: null });
      expect(filter.awayTeamScore).toEqual({ $ne: null });
    });

    it('bounds the query with a strict "before" on startTimeUTC', async () => {
      let filter: any = null;
      mockGameModel.find.mockImplementation((f: any) => {
        filter = f;
        return {
          sort: () => ({
            limit: () => ({
              select: () => ({ lean: () => ({ exec: async () => [] }) }),
            }),
          }),
        };
      });

      const before = new Date('2026-03-20T18:00:00.000Z');
      await service.findRecentFormGames('NHL-BOS', before.toISOString());

      // `$lt` (not `$lte`) so the displayed game itself never comes back.
      expect(filter.startTimeUTC).toEqual({ $lt: before.toISOString() });
    });

    it('ignores an invalid "before" instead of filtering on it', async () => {
      let filter: any = null;
      mockGameModel.find.mockImplementation((f: any) => {
        filter = f;
        return {
          sort: () => ({
            limit: () => ({
              select: () => ({ lean: () => ({ exec: async () => [] }) }),
            }),
          }),
        };
      });

      await service.findRecentFormGames('NHL-BOS', 'not-a-date');

      expect(filter.startTimeUTC).toBeUndefined();
    });

    it('drops games without both scores and keeps the rest', async () => {
      mockGameModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue([
                  {
                    uniqueId: 'a',
                    homeTeamId: 'NHL-H1',
                    awayTeamId: 'NHL-BOS',
                    startTimeUTC: '2026-01-04T00:00:00.000Z',
                    homeTeamScore: 2,
                    awayTeamScore: 1,
                  },
                  {
                    uniqueId: 'b',
                    homeTeamId: 'NHL-H2',
                    awayTeamId: 'NHL-BOS',
                    startTimeUTC: '2026-01-03T00:00:00.000Z',
                    homeTeamScore: null,
                    awayTeamScore: 1,
                  },
                  {
                    uniqueId: 'c',
                    homeTeamId: 'NHL-H3',
                    awayTeamId: 'NHL-BOS',
                    startTimeUTC: '2026-01-02T00:00:00.000Z',
                    homeTeamScore: 0,
                    awayTeamScore: 0,
                  },
                  {
                    uniqueId: 'd',
                    homeTeamId: 'NHL-H4',
                    awayTeamId: 'NHL-BOS',
                    startTimeUTC: '2026-01-01T00:00:00.000Z',
                    homeTeamScore: 3,
                  },
                ]),
              }),
            }),
          }),
        }),
      });

      const result = await service.findRecentFormGames('NHL-BOS');

      expect(result.map((g) => g.uniqueId)).toEqual(['a', 'c']);
    });

    it('collapses the two stored copies of a single match', async () => {
      // Each upstream feed writes its own document for the team it was asked
      // about, so a finished match is stored twice. `uniqueId` differs (it is
      // prefixed with the selected team), only the match itself is identical.
      const copy = (suffix: string) => ({
        homeTeamId: 'NHL-VGK',
        awayTeamId: 'NHL-ANA',
        startTimeUTC: '2026-10-03T02:00:00.000Z',
        homeTeamScore: 3,
        awayTeamScore: 4,
        teamSelectedId: suffix,
      });

      mockGameModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue([
                  { ...copy('NHL-ANA'), uniqueId: 'NHL-ANA-401892433' },
                  { ...copy('NHL-VGK'), uniqueId: 'NHL-VGK-401892433' },
                ]),
              }),
            }),
          }),
        }),
      });

      const result = await service.findRecentFormGames('NHL-ANA');

      // One match, one result — otherwise it would fill two dots.
      expect(result).toHaveLength(1);
    });

    it('over-fetches so the duplicates cannot push real games out', async () => {
      const limitArg = jest.fn();
      mockGameModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockImplementation((n: number) => {
            limitArg(n);
            return {
              select: () => ({ lean: () => ({ exec: async () => [] }) }),
            };
          }),
        }),
      });

      await service.findRecentFormGames('NHL-BOS');

      // 5 rows requested, 15 fetched: the limit is applied after deduplication.
      expect(limitArg).toHaveBeenLastCalledWith(15);
    });

    it('clamps the limit between 1 and 20', async () => {
      const limitArg = jest.fn();
      mockGameModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockImplementation((n: number) => {
            limitArg(n);
            return {
              select: () => ({ lean: () => ({ exec: async () => [] }) }),
            };
          }),
        }),
      });

      await service.findRecentFormGames('NHL-BOS', undefined, 1);
      expect(limitArg).toHaveBeenLastCalledWith(3);

      await service.findRecentFormGames('NHL-BOS', undefined, 999);
      expect(limitArg).toHaveBeenLastCalledWith(60);
    });

    it('falls back to the default limit for a non-numeric one', async () => {
      const limitArg = jest.fn();
      mockGameModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockImplementation((n: number) => {
            limitArg(n);
            return {
              select: () => ({ lean: () => ({ exec: async () => [] }) }),
            };
          }),
        }),
      });

      await service.findRecentFormGames('NHL-BOS', undefined, 'abc' as never);

      expect(limitArg).toHaveBeenLastCalledWith(15);
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
        .mockResolvedValue({
          added: 1,
          skippedExisting: 0,
          skippedMissingTeamData: 0,
        });
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

    it('should loop over finished seasons only when no year is specified (excludes current year)', async () => {
      const currentYear = new Date().getFullYear();
      const expectedYears = [];
      for (
        let y = currentYear - 1;
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
          expect.objectContaining({
            league: League.NHL,
            season: year,
            addMissingOnly: true,
          }),
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
          addMissingOnly: true,
        }),
      );
      expect(result.message).toContain(String(currentYear - 1));
    });

    it('should only list years where games were actually added (added > 0)', async () => {
      const currentYear = new Date().getFullYear();
      const oldestYear = currentYear - service.maxYearBeforeDelete + 1;

      // Simulate: first year adds games, second year adds nothing
      let callCount = 0;
      getLeagueGamesSpy.mockImplementation(() => {
        callCount++;
        // First call returns added > 0, second call returns added = 0
        return Promise.resolve({
          added: callCount === 1 ? 5 : 0,
          skippedExisting: callCount === 1 ? 2 : 100,
          skippedMissingTeamData: 0,
        });
      });

      const result = await service.getOldiesGames(undefined, League.NHL);

      // Only the first year (the oldest allowed) should appear in the message since it had added > 0
      expect(result.yearsWithAdditions).toContain(oldestYear);
      expect(result.message).toContain(String(oldestYear));
      // The second year should NOT appear
      expect(result.message).not.toContain(String(oldestYear + 1));
    });

    it('should still allow forcing the current year explicitly via year param', async () => {
      const currentYear = new Date().getFullYear();

      const result = await service.getOldiesGames(
        String(currentYear),
        League.NHL,
      );

      expect(getLeagueGamesSpy).toHaveBeenCalledTimes(1);
      expect(getLeagueGamesSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          league: League.NHL,
          season: currentYear,
          addMissingOnly: true,
        }),
      );
      expect(result.message).toContain(String(currentYear));
    });

    it('should return "already up to date" message when no games were added', async () => {
      // All calls return added = 0
      getLeagueGamesSpy.mockResolvedValue({
        added: 0,
        skippedExisting: 5000,
        skippedMissingTeamData: 0,
      });

      const result = await service.getOldiesGames(undefined, League.NHL);

      expect(result.yearsWithAdditions).toHaveLength(0);
      expect(result.message).toContain('no new games were added');
      expect(result.message).toContain('already up to date');
    });

    it('should force the capacity check after every step by default', async () => {
      const purgeSpy = jest
        .spyOn(service, 'purgeOldestMonthIfNeeded')
        .mockResolvedValue({
          action: 'none',
          diskUsage: { usedMB: 100, totalMB: 512, percentage: 0.2 },
        });

      const currentYear = new Date().getFullYear();
      await service.getOldiesGames(String(currentYear - 1), League.NHL);

      // One league x one year -> exactly one capacity check, forced (true).
      expect(purgeSpy).toHaveBeenCalledTimes(1);
      expect(purgeSpy).toHaveBeenCalledWith(true);

      purgeSpy.mockRestore();
    });

    it('should not force the capacity check when forceCapacityCheck is false', async () => {
      const purgeSpy = jest
        .spyOn(service, 'purgeOldestMonthIfNeeded')
        .mockResolvedValue({
          action: 'none',
          diskUsage: { usedMB: 100, totalMB: 512, percentage: 0.2 },
        });

      const currentYear = new Date().getFullYear();
      await service.getOldiesGames(String(currentYear - 1), League.NHL, {
        forceCapacityCheck: false,
      });

      expect(purgeSpy).toHaveBeenCalledTimes(1);
      expect(purgeSpy).toHaveBeenCalledWith(false);

      purgeSpy.mockRestore();
    });

    it('should throttle forced capacity purges to one per FORCED_PURGE_MIN_INTERVAL_MS across steps', async () => {
      const purgeSpy = jest
        .spyOn(service, 'purgeOldestMonthIfNeeded')
        .mockResolvedValue({
          action: 'purged',
          diskUsage: { usedMB: 499, totalMB: 512, percentage: 0.975 },
          purgedYear: 2016,
          purgedMonth: 11,
          deletedCount: 7,
          remainingYears: [2017],
        });

      // No explicit year -> loops over every finished season (several steps),
      // all within the same wall-clock second, so the 1-minute floor applies
      // after the very first step.
      await service.getOldiesGames(undefined, League.NHL);

      // Despite many league x year steps, the forced purge runs only once:
      // the remaining steps are throttled so a stuck-full disk cannot wipe a
      // month on every step.
      expect(purgeSpy).toHaveBeenCalledTimes(1);
      expect(purgeSpy).toHaveBeenCalledWith(true);

      purgeSpy.mockRestore();
    });

    it('should keep processing seasons when the capacity check throws', async () => {
      const purgeSpy = jest
        .spyOn(service, 'purgeOldestMonthIfNeeded')
        .mockRejectedValue(new Error('dbStats unavailable'));
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      const currentYear = new Date().getFullYear();
      const result = await service.getOldiesGames(
        String(currentYear - 1),
        League.NHL,
      );

      expect(getLeagueGamesSpy).toHaveBeenCalledTimes(1);
      expect(result.message).toContain('History recovery');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `[Oldies] Capacity check failed after ${League.NHL} ${currentYear - 1}:`,
        'dbStats unavailable',
      );

      purgeSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should pass ignoreOtherManualRefresh so an unrelated manual refresh cannot skip every step', async () => {
      const currentYear = new Date().getFullYear();
      await service.getOldiesGames(String(currentYear - 1), League.NHL);

      expect(getLeagueGamesSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          league: League.NHL,
          season: currentYear - 1,
          addMissingOnly: true,
          ignoreOtherManualRefresh: true,
        }),
      );
    });

    it('should still fetch every step when another league has a manual refresh in progress', async () => {
      const currentYear = new Date().getFullYear();
      // Simulate an unrelated league whose manual refresh never got released.
      (service as any).manualRefreshInProgress[League.MLS] = true;

      const result = await service.getOldiesGames(undefined, League.NHL);

      // Every season is still fetched instead of being skipped in one second.
      const expectedYears = [];
      for (
        let y = currentYear - 1;
        y > currentYear - service.maxYearBeforeDelete;
        y--
      ) {
        expectedYears.push(y);
      }
      expect(getLeagueGamesSpy).toHaveBeenCalledTimes(expectedYears.length);
      expect(result.message).toContain('History recovery');

      delete (service as any).manualRefreshInProgress[League.MLS];
    });

    it('should refuse a second overlapping recovery instead of no-oping both runs', async () => {
      const currentYear = new Date().getFullYear();
      const consoleWarnSpy = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      // A first recovery is already running (never released).
      (service as any).isOldiesRunning = true;

      const result = await service.getOldiesGames(
        String(currentYear - 1),
        League.NHL,
      );

      expect(result.message).toContain(
        'another recovery is already in progress',
      );
      expect(result.yearsWithAdditions).toHaveLength(0);
      expect(getLeagueGamesSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Oldies] Skipping: another history recovery is already in progress.',
      );

      (service as any).isOldiesRunning = false;
      consoleWarnSpy.mockRestore();
    });

    it('should release the overlap guard even when the recovery throws', async () => {
      const currentYear = new Date().getFullYear();
      getLeagueGamesSpy.mockRejectedValue(new Error('ESPN down'));

      await expect(
        service.getOldiesGames(String(currentYear - 1), League.NHL),
      ).resolves.toBeDefined();

      // The guard must not stay stuck, otherwise no recovery could ever run again.
      expect((service as any).isOldiesRunning).toBe(false);
    });
  });

  describe('getLeagueGames addMissingOnly (oldies recovery)', () => {
    it('corrects stored PWHL game records from the date-specific regular-season standings', async () => {
      const recordsSpy = jest
        .spyOn(HockeyData.prototype, 'getPWHLRecordsForDates')
        .mockResolvedValue(
          new Map([['2024-05-29', { BOS: '21-5-4', MIN: '16-9-5' }]]),
        );
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);
      const fetchedGame = {
        uniqueId: 'PWHL-BOS-2024-05-29-98',
        league: League.PWHL,
        gameDate: '2024-05-29',
        startTimeUTC: '2024-05-29T23:00:00.000Z',
        homeTeamId: 'PWHL-BOS',
        awayTeamId: 'PWHL-MIN',
        homeTeamShort: 'BOS',
        awayTeamShort: 'MIN',
        homeTeamScore: 0,
        awayTeamScore: 3,
      };
      (service as any)._fetchUniqueGames = jest
        .fn()
        .mockResolvedValue([fetchedGame]);
      (service as any)._persistMissingHistoricalGameTeams = jest
        .fn()
        .mockResolvedValue(0);
      (service as any)._backfillSeasonRecords = jest.fn().mockResolvedValue(0);
      mockTeamService.findAll.mockResolvedValue([]);
      mockGameModel.exec.mockResolvedValue([
        {
          uniqueId: fetchedGame.uniqueId,
          homeTeamScore: 0,
          awayTeamScore: 3,
          homeTeamRecord: 'stale-record',
          awayTeamRecord: 'stale-record',
        },
      ]);

      await service.getLeagueGames({
        league: League.PWHL,
        forceUpdate: true,
        skipCascade: true,
        season: 2024,
        addMissingOnly: true,
      });

      expect(recordsSpy).toHaveBeenCalledWith(['2024-05-29']);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          uniqueId: fetchedGame.uniqueId,
          homeTeamRecord: '21-5-4',
          awayTeamRecord: '16-9-5',
        }),
      );
      expect(mockTeamService.updateRecord).not.toHaveBeenCalled();
      recordsSpy.mockRestore();
    });

    it('persists the final records supplied by ESPN when oldies refreshes an existing game', async () => {
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);
      const fetchedGame = {
        uniqueId: 'NHL-BOS-2024-10-08-1',
        league: League.NHL,
        gameDate: '2024-10-08',
        startTimeUTC: '2024-10-08T23:00:00.000Z',
        homeTeamId: 'NHL-BOS',
        awayTeamId: 'NHL-FLA',
        homeTeamScore: 4,
        awayTeamScore: 3,
        homeTeamRecord: '1-0-0',
        awayTeamRecord: '0-1-0',
      };
      (service as any)._fetchUniqueGames = jest
        .fn()
        .mockResolvedValue([fetchedGame]);
      (service as any)._persistMissingHistoricalGameTeams = jest
        .fn()
        .mockResolvedValue(0);
      (service as any)._backfillSeasonRecords = jest.fn().mockResolvedValue(0);
      mockTeamService.findAll.mockResolvedValue([]);
      mockGameModel.exec.mockResolvedValue([
        {
          uniqueId: fetchedGame.uniqueId,
          homeTeamScore: 4,
          awayTeamScore: 3,
          homeTeamRecord: 'old-home',
          awayTeamRecord: 'old-away',
        },
      ]);
      const recordsSpy = jest.spyOn(
        HockeyData.prototype,
        'getPWHLRecordsForDates',
      );

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
        season: 2024,
        addMissingOnly: true,
      });

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          uniqueId: fetchedGame.uniqueId,
          homeTeamRecord: '1-0-0',
          awayTeamRecord: '0-1-0',
        }),
      );
      expect(recordsSpy).not.toHaveBeenCalled();
      recordsSpy.mockRestore();
    });

    it('should only create missing games, skipping existing ones and those without home/away team data', async () => {
      const currentYear = new Date().getFullYear();
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      // Known games already in the DB (we must not overwrite them).
      mockGameModel.exec.mockResolvedValue([
        { uniqueId: 'existing-1', homeTeamScore: 3, awayTeamScore: 1 },
        { uniqueId: 'existing-diff', homeTeamScore: 0, awayTeamScore: 0 },
      ]);

      // Pulled games: existing-1 (identical -> skip), new-2 (complete -> create),
      // existing-diff (same id but different scores -> refresh), new-3 (missing home team -> skip).
      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([
        {
          uniqueId: 'existing-1',
          league: League.NHL,
          homeTeamId: 'A',
          awayTeamId: 'B',
          homeTeamScore: 3,
          awayTeamScore: 1,
        },
        {
          uniqueId: 'new-2',
          league: League.NHL,
          homeTeamId: 'A',
          awayTeamId: 'B',
          homeTeamScore: 2,
          awayTeamScore: 1,
        },
        {
          uniqueId: 'existing-diff',
          league: League.NHL,
          homeTeamId: 'C',
          awayTeamId: 'D',
          homeTeamScore: 5,
          awayTeamScore: 2,
        },
        {
          uniqueId: 'new-3',
          league: League.NHL,
          homeTeamId: null,
          awayTeamId: 'B',
        },
      ]);
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
        season: currentYear - 1,
        addMissingOnly: true,
      });

      // new-2 (missing game) and existing-diff (same id, different scores -> refreshed) are created
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: 'new-2' }),
      );
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: 'existing-diff' }),
      );
      // The already-existing game with identical data was NOT overwritten
      expect(createSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: 'existing-1' }),
      );
      // The game missing home team data was NOT created
      expect(createSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: 'new-3' }),
      );

      createSpy.mockRestore();
    });

    it('should accept past games with null scores (cron will fill them later)', async () => {
      const currentYear = new Date().getFullYear();
      const pastTime = new Date();
      pastTime.setHours(pastTime.getHours() - 2); // 2 hours ago

      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      mockGameModel.exec.mockResolvedValue([]); // No existing games

      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([
        {
          uniqueId: 'past-no-scores',
          league: League.MLS,
          homeTeamId: 'MLS-TOR',
          awayTeamId: 'MLS-MTL',
          homeTeamScore: null, // Missing scores
          awayTeamScore: null,
          startTimeUTC: pastTime.toISOString(), // Past game
        },
      ]);
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);

      await service.getLeagueGames({
        league: League.MLS,
        forceUpdate: true,
        skipCascade: true,
        season: currentYear - 1,
        addMissingOnly: true,
      });

      // Past game with null scores should be created (cron will fill them)
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: 'past-no-scores' }),
      );

      createSpy.mockRestore();
    });

    it('should reject future scheduled games even if they have team data', async () => {
      const currentYear = new Date().getFullYear();
      const futureTime = new Date();
      futureTime.setHours(futureTime.getHours() + 2); // 2 hours in future

      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      mockGameModel.exec.mockResolvedValue([]);

      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([
        {
          uniqueId: 'future-scheduled',
          league: League.MLS,
          homeTeamId: 'MLS-TOR',
          awayTeamId: 'MLS-MTL',
          homeTeamScore: null,
          awayTeamScore: null,
          startTimeUTC: futureTime.toISOString(), // Future game
        },
      ]);
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);

      await service.getLeagueGames({
        league: League.MLS,
        forceUpdate: true,
        skipCascade: true,
        season: currentYear - 1,
        addMissingOnly: true,
      });

      // Future game should NOT be created (prevent historical data pollution)
      expect(createSpy).not.toHaveBeenCalled();

      createSpy.mockRestore();
    });

    it('backfills a stored game that has no per-game team records', async () => {
      const currentYear = new Date().getFullYear();
      const pastTime = new Date();
      pastTime.setHours(pastTime.getHours() - 2);

      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      // Stored before per-game records existed: same id, same scores, no records.
      mockGameModel.exec.mockResolvedValue([
        { uniqueId: 'existing-no-record', homeTeamScore: 3, awayTeamScore: 1 },
      ]);

      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([
        {
          uniqueId: 'existing-no-record',
          league: League.NHL,
          homeTeamId: 'NHL-BOS',
          awayTeamId: 'NHL-TOR',
          homeTeamScore: 3,
          awayTeamScore: 1,
          startTimeUTC: pastTime.toISOString(),
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
        },
      ]);
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
        season: currentYear - 1,
        addMissingOnly: true,
      });

      // Identical scores but missing records -> refreshed instead of skipped
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          uniqueId: 'existing-no-record',
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
        }),
      );

      createSpy.mockRestore();
    });

    it('skips a stored game whose scores and team records already match', async () => {
      const currentYear = new Date().getFullYear();
      const pastTime = new Date();
      pastTime.setHours(pastTime.getHours() - 2);

      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      mockGameModel.exec.mockResolvedValue([
        {
          uniqueId: 'existing-with-record',
          homeTeamScore: 3,
          awayTeamScore: 1,
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
        },
      ]);

      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([
        {
          uniqueId: 'existing-with-record',
          league: League.NHL,
          homeTeamId: 'NHL-BOS',
          awayTeamId: 'NHL-TOR',
          homeTeamScore: 3,
          awayTeamScore: 1,
          startTimeUTC: pastTime.toISOString(),
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
        },
      ]);
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
        season: currentYear - 1,
        addMissingOnly: true,
      });

      expect(createSpy).not.toHaveBeenCalled();

      createSpy.mockRestore();
    });

    it('backfills records on stored games that have none left', async () => {
      const currentYear = new Date().getFullYear();
      const pastTime = new Date();
      pastTime.setHours(pastTime.getHours() - 2);

      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      // reset() drops any implementation left queued by a previous test.
      mockGameModel.exec.mockReset();
      // First call = the addMissingOnly `existing` lookup (no stored record),
      // second call = the `_backfillSeasonRecords` sweep (game still stored with
      // an empty record, i.e. exactly the gap this pass must fill).
      mockGameModel.exec
        .mockResolvedValueOnce([
          { uniqueId: 'old-no-record', homeTeamScore: 3, awayTeamScore: 1 },
        ])
        .mockResolvedValueOnce([
          {
            uniqueId: 'old-no-record',
            homeTeamId: 'NHL-BOS',
            awayTeamId: 'NHL-TOR',
            homeTeamRecord: '',
            awayTeamRecord: '',
          },
        ])
        // Default for any further query, so no queued value leaks into the next test.
        .mockResolvedValue([]);

      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([
        {
          uniqueId: 'old-no-record',
          league: League.NHL,
          homeTeamId: 'NHL-BOS',
          awayTeamId: 'NHL-TOR',
          homeTeamScore: 3,
          awayTeamScore: 1,
          startTimeUTC: pastTime.toISOString(),
          // Tallies must match the single fetched game, otherwise the batch is
          // (correctly) treated as truncated and nothing is written.
          homeTeamRecord: '1-0-0',
          awayTeamRecord: '0-1-0',
        },
      ]);
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
        season: currentYear - 1,
        addMissingOnly: true,
      });

      // The stored game is written with the season tally, not left empty.
      expect(mockGameModel.updateOne).toHaveBeenCalledWith(
        { uniqueId: 'old-no-record' },
        { $set: { homeTeamRecord: '1-0-0', awayTeamRecord: '0-1-0' } },
      );

      createSpy.mockRestore();
    });

    it('backfills each playoff game with its own evolving record', async () => {
      mockGameModel.exec.mockResolvedValue([
        {
          uniqueId: 'playoff-game-1',
          homeTeamId: 'NHL-BOS',
          awayTeamId: 'NHL-TOR',
          homeTeamRecord: '',
          awayTeamRecord: '',
        },
        {
          uniqueId: 'playoff-game-2',
          homeTeamId: 'NHL-BOS',
          awayTeamId: 'NHL-TOR',
          homeTeamRecord: '',
          awayTeamRecord: '',
        },
      ]);
      mockGameModel.updateOne.mockImplementation(() => ({
        exec: jest.fn().mockResolvedValue({}),
      }));

      const updated = await (service as any)._backfillSeasonRecords(
        League.NHL,
        [
          {
            uniqueId: 'playoff-game-1',
            homeTeamId: 'NHL-BOS',
            awayTeamId: 'NHL-TOR',
            homeTeamRecord: '1-0-0',
            awayTeamRecord: '0-1-0',
            recordSeasonType: 3,
          },
          {
            uniqueId: 'playoff-game-2',
            homeTeamId: 'NHL-BOS',
            awayTeamId: 'NHL-TOR',
            homeTeamRecord: '2-0-0',
            awayTeamRecord: '0-2-0',
            recordSeasonType: 3,
          },
        ],
      );

      expect(updated).toBe(2);
      expect(mockGameModel.updateOne).toHaveBeenNthCalledWith(
        1,
        { uniqueId: 'playoff-game-1' },
        { $set: { homeTeamRecord: '1-0-0', awayTeamRecord: '0-1-0' } },
      );
      expect(mockGameModel.updateOne).toHaveBeenNthCalledWith(
        2,
        { uniqueId: 'playoff-game-2' },
        { $set: { homeTeamRecord: '2-0-0', awayTeamRecord: '0-2-0' } },
      );
      mockGameModel.updateOne.mockReset();
    });

    it('never overwrites a record that is already stored', async () => {
      const currentYear = new Date().getFullYear();
      const pastTime = new Date();
      pastTime.setHours(pastTime.getHours() - 2);

      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      // reset() drops any implementation left queued by a previous test.
      mockGameModel.exec.mockReset();
      // Two queries: the addMissingOnly `existing` lookup, then the backfill sweep.
      // The stored game already carries a record, so the sweep must leave it alone.
      mockGameModel.exec
        .mockResolvedValueOnce([
          {
            uniqueId: 'old-has-record',
            homeTeamScore: 3,
            awayTeamScore: 1,
            homeTeamRecord: '1-0-0',
            awayTeamRecord: '0-1-0',
          },
        ])
        .mockResolvedValueOnce([
          {
            uniqueId: 'old-has-record',
            homeTeamId: 'NHL-BOS',
            awayTeamId: 'NHL-TOR',
            homeTeamRecord: '1-0-0',
            awayTeamRecord: '0-1-0',
          },
        ])
        .mockResolvedValue([]);

      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([
        {
          uniqueId: 'old-has-record',
          league: League.NHL,
          homeTeamId: 'NHL-BOS',
          awayTeamId: 'NHL-TOR',
          homeTeamScore: 3,
          awayTeamScore: 1,
          startTimeUTC: pastTime.toISOString(),
          // Tallies consistent with the single fetched game, so the sweep does run.
          homeTeamRecord: '1-0-0',
          awayTeamRecord: '0-1-0',
        },
      ]);
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
        season: currentYear - 1,
        addMissingOnly: true,
      });

      // Records differ, so the game is refreshed through create() (which carries
      // the fresh tally) — but the backfill sweep itself writes nothing.
      expect(mockGameModel.updateOne).not.toHaveBeenCalled();

      createSpy.mockRestore();
    });

    it('backfills a stored game that has no recordSeasonType', async () => {
      const currentYear = new Date().getFullYear();
      const pastTime = new Date();
      pastTime.setHours(pastTime.getHours() - 2);

      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      // Stored before `recordSeasonType` was persisted: same id, same scores,
      // same records, but no phase at all — e.g. a 2021 NHL preseason game that
      // the 1-year preseason retention can never match without the field.
      mockGameModel.exec.mockResolvedValue([
        {
          uniqueId: 'existing-no-phase',
          homeTeamScore: 3,
          awayTeamScore: 1,
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
        },
      ]);

      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([
        {
          uniqueId: 'existing-no-phase',
          league: League.NHL,
          homeTeamId: 'NHL-BOS',
          awayTeamId: 'NHL-TOR',
          homeTeamScore: 3,
          awayTeamScore: 1,
          startTimeUTC: pastTime.toISOString(),
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
          recordSeasonType: 1,
        },
      ]);
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
        season: currentYear - 1,
        addMissingOnly: true,
      });

      // Identical scores and records but a missing phase -> refreshed instead of
      // skipped, so `create()` persists `recordSeasonType` and the game becomes
      // visible to the preseason retention filter.
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          uniqueId: 'existing-no-phase',
          recordSeasonType: 1,
        }),
      );

      createSpy.mockRestore();
    });

    it('skips a stored game whose scores, records and phase already match', async () => {
      const currentYear = new Date().getFullYear();
      const pastTime = new Date();
      pastTime.setHours(pastTime.getHours() - 2);

      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      mockGameModel.exec.mockResolvedValue([
        {
          uniqueId: 'existing-with-phase',
          homeTeamScore: 3,
          awayTeamScore: 1,
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
          recordSeasonType: 1,
        },
      ]);

      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([
        {
          uniqueId: 'existing-with-phase',
          league: League.NHL,
          homeTeamId: 'NHL-BOS',
          awayTeamId: 'NHL-TOR',
          homeTeamScore: 3,
          awayTeamScore: 1,
          startTimeUTC: pastTime.toISOString(),
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
          recordSeasonType: 1,
        },
      ]);
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
        season: currentYear - 1,
        addMissingOnly: true,
      });

      // Both sides carry the same phase -> still skipped (the check converges).
      expect(createSpy).not.toHaveBeenCalled();

      createSpy.mockRestore();
    });
  });

  describe('create: record protection', () => {
    it('does not wipe a stored record when the fetched one is empty', async () => {
      const existingGame: any = {
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 3,
        awayTeamScore: 1,
        homeTeamRecord: '33-39-10',
        awayTeamRecord: '42-32-7',
        save: jest.fn().mockResolvedValue(undefined),
      };
      jest.spyOn(service, 'findOne').mockResolvedValue(existingGame as any);

      // Score changed (so the game is refreshed) but ESPN returned no record.
      await service.create({
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 4,
        awayTeamScore: 1,
        homeTeamRecord: '',
        awayTeamRecord: '',
      } as any);

      expect(existingGame.homeTeamRecord).toBe('33-39-10');
      expect(existingGame.awayTeamRecord).toBe('42-32-7');
      // The score refresh still applies.
      expect(existingGame.homeTeamScore).toBe(4);
    });

    it('still writes a record when one is fetched', async () => {
      const existingGame: any = {
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 3,
        awayTeamScore: 1,
        homeTeamRecord: '30-40-12',
        awayTeamRecord: '40-34-8',
        save: jest.fn().mockResolvedValue(undefined),
      };
      jest.spyOn(service, 'findOne').mockResolvedValue(existingGame as any);

      await service.create({
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 3,
        awayTeamScore: 1,
        homeTeamRecord: '33-39-10',
        awayTeamRecord: '42-32-7',
      } as any);

      expect(existingGame.homeTeamRecord).toBe('33-39-10');
      expect(existingGame.awayTeamRecord).toBe('42-32-7');
    });

    it('clears a stale 0-0-0 on an UPCOMING game so the reader falls back to team.record', async () => {
      const future = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const existingGame: any = {
        uniqueId: 'NHL-BOS-NHL-TOR-upcoming',
        homeTeamScore: null,
        awayTeamScore: null,
        // A stale placeholder left by a fetch before the upcoming-game fix.
        homeTeamRecord: '0-0-0',
        awayTeamRecord: '0-0-0',
        save: jest.fn().mockResolvedValue(undefined),
      };
      jest.spyOn(service, 'findOne').mockResolvedValue(existingGame as any);

      // The schedule cleared the unstarted game's record (incoming is empty).
      await service.create({
        uniqueId: 'NHL-BOS-NHL-TOR-upcoming',
        startTimeUTC: future,
        homeTeamRecord: '',
        awayTeamRecord: '',
      } as any);

      // The intentional clear must overwrite the stale 0-0-0 so
      // `_enrichGameWithTeamData()` falls back to the team's current record.
      expect(existingGame.homeTeamRecord).toBe('');
      expect(existingGame.awayTeamRecord).toBe('');
    });
  });

  describe('create: capacity guard (no-space retry)', () => {
    const makeNoSpaceError = () =>
      Object.assign(new Error('no space left on device'), { code: 68 });

    beforeEach(() => {
      jest.spyOn(console, 'warn').mockImplementation();
      jest.spyOn(console, 'info').mockImplementation();
      jest.spyOn(console, 'error').mockImplementation();
    });

    it('forces a purge and retries once when a no-space error occurs', async () => {
      const existingGame: any = {
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 3,
        awayTeamScore: 1,
        homeTeamRecord: '33-39-10',
        awayTeamRecord: '42-32-7',
      };
      const saveMock = jest
        .fn()
        .mockRejectedValueOnce(makeNoSpaceError())
        .mockResolvedValueOnce(undefined);
      existingGame.save = saveMock;
      jest.spyOn(service, 'findOne').mockResolvedValue(existingGame as any);

      const purgeSpy = jest
        .spyOn(service, 'purgeOldestMonthIfNeeded')
        .mockResolvedValue({
          action: 'purged',
          diskUsage: { usedMB: 99, totalMB: 100, percentage: 0.99 },
          purgedYear: 2016,
          purgedMonth: 9,
          deletedCount: 296,
          remainingYears: [2017],
        });

      await service.create({
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 4,
        awayTeamScore: 1,
        homeTeamRecord: '33-39-10',
        awayTeamRecord: '42-32-7',
      } as any);

      // Forced purge: force === true bypasses the 1-hour guard.
      expect(purgeSpy).toHaveBeenCalledWith(true);
      // The operation is retried exactly once after the purge.
      expect(saveMock).toHaveBeenCalledTimes(2);
      // The refreshed score from the retry is applied.
      expect(existingGame.homeTeamScore).toBe(4);

      purgeSpy.mockRestore();
    });

    it('falls back to a direct purge when the forced check reports no purge needed', async () => {
      const existingGame: any = {
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 3,
        awayTeamScore: 1,
        homeTeamRecord: '33-39-10',
        awayTeamRecord: '42-32-7',
      };
      const saveMock = jest
        .fn()
        .mockRejectedValueOnce(makeNoSpaceError())
        .mockResolvedValueOnce(undefined);
      existingGame.save = saveMock;
      jest.spyOn(service, 'findOne').mockResolvedValue(existingGame as any);

      const purgeSpy = jest
        .spyOn(service, 'purgeOldestMonthIfNeeded')
        .mockResolvedValue({
          action: 'none',
          diskUsage: { usedMB: 50, totalMB: 100, percentage: 0.5 },
        });
      const directPurgeSpy = jest
        .spyOn(service, 'purgeOldestMonth')
        .mockResolvedValue({
          action: 'purged',
          purgedYear: 2016,
          purgedMonth: 9,
          deletedCount: 120,
          remainingYears: [2017],
        });

      await service.create({
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 4,
        awayTeamScore: 1,
        homeTeamRecord: '33-39-10',
        awayTeamRecord: '42-32-7',
      } as any);

      expect(purgeSpy).toHaveBeenCalledWith(true);
      expect(directPurgeSpy).toHaveBeenCalledTimes(1);
      expect(saveMock).toHaveBeenCalledTimes(2);

      purgeSpy.mockRestore();
      directPurgeSpy.mockRestore();
    });

    it('re-throws the error when nothing could be purged', async () => {
      const existingGame: any = {
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 3,
        awayTeamScore: 1,
        homeTeamRecord: '33-39-10',
        awayTeamRecord: '42-32-7',
      };
      const saveMock = jest.fn().mockRejectedValue(makeNoSpaceError());
      existingGame.save = saveMock;
      jest.spyOn(service, 'findOne').mockResolvedValue(existingGame as any);

      const purgeSpy = jest
        .spyOn(service, 'purgeOldestMonthIfNeeded')
        .mockResolvedValue({
          action: 'none',
          diskUsage: { usedMB: 50, totalMB: 100, percentage: 0.5 },
        });
      const directPurgeSpy = jest
        .spyOn(service, 'purgeOldestMonth')
        .mockResolvedValue({ action: 'none' });

      await expect(
        service.create({
          uniqueId: 'NHL-BOS-NHL-TOR',
          homeTeamScore: 4,
          awayTeamScore: 1,
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
        } as any),
      ).rejects.toThrow('no space left');

      // No retry because nothing was purged.
      expect(saveMock).toHaveBeenCalledTimes(1);

      purgeSpy.mockRestore();
      directPurgeSpy.mockRestore();
    });

    it('does not purge again within FORCED_PURGE_MIN_INTERVAL_MS (never deletes data in an unbounded burst)', async () => {
      const existingGame: any = {
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 3,
        awayTeamScore: 1,
        homeTeamRecord: '33-39-10',
        awayTeamRecord: '42-32-7',
      };
      const saveMock = jest.fn().mockRejectedValue(makeNoSpaceError());
      existingGame.save = saveMock;
      jest.spyOn(service, 'findOne').mockResolvedValue(existingGame as any);

      const purgeSpy = jest
        .spyOn(service, 'purgeOldestMonthIfNeeded')
        .mockResolvedValue({
          action: 'purged',
          diskUsage: { usedMB: 99, totalMB: 100, percentage: 0.99 },
          purgedYear: 2016,
          purgedMonth: 9,
          deletedCount: 296,
          remainingYears: [2017],
        });

      // First no-space error: the forced purge runs and clears the cooldown.
      await expect(
        service.create({
          uniqueId: 'NHL-BOS-NHL-TOR',
          homeTeamScore: 4,
          awayTeamScore: 1,
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
        } as any),
      ).rejects.toThrow('no space left');
      expect(purgeSpy).toHaveBeenCalledTimes(1);

      // Second no-space error within the 1-minute floor: no second purge, and
      // the error is re-thrown so a stuck-full disk cannot cascade deletions.
      await expect(
        service.create({
          uniqueId: 'NHL-BOS-NHL-TOR',
          homeTeamScore: 4,
          awayTeamScore: 1,
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
        } as any),
      ).rejects.toThrow('no space left');
      expect(purgeSpy).toHaveBeenCalledTimes(1); // still 1 — not purged again

      purgeSpy.mockRestore();
    });

    it('does not purge or retry for a non-no-space error', async () => {
      const existingGame: any = {
        uniqueId: 'NHL-BOS-NHL-TOR',
        homeTeamScore: 3,
        awayTeamScore: 1,
        homeTeamRecord: '33-39-10',
        awayTeamRecord: '42-32-7',
      };
      const saveMock = jest
        .fn()
        .mockRejectedValue(new Error('validation failed'));
      existingGame.save = saveMock;
      jest.spyOn(service, 'findOne').mockResolvedValue(existingGame as any);

      const purgeSpy = jest.spyOn(service, 'purgeOldestMonthIfNeeded');

      await expect(
        service.create({
          uniqueId: 'NHL-BOS-NHL-TOR',
          homeTeamScore: 4,
          awayTeamScore: 1,
          homeTeamRecord: '33-39-10',
          awayTeamRecord: '42-32-7',
        } as any),
      ).rejects.toThrow('validation failed');

      expect(purgeSpy).not.toHaveBeenCalled();
      expect(saveMock).toHaveBeenCalledTimes(1);

      purgeSpy.mockRestore();
    });
  });

  describe('getLeagueGames playoff grace period', () => {
    const futureGame = {
      uniqueId: 'NHL-playoff-if-necessary',
      league: League.NHL,
      startTimeUTC: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      homeTeamId: 'NHL-HOME',
      awayTeamId: 'NHL-AWAY',
    };

    beforeEach(() => {
      mockRefreshTimestampService.getTodayManualTimestamps.mockResolvedValue(
        [],
      );
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);
      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([
        {
          ...futureGame,
          uniqueId: 'NHL-other-game',
        },
      ]);
    });

    it('starts the grace period without deactivating a newly missing game', async () => {
      mockGameModel.exec.mockResolvedValue([{ ...futureGame }]);
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
      });

      expect(mockGameModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: { $in: [futureGame.uniqueId] } }),
        { $set: { missingSince: expect.any(String) } },
      );
      expect(mockGameModel.updateMany).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ $set: { isActive: false } }),
      );
      createSpy.mockRestore();
    });

    it('keeps a missing game active while it is within the grace period', async () => {
      const missingSince = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();
      mockGameModel.exec.mockResolvedValue([{ ...futureGame, missingSince }]);
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
      });

      expect(mockGameModel.updateMany).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ $set: { isActive: false } }),
      );
      createSpy.mockRestore();
    });

    it('deactivates a game missing beyond the grace period', async () => {
      const missingSince = new Date(
        Date.now() - 49 * 60 * 60 * 1000,
      ).toISOString();
      mockGameModel.exec.mockResolvedValue([{ ...futureGame, missingSince }]);
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
      });

      expect(mockGameModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: { $in: [futureGame.uniqueId] } }),
        { $set: { isActive: false }, $unset: { missingSince: 1 } },
      );
      createSpy.mockRestore();
    });

    it('deactivates immediately, skipping the grace period, when the series is already decided', async () => {
      mockGameModel.exec.mockResolvedValue([
        { ...futureGame, seriesStatus: 'SD wins series 2-0' },
      ]);
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
      });

      expect(mockGameModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: { $in: [futureGame.uniqueId] } }),
        { $set: { isActive: false }, $unset: { missingSince: 1 } },
      );
      // The grace marker must never be written for a decided series.
      expect(mockGameModel.updateMany).not.toHaveBeenCalledWith(
        expect.anything(),
        { $set: { missingSince: expect.any(String) } },
      );
      createSpy.mockRestore();
    });

    it('deactivates immediately even when the decided game is mid grace period', async () => {
      const missingSince = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();
      mockGameModel.exec.mockResolvedValue([
        { ...futureGame, missingSince, seriesStatus: 'SD wins series 2-0' },
      ]);
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
      });

      expect(mockGameModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: { $in: [futureGame.uniqueId] } }),
        { $set: { isActive: false }, $unset: { missingSince: 1 } },
      );
      createSpy.mockRestore();
    });

    it('still applies the grace period when the series status is not decided', async () => {
      mockGameModel.exec.mockResolvedValue([
        { ...futureGame, seriesStatus: 'Series tied 1-1' },
      ]);
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
      });

      expect(mockGameModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: { $in: [futureGame.uniqueId] } }),
        { $set: { missingSince: expect.any(String) } },
      );
      expect(mockGameModel.updateMany).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ $set: { isActive: false } }),
      );
      createSpy.mockRestore();
    });

    it('keeps a game whose series status is missing from the immediate deactivation', async () => {
      mockGameModel.exec.mockResolvedValue([
        { ...futureGame, seriesStatus: undefined },
      ]);
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
      });

      expect(mockGameModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: { $in: [futureGame.uniqueId] } }),
        { $set: { missingSince: expect.any(String) } },
      );
      expect(mockGameModel.updateMany).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ $set: { isActive: false } }),
      );
      createSpy.mockRestore();
    });

    it('clears the grace marker when the game reappears', async () => {
      const missingSince = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();
      mockGameModel.exec.mockResolvedValue([{ ...futureGame, missingSince }]);
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue({} as any);
      (service as any)._fetchUniqueGames = jest
        .fn()
        .mockResolvedValue([{ ...futureGame }]);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
      });

      expect(mockGameModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ uniqueId: { $in: [futureGame.uniqueId] } }),
        { $unset: { missingSince: 1 } },
      );
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          uniqueId: futureGame.uniqueId,
          isActive: true,
        }),
      );
      createSpy.mockRestore();
    });
  });

  describe('active game count cache invalidation', () => {
    /**
     * `GET /teams?minGames=…` reads a per-team game count memoised by
     * `TeamService`. Every path that writes or deletes games must clear that
     * memo, otherwise the endpoint keeps serving counts that no longer match
     * the collection.
     */
    const stubLeagueRefresh = () => {
      (service as any)._fetchUniqueGames = jest.fn().mockResolvedValue([]);
      (service as any)._deleteUnlinkedTeams = jest
        .fn()
        .mockResolvedValue(undefined);
    };

    it('is cleared after a normal league refresh', async () => {
      stubLeagueRefresh();
      mockGameModel.exec.mockResolvedValue([]);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
      });

      expect(mockTeamService.clearActiveGameCountCache).toHaveBeenCalled();
    });

    it('is cleared after an oldies (addMissingOnly) refresh', async () => {
      stubLeagueRefresh();
      mockGameModel.exec.mockResolvedValue([]);

      await service.getLeagueGames({
        league: League.NHL,
        forceUpdate: true,
        skipCascade: true,
        season: new Date().getFullYear() - 1,
        addMissingOnly: true,
      });

      expect(mockTeamService.clearActiveGameCountCache).toHaveBeenCalled();
    });

    it('is cleared when a game is deleted', async () => {
      mockGameModel.findOneAndDelete.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ uniqueId: 'NHL-1' }),
      });

      await service.remove('NHL-1');

      expect(mockTeamService.clearActiveGameCountCache).toHaveBeenCalled();
    });

    it('is cleared when a whole league is deleted', async () => {
      mockGameModel.deleteMany.mockResolvedValue({ deletedCount: 3 });

      await service.removeLeague(League.NHL);

      expect(mockTeamService.clearActiveGameCountCache).toHaveBeenCalled();
    });

    it('is cleared after the duplicate/old-games cleanup', async () => {
      mockGameModel.deleteMany.mockResolvedValue({ deletedCount: 0 });
      mockGameModel.exec.mockResolvedValue([]);
      mockGameModel.aggregate.mockResolvedValue([]);

      await service.removeDuplicatesAndOlds();

      expect(mockTeamService.clearActiveGameCountCache).toHaveBeenCalled();
    });

    it('is cleared after a disk-capacity purge of the oldest month', async () => {
      // Same setup as the existing purgeOldestMonth suites: the per-year counts
      // come from getAvailableYears(), the month from a single aggregate.
      jest
        .spyOn(service as any, 'getAvailableYears')
        .mockResolvedValue([{ year: 2016, count: 2496 }]);
      mockGameModel.aggregate = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([{ _id: '09', count: 296 }]),
      });
      mockGameModel.deleteMany.mockResolvedValue({ deletedCount: 296 });

      const result = await service.purgeOldestMonth();

      expect(result.action).toBe('purged');
      expect(mockTeamService.clearActiveGameCountCache).toHaveBeenCalled();
    });
  });

  describe('removeDuplicatesAndOlds retention', () => {
    it('deletes games older than maxYearBeforeDelete and preseason games older than 1 year', async () => {
      jest.spyOn(console, 'info').mockImplementation(() => undefined);
      mockGameModel.aggregate.mockResolvedValue([]);
      mockGameModel.deleteMany.mockResolvedValue({ deletedCount: 0 });
      mockGameModel.exec.mockResolvedValue([]);

      await service.removeDuplicatesAndOlds();

      // Two real deletions in DB: old games + old preseason games.
      expect(mockGameModel.deleteMany).toHaveBeenCalledTimes(2);

      // 1st call: games older than maxYearBeforeDelete (no phase filter).
      const oldGamesFilter = mockGameModel.deleteMany.mock.calls[0][0];
      expect(oldGamesFilter.recordSeasonType).toBeUndefined();
      expect(JSON.stringify(oldGamesFilter)).toContain('$lt');

      // 2nd call: preseason only, with a ~1-year cutoff.
      const preseasonFilter = mockGameModel.deleteMany.mock.calls[1][0];
      expect(preseasonFilter.recordSeasonType).toBe(1);
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const usedCutoff =
        preseasonFilter.$or?.[0]?.startTimeUTC?.$lt ??
        preseasonFilter.$or?.[1]?.gameDate?.$lt;
      expect(usedCutoff).toBeDefined();
      const cutoffDate = new Date(
        typeof usedCutoff === 'string' && usedCutoff.length === 10
          ? `${usedCutoff}T00:00:00.000Z`
          : usedCutoff,
      );
      // Cutoff must be within a few days of "1 year ago" (day-boundary rounding).
      expect(
        Math.abs(cutoffDate.getTime() - oneYearAgo.getTime()),
      ).toBeLessThan(3 * 24 * 60 * 60 * 1000);

      (console.info as jest.Mock).mockRestore();
    });

    it('returns a per-league summary of deleted games', async () => {
      jest.spyOn(console, 'info').mockImplementation(() => undefined);
      // aggregate is called twice (old games + preseason); both return the same breakdown here.
      mockGameModel.aggregate.mockResolvedValue([
        { _id: 'NHL', count: 2 },
        { _id: 'NFL', count: 1 },
      ]);
      mockGameModel.deleteMany.mockResolvedValue({ deletedCount: 0 });
      mockGameModel.exec.mockResolvedValue([]); // no duplicates

      const result = await service.removeDuplicatesAndOlds();

      expect(result.totalDeleted).toBe(6); // 3 old + 3 preseason + 0 duplicates
      expect(result.deletedByLeague).toEqual({ NHL: 4, NFL: 2 });
      expect(result.details.oldGames).toEqual({
        total: 3,
        byLeague: { NHL: 2, NFL: 1 },
      });
      expect(result.details.preseasonGames).toEqual({
        total: 3,
        byLeague: { NHL: 2, NFL: 1 },
      });
      expect(result.details.duplicates).toEqual({
        total: 0,
        byLeague: {},
      });

      (console.info as jest.Mock).mockRestore();
    });

    it('counts duplicates from the in-memory objects and includes them in the summary', async () => {
      jest.spyOn(console, 'info').mockImplementation(() => undefined);
      mockGameModel.aggregate.mockResolvedValue([]); // no old / preseason games
      mockGameModel.deleteMany.mockResolvedValue({ deletedCount: 0 });
      // Two active games share the same team+time key → one duplicate.
      mockGameModel.exec.mockResolvedValue([
        {
          uniqueId: 'DUP-1',
          league: 'NHL',
          teamSelectedId: 'T1',
          startTimeUTC: '2026-01-01T00:00:00.000Z',
          homeTeamScore: null,
          awayTeamScore: null,
        },
        {
          uniqueId: 'DUP-2',
          league: 'NHL',
          teamSelectedId: 'T1',
          startTimeUTC: '2026-01-01T00:00:00.000Z',
          homeTeamScore: 2,
          awayTeamScore: 1,
        },
      ]);

      const removeSpy = jest
        .spyOn(service as any, 'remove')
        .mockResolvedValue(undefined);

      const result = await service.removeDuplicatesAndOlds();

      expect(result.totalDeleted).toBe(1);
      expect(result.deletedByLeague).toEqual({ NHL: 1 });
      expect(result.details.duplicates.total).toBe(1);
      expect(removeSpy).toHaveBeenCalledWith('DUP-1'); // the no-score copy is removed

      removeSpy.mockRestore();
      (console.info as jest.Mock).mockRestore();
    });

    it('reads active games with a projected lean query to stay within the heap budget', async () => {
      // Regression guard for the Render 502: the dedup used to hydrate every
      // active game as a full Mongoose document, OOM-killing the 460 MB heap.
      jest.spyOn(console, 'info').mockImplementation(() => undefined);
      mockGameModel.aggregate.mockResolvedValue([]);
      mockGameModel.deleteMany.mockResolvedValue({ deletedCount: 0 });
      mockGameModel.exec.mockResolvedValue([]);

      await service.removeDuplicatesAndOlds();

      expect(mockGameModel.select).toHaveBeenCalledWith({
        uniqueId: 1,
        league: 1,
        teamSelectedId: 1,
        startTimeUTC: 1,
        homeTeamScore: 1,
        awayTeamScore: 1,
      });
      expect(mockGameModel.lean).toHaveBeenCalled();

      (console.info as jest.Mock).mockRestore();
    });
  });

  describe('_deleteUnlinkedTeams', () => {
    it('should call teamService.deleteManyByIds when unlinked team IDs are found', async () => {
      const league = League.NHL;
      mockGameModel.countDocuments.mockResolvedValue(5); // games exist for the league
      mockTeamService.findAll.mockResolvedValue([
        { uniqueId: 'NHL-T1' },
        { uniqueId: 'NHL-T2' },
      ]);
      // teamSelectedId distinct only references T1, so T2 is unlinked.
      mockGameModel.distinct.mockResolvedValue(['NHL-T1']);

      await (service as any)._deleteUnlinkedTeams(league);

      expect(mockTeamService.deleteManyByIds).toHaveBeenCalledWith(['NHL-T2']);
    });

    it('should not call teamService.deleteManyByIds if no unlinked teams are found', async () => {
      const league = League.NHL;
      mockGameModel.countDocuments.mockResolvedValue(5);
      mockTeamService.findAll.mockResolvedValue([
        { uniqueId: 'NHL-T1' },
        { uniqueId: 'NHL-T2' },
      ]);
      // All teams are referenced, so nothing is unlinked.
      mockGameModel.distinct.mockResolvedValue(['NHL-T1', 'NHL-T2']);

      await (service as any)._deleteUnlinkedTeams(league);

      expect(mockTeamService.deleteManyByIds).not.toHaveBeenCalled();
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
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Removed 2 unresolved game(s) started more than 90 days ago.',
        ),
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

    it('should query only games without any score', async () => {
      mockGameModel.exec.mockResolvedValue([]);

      await (service as any).removeStaleUnresolvedGames(90);

      expect(mockGameModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          isActive: true,
          homeTeamScore: null,
          awayTeamScore: null,
        }),
      );
    });

    it('should not purge an old game whose status reads as decided', async () => {
      // Regression: MLS-SEA-557514 (2019-10-19, final 4-3) was stored with
      // gameStatus "FINAL AET". It must never be deleted as "unresolved".
      const removeSpy = jest
        .spyOn(service, 'remove')
        .mockResolvedValue({} as any);
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();

      mockGameModel.exec.mockResolvedValue([
        {
          uniqueId: 'MLS-SEA-557514',
          league: League.MLS,
          gameStatus: 'FINAL AET',
        },
        { uniqueId: 'MLS-SEA-557515', league: League.MLS, gameStatus: 'final' },
      ]);

      await (service as any).removeStaleUnresolvedGames(90);

      expect(removeSpy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipped 2 old game(s) carrying a score'),
      );

      removeSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('purgeOldestMonthIfNeeded', () => {
    it('should return "none" if disk usage is below threshold', async () => {
      const getAvailableYearsSpy = jest
        .spyOn(service as any, 'getAvailableYears')
        .mockResolvedValue([
          {
            year: 2024,
            count: 100,
            oldestDate: '2024-01-01',
            newestDate: '2024-12-31',
          },
          {
            year: 2023,
            count: 80,
            oldestDate: '2023-01-01',
            newestDate: '2023-12-31',
          },
        ]);

      const getDiskUsageSpy = jest
        .spyOn(service as any, 'getDiskUsage')
        .mockResolvedValue({
          usedMB: 50,
          totalMB: 100,
          percentage: 0.5, // well below the 97% threshold
        });

      const result = await service.purgeOldestMonthIfNeeded();

      expect(result.action).toBe('none');
      expect(result.diskUsage.percentage).toBe(0.5);
      expect(result.remainingYears).toEqual([2024, 2023]);

      getAvailableYearsSpy.mockRestore();
      getDiskUsageSpy.mockRestore();
    });

    it('should purge ONLY the oldest month when disk usage exceeds threshold', async () => {
      const purgeOldestMonthSpy = jest
        .spyOn(service, 'purgeOldestMonth')
        .mockResolvedValue({
          action: 'purged',
          purgedYear: 2016,
          purgedMonth: 9,
          deletedCount: 296,
          remainingYears: [2017, 2023, 2024],
        });

      const getAvailableYearsSpy = jest
        .spyOn(service as any, 'getAvailableYears')
        .mockResolvedValue([
          {
            year: 2017,
            count: 80,
            oldestDate: '2017-01-01',
            newestDate: '2017-12-31',
          },
        ]);

      const getDiskUsageSpy = jest
        .spyOn(service as any, 'getDiskUsage')
        .mockResolvedValue({
          usedMB: 99,
          totalMB: 100,
          percentage: 0.99, // 99% - strictly above the 97% threshold
        });

      const result = await service.purgeOldestMonthIfNeeded();

      expect(result.action).toBe('purged');
      // Single-shot purge: exactly ONE month is purged, never a loop over years
      expect(purgeOldestMonthSpy).toHaveBeenCalledTimes(1);
      expect(result.purgedYear).toBe(2016);
      expect(result.purgedMonth).toBe(9);
      expect(result.deletedCount).toBe(296);
      expect(result.remainingYears).toEqual([2017, 2023, 2024]);
      expect(result.diskUsage.percentage).toBe(0.99);

      purgeOldestMonthSpy.mockRestore();
      getAvailableYearsSpy.mockRestore();
      getDiskUsageSpy.mockRestore();
    });

    it('never loops: purges a single month even when usage stays above threshold', async () => {
      // Regression guard: the old implementation kept deleting years because
      // getDiskUsage() returns a 60s-cached value, so the "drop below threshold"
      // condition never became true and the whole database was wiped.
      const purgeOldestMonthSpy = jest
        .spyOn(service, 'purgeOldestMonth')
        .mockResolvedValue({
          action: 'purged',
          purgedYear: 2016,
          purgedMonth: 9,
          deletedCount: 296,
          remainingYears: [2017],
        });

      jest.spyOn(service as any, 'getAvailableYears').mockResolvedValue([
        {
          year: 2017,
          count: 80,
          oldestDate: '2017-01-01',
          newestDate: '2017-12-31',
        },
      ]);

      // Disk usage NEVER drops below the threshold (stale cache scenario)
      jest.spyOn(service as any, 'getDiskUsage').mockResolvedValue({
        usedMB: 99,
        totalMB: 100,
        percentage: 0.99,
      });

      const result = await service.purgeOldestMonthIfNeeded();

      expect(result.action).toBe('purged');
      // The purge must be triggered exactly once per call — no iteration.
      expect(purgeOldestMonthSpy).toHaveBeenCalledTimes(1);

      jest.restoreAllMocks();
    });

    it('should not re-check disk if within CHECK_INTERVAL_MS', async () => {
      const getAvailableYearsSpy = jest
        .spyOn(service as any, 'getAvailableYears')
        .mockResolvedValue([
          {
            year: 2024,
            count: 100,
            oldestDate: '2024-01-01',
            newestDate: '2024-12-31',
          },
        ]);

      const getDiskUsageSpy = jest
        .spyOn(service as any, 'getDiskUsage')
        .mockResolvedValue({
          usedMB: 50,
          totalMB: 100,
          percentage: 0.5,
        });

      // First call
      await service.purgeOldestMonthIfNeeded();
      expect(getDiskUsageSpy).toHaveBeenCalledTimes(1);

      // Second call immediately after (should skip due to interval)
      const result = await service.purgeOldestMonthIfNeeded();
      expect(getDiskUsageSpy).toHaveBeenCalledTimes(1); // Still 1
      expect(result.action).toBe('none');

      getDiskUsageSpy.mockRestore();
      getAvailableYearsSpy.mockRestore();
    });
  });

  describe('DISK_USAGE_THRESHOLD', () => {
    it('is set to 97%', () => {
      // Single source of truth for every other fixture, doc and comment: if this
      // constant moves, this test moves with it instead of silently diverging.
      expect((service as any).DISK_USAGE_THRESHOLD).toBe(0.97);
    });

    it('is reported by getCapacityStatus and drives actionNeeded', async () => {
      mockGameModel.countDocuments.mockResolvedValue(10);

      const getDiskUsageSpy = jest
        .spyOn(service as any, 'getDiskUsage')
        .mockResolvedValue({ usedMB: 96, totalMB: 100, percentage: 0.96 });
      jest.spyOn(service as any, 'getAvailableYears').mockResolvedValue([]);

      const below = await service.getCapacityStatus();
      expect(below.threshold).toBe(0.97);
      expect(below.actionNeeded).toBe(false);

      getDiskUsageSpy.mockResolvedValue({
        usedMB: 97,
        totalMB: 100,
        percentage: 0.97,
      });
      // The comparison is `>=`, so sitting exactly on the threshold triggers it.
      const on = await service.getCapacityStatus();
      expect(on.threshold).toBe(0.97);
      expect(on.actionNeeded).toBe(true);

      getDiskUsageSpy.mockRestore();
    });
  });

  describe('getAvailableYears', () => {
    it('should return years sorted from oldest to newest with game counts', async () => {
      jest.spyOn(mockGameModel, 'find' as any);
      const mockAggregate = [
        {
          year: 2022,
          count: 50,
          oldestDate: '2022-01-01',
          newestDate: '2022-12-31',
        },
        {
          year: 2023,
          count: 80,
          oldestDate: '2023-01-01',
          newestDate: '2023-12-31',
        },
        {
          year: 2024,
          count: 100,
          oldestDate: '2024-01-01',
          newestDate: '2024-12-31',
        },
      ];

      mockGameModel.aggregate = jest.fn().mockResolvedValue(mockAggregate);

      const result = await (service as any).getAvailableYears();

      expect(result).toEqual(mockAggregate);
      expect(mockGameModel.aggregate).toHaveBeenCalled();
    });
  });
  describe('purgeOldestMonth', () => {
    beforeEach(() => {
      // Reset aggregate and deleteMany mocks
      mockGameModel.aggregate = jest.fn();
      mockGameModel.deleteMany = jest.fn().mockReturnValue({
        exec: jest
          .fn()
          .mockResolvedValue({ deletedCount: 0, acknowledged: true }),
      });
    });

    it('should return "none" when no years available', async () => {
      const getAvailableYearsSpy = jest
        .spyOn(service as any, 'getAvailableYears')
        .mockResolvedValue([]);

      const result = await service.purgeOldestMonth();

      expect(result.action).toBe('none');
      expect(mockGameModel.aggregate).not.toHaveBeenCalled();
      expect(mockGameModel.deleteMany).not.toHaveBeenCalled();

      getAvailableYearsSpy.mockRestore();
    });

    it('should return "none" when no games found in oldest year', async () => {
      const getAvailableYearsSpy = jest
        .spyOn(service as any, 'getAvailableYears')
        .mockResolvedValue([
          {
            year: 2016,
            count: 100,
            oldestDate: '2016-09-01',
            newestDate: '2016-12-31',
          },
        ]);

      mockGameModel.aggregate = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([]), // No months found
      });

      const result = await service.purgeOldestMonth();

      expect(result.action).toBe('none');
      expect(mockGameModel.deleteMany).not.toHaveBeenCalled();

      getAvailableYearsSpy.mockRestore();
    });

    it('should purge the oldest month successfully', async () => {
      const getAvailableYearsSpy = jest
        .spyOn(service as any, 'getAvailableYears')
        .mockResolvedValueOnce([
          {
            year: 2016,
            count: 2496,
            oldestDate: '2016-09-25',
            newestDate: '2016-12-31',
          },
          {
            year: 2017,
            count: 16831,
            oldestDate: '2017-01-01',
            newestDate: '2017-12-31',
          },
        ])
        .mockResolvedValueOnce([
          {
            year: 2016,
            count: 2200,
            oldestDate: '2016-10-01',
            newestDate: '2016-12-31',
          },
          {
            year: 2017,
            count: 16831,
            oldestDate: '2017-01-01',
            newestDate: '2017-12-31',
          },
        ]);

      // Mock aggregate to return oldest month = "09" (September)
      mockGameModel.aggregate = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([{ _id: '09', count: 296 }]),
      });

      // Mock deleteMany to return deleted count
      mockGameModel.deleteMany = jest
        .fn()
        .mockResolvedValueOnce({ deletedCount: 296, acknowledged: true });

      const result = await service.purgeOldestMonth();

      expect(result.action).toBe('purged');
      expect(result.purgedYear).toBe(2016);
      expect(result.purgedMonth).toBe(9);
      expect(result.deletedCount).toBe(296);
      expect(result.remainingYears).toEqual([2016, 2017]);

      // Verify aggregate was called with correct pipeline
      expect(mockGameModel.aggregate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            $match: expect.objectContaining({
              gameDate: expect.objectContaining({
                $gte: '2016-01-01',
                $lte: '2016-12-31',
              }),
            }),
          }),
        ]),
      );

      // Verify deleteMany was called with correct date range
      expect(mockGameModel.deleteMany).toHaveBeenCalledWith({
        gameDate: { $gte: '2016-09-01', $lte: '2016-09-30' },
      });

      getAvailableYearsSpy.mockRestore();
    });

    it('should handle last day of month correctly (December)', async () => {
      const getAvailableYearsSpy = jest
        .spyOn(service as any, 'getAvailableYears')
        .mockResolvedValue([
          {
            year: 2016,
            count: 500,
            oldestDate: '2016-12-01',
            newestDate: '2016-12-31',
          },
        ]);

      mockGameModel.aggregate = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([{ _id: '12', count: 500 }]),
      });

      mockGameModel.deleteMany = jest
        .fn()
        .mockResolvedValueOnce({ deletedCount: 500, acknowledged: true });

      const result = await service.purgeOldestMonth();

      expect(result.action).toBe('purged');
      expect(result.purgedYear).toBe(2016);
      expect(result.purgedMonth).toBe(12);

      // December has 31 days
      expect(mockGameModel.deleteMany).toHaveBeenCalledWith({
        gameDate: { $gte: '2016-12-01', $lte: '2016-12-31' },
      });

      getAvailableYearsSpy.mockRestore();
    });
  });

  describe('getDateRange', () => {
    it('should return min/max dates from the aggregate', async () => {
      mockGameModel.aggregate.mockResolvedValue([
        { minDate: '2024-01-01', maxDate: '2024-12-31' },
      ]);

      const result = await service.getDateRange();

      expect(result).toEqual({ minDate: '2024-01-01', maxDate: '2024-12-31' });
    });

    it('should return null dates when no active games match', async () => {
      mockGameModel.aggregate.mockResolvedValue([]);

      const result = await service.getDateRange();

      expect(result).toEqual({ minDate: null, maxDate: null });
    });

    it('should scope the match to the requested leagues (uppercased/trimmed)', async () => {
      mockGameModel.aggregate.mockResolvedValue([
        { minDate: '2025-01-01', maxDate: '2025-12-31' },
      ]);

      await service.getDateRange('NHL, nba,  ');

      const match = mockGameModel.aggregate.mock.calls[0][0][0].$match;
      expect(match.isActive).toBe(true);
      expect(match.league).toEqual({ $in: ['NHL', 'NBA'] });
    });
  });

  describe('getClosestDates', () => {
    it('should return the closest past and upcoming dates (two aggregates)', async () => {
      // call 1 = past ($max), call 2 = upcoming ($min)
      mockGameModel.aggregate
        .mockResolvedValueOnce([{ date: '2026-02-01' }])
        .mockResolvedValueOnce([{ date: '2026-03-10' }]);

      const result = await service.getClosestDates({});

      expect(result).toEqual({
        previousDate: '2026-02-01',
        nextDate: '2026-03-10',
      });
      expect(mockGameModel.aggregate).toHaveBeenCalledTimes(2);
    });

    it('should return null dates when nothing matches', async () => {
      mockGameModel.aggregate.mockResolvedValue([]);

      const result = await service.getClosestDates({});

      expect(result).toEqual({ previousDate: null, nextDate: null });
    });

    it('should use the provided date as the boundary instead of today', async () => {
      mockGameModel.aggregate
        .mockResolvedValueOnce([{ date: '2026-02-01' }])
        .mockResolvedValueOnce([{ date: '2026-03-10' }]);

      await service.getClosestDates({ date: '2026-02-15' });

      const pastMatch = mockGameModel.aggregate.mock.calls[0][0][0].$match;
      const nextMatch = mockGameModel.aggregate.mock.calls[1][0][0].$match;
      expect(pastMatch.gameDate).toEqual({ $lt: '2026-02-15' });
      expect(nextMatch.gameDate).toEqual({ $gte: '2026-02-15' });
    });

    it('should filter by leagues and teamSelectedIds via dedicated builder', async () => {
      mockGameModel.aggregate
        .mockResolvedValueOnce([{ date: '2026-02-01' }])
        .mockResolvedValueOnce([{ date: '2026-03-10' }]);

      await service.getClosestDates({
        leagues: 'PWHL,NHL',
        teamSelectedIds: ' PWHL-OTT , MLS-TOR ',
      });

      const match = mockGameModel.aggregate.mock.calls[0][0][0].$match;
      expect(match.isActive).toBe(true);
      expect(match.league).toEqual({ $in: ['PWHL', 'NHL'] });
      expect(match.teamSelectedId).toEqual({ $in: ['PWHL-OTT', 'MLS-TOR'] });
    });

    it('expands an Olympic team selection to its hockey and basketball team ids', async () => {
      mockGameModel.aggregate
        .mockResolvedValueOnce([{ date: '2026-02-01' }])
        .mockResolvedValueOnce([{ date: '2026-03-10' }]);

      await service.getClosestDates({
        teamSelectedIds: 'OLYMPICS-HOCKEY-MEN-FRA',
      });

      const match = mockGameModel.aggregate.mock.calls[0][0][0].$match;
      expect(match.teamSelectedId).toEqual({
        $in: ['OLYMPICS-HOCKEY-MEN-FRA', 'OLYMPICS-BASKETBALL-MEN-FRA'],
      });
    });

    it('filters Olympic selections by country and gender without adding empty sport rows', async () => {
      mockGameModel.exec.mockResolvedValue([]);
      mockTeamService.findAll.mockResolvedValue([]);

      const result = await service.filterGames({
        startDate: '2026-02-01',
        endDate: '2026-02-01',
        teamSelectedIds: 'OLYMPICS-BASKETBALL-WOMEN-USA',
      });

      const filter = mockGameModel.find.mock.calls[0][0];
      expect(filter.teamSelectedId).toEqual({
        $in: ['OLYMPICS-HOCKEY-WOMEN-USA', 'OLYMPICS-BASKETBALL-WOMEN-USA'],
      });
      expect(Object.values(result).flat()).toEqual([]);
    });
  });

  describe('read-only routes (no refresh-on-empty)', () => {
    it('findAll returns [] on an empty DB without calling getAllGames', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      const getAllGamesSpy = jest
        .spyOn(service, 'getAllGames')
        .mockResolvedValue([] as any);
      mockGameModel.exec.mockResolvedValue([]);

      const result = await service.findAll();

      expect(result).toEqual([]);
      expect(getAllGamesSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('findByDate returns [] for an empty day without calling getAllGames', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      const getAllGamesSpy = jest
        .spyOn(service, 'getAllGames')
        .mockResolvedValue([] as any);
      mockGameModel.exec.mockResolvedValue([]);

      const result = await service.findByDate('2026-07-01');

      expect(result).toEqual([]);
      expect(getAllGamesSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('findByDateHour returns {} for an empty day without calling getAllGames', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      const getAllGamesSpy = jest
        .spyOn(service, 'getAllGames')
        .mockResolvedValue([] as any);
      mockGameModel.exec.mockResolvedValue([]);

      const result = await service.findByDateHour('2026-07-01');

      expect(result).toEqual({});
      expect(getAllGamesSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('findByDateLeague (past days grouped by league)', () => {
    const nhlGame = {
      uniqueId: 'NHL-1',
      league: League.NHL,
      homeTeamId: 'NHL-BOS',
      awayTeamId: 'NHL-TOR',
      startTimeUTC: '2026-01-10T00:00:00.000Z',
      gameStatus: 'FINISHED',
    };
    const nhlGame2 = {
      uniqueId: 'NHL-2',
      league: League.NHL,
      homeTeamId: 'NHL-NYR',
      awayTeamId: 'NHL-MTL',
      startTimeUTC: '2026-01-10T02:00:00.000Z',
      gameStatus: 'FINISHED',
    };
    const nbaGame = {
      uniqueId: 'NBA-1',
      league: League.NBA,
      homeTeamId: 'NBA-LAL',
      awayTeamId: 'NBA-BOS',
      startTimeUTC: '2026-01-10T01:00:00.000Z',
      gameStatus: 'FINISHED',
    };
    const mlbGame = {
      uniqueId: 'MLB-1',
      league: League.MLB,
      homeTeamId: 'MLB-CHC',
      awayTeamId: 'MLB-STL',
      startTimeUTC: '2026-01-10T03:00:00.000Z',
      gameStatus: 'FINISHED',
    };

    beforeEach(() => {
      mockTeamService.findAll.mockResolvedValue([]);
    });

    it('sorts games oldest-to-most-recent inside every league group', async () => {
      mockGameModel.exec.mockResolvedValue([nhlGame2, nbaGame, nhlGame]);

      const result = await service.findByDateLeague('2026-01-10');

      expect(result.groups.map((group) => group.key)).toEqual([
        League.NBA,
        League.NHL,
      ]);
      // Games are ordered from oldest to most recent within each group,
      // even though the DB returned them in reverse order.
      expect(result.groups[1].games.map((game) => game.uniqueId)).toEqual([
        'NHL-1',
        'NHL-2',
      ]);
    });

    it('orders the league groups alphabetically', async () => {
      mockGameModel.exec.mockResolvedValue([mlbGame, nbaGame, nhlGame]);

      const result = await service.findByDateLeague('2026-01-10');

      expect(result.groups.map((group) => group.key)).toEqual([
        League.MLB,
        League.NBA,
        League.NHL,
      ]);
    });

    it('applies the same leagues filter and pagination as findByDateHour', async () => {
      mockGameModel.exec.mockResolvedValue([nhlGame]);

      await service.findByDateLeague('2026-01-10', 'nhl, nba', 25, 5);

      const filter = mockGameModel.find.mock.calls[0][0];
      expect(filter.isActive).toBe(true);
      expect(filter.league).toEqual({ $in: [League.NHL, League.NBA] });
      expect(filter.gameDate).toBe('2026-01-10');
      expect(mockGameModel.sort).toHaveBeenCalledWith({ startTimeUTC: 1 });
      expect(mockGameModel.skip).toHaveBeenCalledWith(5);
      expect(mockGameModel.limit).toHaveBeenCalledWith(25);
    });

    it('returns { groups: [] } for an empty day without calling getAllGames', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      const getAllGamesSpy = jest
        .spyOn(service, 'getAllGames')
        .mockResolvedValue([] as any);
      mockGameModel.exec.mockResolvedValue([]);

      const result = await service.findByDateLeague('2026-01-10');

      expect(result).toEqual({ groups: [] });
      expect(getAllGamesSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('findResultsByLeague', () => {
    const finishedGame = (
      uniqueId: string,
      gameDate: string,
      startTimeUTC: string,
    ) => ({
      uniqueId,
      league: League.NHL,
      homeTeamId: 'NHL-BOS',
      awayTeamId: 'NHL-TOR',
      teamSelectedId: 'NHL-BOS',
      gameDate,
      startTimeUTC,
      gameStatus: 'FINISHED',
      isActive: true,
      selectedTeam: true,
      recordSeasonType: 2,
      homeTeamScore: 2,
      awayTeamScore: 1,
    });

    beforeEach(() => {
      mockTeamService.findAll.mockResolvedValue([]);
    });

    it('defaults to the 4-year window and the 5000-result cap', async () => {
      mockGameModel.exec.mockResolvedValue([]);

      await service.findResultsByLeague('NHL');

      const fourYearsAgo = new Date();
      fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
      const expectedStartDate = `${fourYearsAgo.getFullYear()}-${String(
        fourYearsAgo.getMonth() + 1,
      ).padStart(2, '0')}-${String(fourYearsAgo.getDate()).padStart(2, '0')}`;

      const filter = mockGameModel.find.mock.calls[0][0];
      expect(filter.isActive).toBe(true);
      expect(filter.league).toBe('NHL');
      expect(filter.gameDate.$gte).toBe(expectedStartDate);
      expect(mockGameModel.limit).toHaveBeenCalledWith(5000);
    });

    it('queries newest-first so the cap keeps the most recent games, and returns days chronologically', async () => {
      // The DB answers newest-first (as the query asks): the descending sort
      // is an implementation detail of the cap, the payload must stay
      // chronological for every consumer.
      mockGameModel.exec.mockResolvedValue([
        finishedGame('NHL-2', '2025-12-02', '2025-12-02T19:00:00.000Z'),
        finishedGame('NHL-1', '2025-12-01', '2025-12-01T19:00:00.000Z'),
      ]);

      const result = await service.findResultsByLeague(
        'NHL',
        '2022-01-01',
        5000,
      );

      expect(mockGameModel.sort).toHaveBeenCalledWith({ startTimeUTC: -1 });
      expect(Object.keys(result)).toEqual(['2025-12-01', '2025-12-02']);
      expect(result['2025-12-01'].map((game: any) => game.uniqueId)).toEqual([
        'NHL-1',
      ]);
    });

    it('forwards an explicit startDate and maxResults', async () => {
      mockGameModel.exec.mockResolvedValue([]);

      await service.findResultsByLeague('NCAAB', '2024-06-15', 1200);

      const filter = mockGameModel.find.mock.calls[0][0];
      expect(filter.gameDate.$gte).toBe('2024-06-15');
      expect(filter.league).toBe('NCAAB');
      expect(mockGameModel.limit).toHaveBeenCalledWith(1200);
    });

    it('drops days left empty by the score filter', async () => {
      mockGameModel.exec.mockResolvedValue([
        finishedGame('NHL-1', '2025-12-01', '2025-12-01T19:00:00.000Z'),
        {
          ...finishedGame('NHL-3', '2025-12-02', '2025-12-02T19:00:00.000Z'),
          homeTeamScore: null,
          awayTeamScore: null,
        },
      ]);

      const result = await service.findResultsByLeague('NHL');

      expect(Object.keys(result)).toEqual(['2025-12-01']);
    });
  });

  describe('findUsedTeamIds / purgeStaleTeamsWithoutGames', () => {
    it('findUsedTeamIds unions teamSelectedId + homeTeamId + awayTeamId of active games', async () => {
      mockGameModel.distinct.mockImplementation((field: string) => ({
        exec: jest
          .fn()
          .mockResolvedValue(
            field === 'teamSelectedId'
              ? ['NHL-BOS', 'NHL-TOR']
              : field === 'homeTeamId'
                ? ['NHL-BOS', '']
                : ['NHL-EDM', null],
          ),
      }));

      const used = await service.findUsedTeamIds();

      expect(mockGameModel.distinct).toHaveBeenCalledWith('teamSelectedId', {
        isActive: true,
      });
      expect(mockGameModel.distinct).toHaveBeenCalledWith('homeTeamId', {
        isActive: true,
      });
      expect(mockGameModel.distinct).toHaveBeenCalledWith('awayTeamId', {
        isActive: true,
      });
      expect(used).toEqual(new Set(['NHL-BOS', 'NHL-TOR', 'NHL-EDM']));
    });

    it('purgeStaleTeamsWithoutGames delegates used ids to TeamService', async () => {
      mockGameModel.distinct.mockImplementation(() => ({
        exec: jest.fn().mockResolvedValue(['NHL-BOS']),
      }));
      const purgeResult = {
        action: 'purged' as const,
        candidates: 1,
        deletedCount: 1,
        deletedIds: ['NHL-TOR'],
      };
      mockTeamService.purgeStaleTeamsWithoutGames = jest
        .fn()
        .mockResolvedValue(purgeResult);

      const result = await service.purgeStaleTeamsWithoutGames();

      expect(result).toEqual(purgeResult);
      expect(mockTeamService.purgeStaleTeamsWithoutGames).toHaveBeenCalledWith(
        new Set(['NHL-BOS']),
      );
    });
  });

  describe('refreshUndecidedPlayoffSeries', () => {
    it('returns no updates when there are no undecided playoff series', async () => {
      mockGameModel.find.mockReturnThis();
      mockGameModel.lean.mockReturnThis();
      mockGameModel.exec.mockResolvedValue([]);

      const result = await (service as any).refreshUndecidedPlayoffSeries(10);

      expect(result).toEqual({ updated: 0, series: [] });
      expect(mockGameModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          recordSeasonType: 3,
          isActive: true,
        }),
        expect.anything(),
      );
    });

    it('returns no updates when no series has a clear winner', async () => {
      // Two undecided games of the same series, neither team has 3+ wins
      const game1 = {
        _id: 'g1',
        league: League.MLB,
        homeTeamId: 'MLB-MIL',
        awayTeamId: 'MLB-LAD',
        startTimeUTC: '2026-10-10T00:00:00.000Z',
        homeTeamScore: 5,
        awayTeamScore: 3,
        seriesStatus: '',
      };
      const game2 = {
        _id: 'g2',
        league: League.MLB,
        homeTeamId: 'MLB-MIL',
        awayTeamId: 'MLB-LAD',
        startTimeUTC: '2026-10-12T00:00:00.000Z',
        homeTeamScore: 2,
        awayTeamScore: 7,
        seriesStatus: '',
      };

      mockGameModel.find
        .mockReturnValueOnce({
          lean: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([game1, game2]),
        })
        .mockReturnValueOnce({
          lean: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([game1, game2]),
        });

      const result = await (service as any).refreshUndecidedPlayoffSeries(10);

      // 1-1: no team has 3 wins (best-of-5) or 4 wins (best-of-7)
      expect(result).toEqual({ updated: 0, series: [] });
      expect(mockGameModel.updateMany).not.toHaveBeenCalled();
    });

    it('updates all games of a series when one team clearly won', async () => {
      const seasonStart = new Date(2026, 0, 1).toISOString();
      const seasonEnd = new Date(2027, 0, 1).toISOString();

      // Undecided games (no seriesStatus winner)
      const undecidedGames = [
        {
          _id: 'g1',
          league: League.MLB,
          homeTeamId: 'MLB-MIL',
          awayTeamId: 'MLB-LAD',
          startTimeUTC: '2026-10-08T00:00:00.000Z',
          homeTeamScore: 5,
          awayTeamScore: 3,
          seriesStatus: '',
        },
        {
          _id: 'g2',
          league: League.MLB,
          homeTeamId: 'MLB-LAD',
          awayTeamId: 'MLB-MIL',
          startTimeUTC: '2026-10-10T00:00:00.000Z',
          homeTeamScore: 1,
          awayTeamScore: 8,
          seriesStatus: '',
        },
        {
          _id: 'g3',
          league: League.MLB,
          homeTeamId: 'MLB-MIL',
          awayTeamId: 'MLB-LAD',
          startTimeUTC: '2026-10-12T00:00:00.000Z',
          homeTeamScore: 2,
          awayTeamScore: 6,
          seriesStatus: '',
        },
        {
          _id: 'g4',
          league: League.MLB,
          homeTeamId: 'MLB-LAD',
          awayTeamId: 'MLB-MIL',
          startTimeUTC: '2026-10-14T00:00:00.000Z',
          homeTeamScore: 0,
          awayTeamScore: 4,
          seriesStatus: '',
        },
      ];

      mockGameModel.find
        .mockReturnValueOnce({
          lean: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(undecidedGames),
        })
        // Second call: fetch ALL games of the series (same 4 games)
        .mockReturnValueOnce({
          lean: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(undecidedGames),
        });

      mockGameModel.updateMany.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 4 }),
      });

      const result = await (service as any).refreshUndecidedPlayoffSeries(10);

      expect(result.updated).toBe(4);
      expect(result.series.length).toBe(1);
      expect(result.series[0]).toContain('MLB-MIL beats MLB-LAD');
      expect(mockGameModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          league: League.MLB,
          recordSeasonType: 3,
          startTimeUTC: {
            $gte: seasonStart,
            $lt: seasonEnd,
          },
        }),
        { $set: { seriesStatus: 'MLB-MIL wins series 3-1' } },
      );
    });
  });
});
