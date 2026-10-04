import { League } from '../enum';
import { HockeyData } from './hockeyData';

/**
 * PWHL records regression: `GameService.refreshCurrentSeasonRecords()` fills a
 * `teamRecords` map and writes it to the teams collection. The PWHL branch of
 * `_fetchUniqueGames()` used to drop that map on the floor, so no PWHL
 * `team.record` was ever refreshed by the twice-daily records cron.
 */
describe('HockeyData.getHockeySchedule — PWHL team records', () => {
  const originalFetch = global.fetch;

  let hockeyData: HockeyData;
  let getPWHLStandingsSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    hockeyData = new HockeyData();
    // No team fetch at all: the records collection must not depend on the teams.
    getPWHLStandingsSpy = jest
      .spyOn(hockeyData, 'getPWHLStandings')
      .mockResolvedValue({ BOS: '12-8-4', NYR: '9-10-5' });
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    global.fetch = jest.fn().mockRejectedValue(new Error('no network')) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    getPWHLStandingsSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('fills teamRecords from the PWHL standings for the current season', async () => {
    const teamRecords = new Map<string, string>();

    // activeTeams = [] -> no per-team schedule fetch; empty result is fine.
    await hockeyData.getHockeySchedule(
      [],
      {},
      League.PWHL,
      true,
      undefined,
      teamRecords,
    );

    expect(teamRecords.get('PWHL-BOS')).toBe('12-8-4');
    expect(teamRecords.get('PWHL-NYR')).toBe('9-10-5');
  });

  it('leaves teamRecords untouched when no map is provided', async () => {
    await hockeyData.getHockeySchedule([], {}, League.PWHL, true, undefined);
    expect(getPWHLStandingsSpy).not.toHaveBeenCalled();
  });

  it('does not touch the records when fetching a past season (oldies)', async () => {
    const teamRecords = new Map<string, string>();

    await hockeyData.getHockeySchedule(
      [],
      {},
      League.PWHL,
      true,
      2023,
      teamRecords,
    );

    expect(getPWHLStandingsSpy).not.toHaveBeenCalled();
    expect(teamRecords.size).toBe(0);
  });

  it('does not fetch records for another league', async () => {
    const teamRecords = new Map<string, string>();

    await hockeyData.getHockeySchedule(
      [],
      {},
      League.NHL,
      true,
      undefined,
      teamRecords,
    );

    expect(getPWHLStandingsSpy).not.toHaveBeenCalled();
    expect(teamRecords.size).toBe(0);
  });

  it('falls back to the schedule replay when the standings feed is empty', async () => {
    getPWHLStandingsSpy.mockResolvedValue({});

    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        SiteKit: {
          Schedule: [
            {
              id: 1,
              GameDateISO8601: '2026-01-10T00:00:00',
              home_team_code: 'BOS',
              visiting_team_code: 'NYR',
              home_goal_count: 3,
              visiting_goal_count: 1,
              final: '1',
              game_type: '1',
              game_status: 'FINAL',
            },
            {
              id: 2,
              GameDateISO8601: '2026-01-17T00:00:00',
              home_team_code: 'NYR',
              visiting_team_code: 'BOS',
              home_goal_count: 2,
              visiting_goal_count: 3,
              final: '1',
              game_type: '1',
              game_status: 'FINAL',
              shootout: '1',
            },
          ],
        },
      }),
    } as any);

    const teamRecords = new Map<string, string>();
    await hockeyData.getHockeySchedule(
      [],
      {},
      League.PWHL,
      true,
      undefined,
      teamRecords,
    );

    // BOS 2 wins (regulation + SO), NYR 1 regulation loss + 1 shootout loss.
    expect(teamRecords.get('PWHL-BOS')).toBe('2-0-0');
    expect(teamRecords.get('PWHL-NYR')).toBe('0-1-1');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PWHL standings returned nothing'),
    );
  });

  it('never throws when both sources fail', async () => {
    getPWHLStandingsSpy.mockRejectedValue(new Error('standings down'));

    const teamRecords = new Map<string, string>();
    await expect(
      hockeyData.getHockeySchedule(
        [],
        {},
        League.PWHL,
        true,
        undefined,
        teamRecords,
      ),
    ).resolves.toBeDefined();

    expect(teamRecords.size).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
