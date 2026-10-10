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
  let consoleInfoSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    hockeyData = new HockeyData();
    // No team fetch at all: the records collection must not depend on the teams.
    getPWHLStandingsSpy = jest
      .spyOn(hockeyData, 'getPWHLStandings')
      .mockResolvedValue({ BOS: '12-8-4', NYR: '9-10-5' });
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    global.fetch = jest.fn().mockRejectedValue(new Error('no network')) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    getPWHLStandingsSpy.mockRestore();
    consoleInfoSpy.mockRestore();
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

  it('logs each team schedule count and the distinct league total', async () => {
    jest.spyOn(hockeyData, 'getPWHLTeamschedule').mockResolvedValue([
      {
        uniqueId: 'PWHL-BOS-2026-01-01-1',
        startTimeUTC: '2026-01-01T20:00:00.000Z',
        homeTeamId: 'PWHL-BOS',
        awayTeamId: 'PWHL-NYR',
      },
    ] as any);

    await hockeyData.getHockeySchedule(
      [
        {
          id: 'BOS',
          uniqueId: 'PWHL-BOS',
          label: 'Boston Fleet',
        },
      ],
      {},
      League.PWHL,
    );

    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[Schedule] PWHL Boston Fleet: 1 game(s) fetched.',
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[Schedule] PWHL: fetched schedules for 1 team(s), 1 distinct game(s) across those schedules.',
    );
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

/**
 * `getPWHLScores()` regression: the schedule used to be requested **without**
 * `season_id`, and HockeyTech then answers with its default season (the live
 * pre-season). A past date was simply absent from the payload, so the day
 * filter returned nothing and the record replay produced neither `finals` nor
 * `seasonOver` — no record on any past date.
 *
 * It also had to pick the season from the **exact date**: pre-season, regular
 * season and playoffs each have their own `season_id`, and several of them
 * overlap a single calendar year, so merging every season that overlaps the
 * year would total several seasons into one record.
 */
describe('HockeyData.getPWHLScores — season resolution', () => {
  const originalFetch = global.fetch;

  const SEASONS = [
    {
      season_id: '11',
      season_name: '2026-27 Regular Season',
      start_date: '2026-12-04',
      end_date: '2027-04-19',
    },
    {
      season_id: '10',
      season_name: '2026-27 Pre-Season',
      start_date: '2026-10-01',
      end_date: '2026-11-30',
    },
    {
      season_id: '9',
      season_name: '2026 Playoffs',
      start_date: '2026-04-28',
      end_date: '2026-05-28',
    },
    {
      season_id: '8',
      season_name: '2025-26 Regular Season',
      start_date: '2025-11-21',
      end_date: '2026-04-27',
    },
    {
      season_id: '6',
      season_name: '2025 Playoffs',
      start_date: '2025-05-06',
      end_date: '2025-06-03',
    },
    {
      season_id: '5',
      season_name: '2024-25 Regular Season',
      start_date: '2024-11-25',
      end_date: '2025-05-05',
    },
  ];

  const game = (over: Record<string, unknown> = {}) => ({
    id: 'g1',
    date_played: '2025-02-15',
    GameDateISO8601: '2025-02-15T00:00:00',
    home_team_code: 'MTL',
    visiting_team_code: 'NY',
    home_goal_count: '6',
    visiting_goal_count: '2',
    final: '1',
    status: '4',
    game_status: 'FINAL',
    game_type: '',
    overtime: '0',
    shootout: '0',
    ...over,
  });

  let hockeyData: HockeyData;

  const mockFeed = (schedules: Record<string, any[]>) => {
    global.fetch = jest.fn(async (url: string) => {
      const isSeasons = String(url).includes('view=seasons');
      const seasonId = new URL(String(url)).searchParams.get('season_id');
      const body = isSeasons
        ? { SiteKit: { Seasons: SEASONS } }
        : { SiteKit: { Schedule: schedules[seasonId ?? 'default'] ?? [] } };
      return { json: async () => body } as any;
    }) as any;
  };

  const requestedSeasonIds = () =>
    (global.fetch as jest.Mock).mock.calls
      .map(([url]) => String(url))
      .filter((u) => u.includes('view=schedule'))
      .map((u) => new URL(u).searchParams.get('season_id'));

  beforeEach(() => {
    hockeyData = new HockeyData();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('requests the regular season covering a past date, not the default feed', async () => {
    mockFeed({ '5': [game()] });

    const scores = await hockeyData.getPWHLScores('2025-02-15');

    expect(requestedSeasonIds()).toContain('5');
    expect(requestedSeasonIds()).not.toContain(null);
    expect(scores).toHaveLength(1);
  });

  it('computes the record from the regular season, not from the playoffs feed', async () => {
    // A playoff day: games live in season 6, the W-L-OTL in season 5.
    mockFeed({
      '6': [
        game({
          id: 'po1',
          date_played: '2025-05-07',
          GameDateISO8601: '2025-05-07T00:00:00',
          home_team_code: 'TOR',
          visiting_team_code: 'MIN',
        }),
      ],
      // Regular season replay: TOR beat MIN, so TOR = 1-0-0 and MIN = 0-1-0.
      '5': [
        game({
          id: 'rs1',
          home_team_code: 'TOR',
          visiting_team_code: 'MIN',
          home_goal_count: '6',
          visiting_goal_count: '2',
        }),
      ],
    });

    const scores = await hockeyData.getPWHLScores('2025-05-07');

    // Both feeds are read: the day from the playoffs, the tally from the
    // regular season that ended just before it.
    expect(requestedSeasonIds()).toEqual(expect.arrayContaining(['6', '5']));
    expect(scores).toHaveLength(1);
    expect(scores[0].homeTeamRecord).toBe('1-0-0');
    expect(scores[0].awayTeamRecord).toBe('0-1-0');
  });

  it('reads a single schedule when the day already belongs to the record season', async () => {
    mockFeed({ '8': [game({ date_played: '2026-04-11' })] });

    await hockeyData.getPWHLScores('2026-04-11');

    expect(requestedSeasonIds()).toEqual(['8']);
  });

  it('falls back to the default feed when no season covers the date', async () => {
    mockFeed({ default: [] });

    await hockeyData.getPWHLScores('1999-01-05');

    expect(requestedSeasonIds()).toEqual([null]);
  });

  it('returns an empty list when the date has no games', async () => {
    mockFeed({ '5': [game()] });

    await expect(hockeyData.getPWHLScores('2025-02-16')).resolves.toEqual([]);
  });
});

/**
 * PWHL Las Vegas code-normalization regression.
 *
 * The HockeyTech feed is internally inconsistent about the Las Vegas team:
 * the `teamsbyseason` feed and the **pre-season** schedule use `VEG`, while the
 * **regular-season** schedule and standings use `VGS` (and `LV` has appeared
 * too). Every place that reads a team code must fold these aliases onto the
 * canonical `VGS`, otherwise the same team is emitted under two different ids
 * (`PWHL-VGS` vs `PWHL-VEG`) and breaks the name/colour lookup, favourites and
 * record tallies. `VGS` is canonical because it is the regular-season code (the
 * largest set of games).
 */
describe('HockeyData — PWHL Las Vegas code normalization', () => {
  const originalFetch = global.fetch;

  let hockeyData: HockeyData;

  const mockFetchJson = (bodies: Record<string, any>) => {
    global.fetch = jest.fn(async (url: string) => {
      const u = String(url);
      const body = u.includes('view=teamsbyseason')
        ? bodies.teams
        : u.includes('view=statviewtype')
          ? bodies.standings
          : u.includes('view=schedule')
            ? bodies.schedule
            : {};
      return { json: async () => body } as any;
    }) as any;
  };

  beforeEach(() => {
    hockeyData = new HockeyData();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('folds the teams-feed code VEG/LV onto the canonical VGS', async () => {
    mockFetchJson({
      teams: {
        SiteKit: {
          Teamsbyseason: [
            { code: 'VEG', name: 'PWHL Las Vegas', team_logo_url: 'lv.png' },
            { code: 'LV', name: 'PWHL Las Vegas', team_logo_url: 'lv.png' },
            { code: 'VGS', name: 'PWHL Las Vegas', team_logo_url: 'lv.png' },
          ],
        },
      },
      standings: {},
    });

    const teams = await hockeyData.getPWHLTeams();

    // All three aliases resolve to the same canonical id.
    expect(teams.map((t) => t.uniqueId)).toEqual([
      'PWHL-VGS',
      'PWHL-VGS',
      'PWHL-VGS',
    ]);
    expect(teams.every((t) => t.abbrev === 'VGS')).toBe(true);
  });

  it('normalizes the schedule so a pre-season VEG game matches the VGS team', async () => {
    mockFetchJson({
      // Teams feed uses VGS (canonical) for Las Vegas.
      teams: {
        SiteKit: {
          Teamsbyseason: [
            { code: 'VGS', name: 'PWHL Las Vegas', team_logo_url: 'lv.png' },
          ],
        },
      },
      standings: {},
      // Pre-season schedule uses VEG for the very same team.
      schedule: {
        SiteKit: {
          Schedule: [
            {
              id: '500',
              date_played: '2026-11-22',
              GameDateISO8601: '2026-11-22T00:00:00',
              home_team_name: 'Las Vegas',
              home_team_nickname: 'PWHL',
              home_team_city: 'Las Vegas',
              home_team_code: 'VEG',
              visiting_team_name: 'Minnesota',
              visiting_team_nickname: 'Frost',
              visiting_team_city: 'Minnesota',
              visiting_team_code: 'MIN',
              home_goal_count: '0',
              visiting_goal_count: '0',
              final: '0',
              venue_name: 'Dollar Loan Center | Henderson',
              venue_location: 'Henderson, NV',
            },
          ],
        },
      },
    });

    // Requesting the VGS team must still find the VEG-coded game.
    const games = await hockeyData.getPWHLTeamschedule(
      'VGS',
      'PWHL-VGS',
      { VGS: 'lv.png', MIN: 'min.png' } as any,
      true,
    );

    expect(games).toHaveLength(1);
    expect(games[0].homeTeamId).toBe('PWHL-VGS');
    expect(games[0].homeTeamShort).toBe('VGS');
    expect(games[0].homeTeamLogo).toBe('lv.png');
  });
});
