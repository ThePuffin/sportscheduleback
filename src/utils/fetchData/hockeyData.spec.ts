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
 *
 * Scope rule: **past** groups use the local schedule replay
 * (`applyPWHLHistoricalRecords`); the **current** group (covering today) keeps
 * the one-month-ago behaviour — records from the official standings feed.
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

  const mockFeed = (seasons: any[], schedules: Record<string, any[]>) => {
    global.fetch = jest.fn(async (url: string) => {
      const isSeasons = String(url).includes('view=seasons');
      const isStandings = String(url).includes('view=statviewtype');
      const seasonId = new URL(String(url)).searchParams.get('season_id');
      const body = isSeasons
        ? { SiteKit: { Seasons: seasons } }
        : isStandings
          ? { SiteKit: { Statviewtype: [] } }
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
    // Freeze "today" so the current/past branch is deterministic: 2026-10-05
    // is covered by the 2026-27 pre-season (10) in the SEASONS fixture.
    jest.useFakeTimers().setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('requests the regular season covering a past date, not the default feed', async () => {
    mockFeed(SEASONS, { '5': [game()] });

    const scores = await hockeyData.getPWHLScores('2025-02-15');

    expect(requestedSeasonIds()).toContain('5');
    expect(requestedSeasonIds()).not.toContain(null);
    expect(scores).toHaveLength(1);
  });

  it('keeps the playoff tally on its own, never mixed with the regular season', async () => {
    // A playoff day: both feeds exist, but a playoff run must be tallied on its
    // own — a 4-1 playoff record has nothing to do with the 35-37-10 of the
    // regular season it follows.
    mockFeed(SEASONS, {
      '6': [
        // Played the day before the day under test.
        game({
          id: 'po0',
          date_played: '2025-05-06',
          GameDateISO8601: '2025-05-06T00:00:00',
          home_team_code: 'MIN',
          visiting_team_code: 'TOR',
          home_goal_count: '3',
          visiting_goal_count: '1',
        }),
        game({
          id: 'po1',
          date_played: '2025-05-07',
          GameDateISO8601: '2025-05-07T00:00:00',
          home_team_code: 'TOR',
          visiting_team_code: 'MIN',
          home_goal_count: '6',
          visiting_goal_count: '2',
        }),
      ],
      '5': [
        game({
          id: 'rs1',
          home_team_code: 'MTL',
          visiting_team_code: 'NY',
          home_goal_count: '6',
          visiting_goal_count: '2',
        }),
      ],
    });

    const scores = await hockeyData.getPWHLScores('2025-05-07');

    // Only the playoffs feed is read: the regular season is not needed for a
    // record that belongs to the playoffs.
    expect(requestedSeasonIds()).toEqual(['6']);
    expect(scores).toHaveLength(1);
    // Both playoff games replayed: TOR 1-1-0, MIN 1-1-0.
    expect(scores[0].homeTeamRecord).toBe('1-1-0');
    expect(scores[0].awayTeamRecord).toBe('1-1-0');
  });

  it('replays a past group still running at the time up to the game, not to today', async () => {
    // Regular season 2024-25 (5) covers 2025-02-15 and still had games after
    // it, so `seasonOver` is computed on the group — each game of the past
    // group shows the tally of everything played **before** it.
    mockFeed(SEASONS, {
      '5': [
        game({
          id: 'rs0',
          date_played: '2025-02-14',
          GameDateISO8601: '2025-02-14T00:00:00',
          home_team_code: 'MTL',
          visiting_team_code: 'NY',
          home_goal_count: '2',
          visiting_goal_count: '1',
        }),
        game({
          id: 'rs1',
          date_played: '2025-02-15',
          GameDateISO8601: '2025-02-15T00:00:00',
          home_team_code: 'NY',
          visiting_team_code: 'MTL',
        }),
        game({
          id: 'rs2',
          date_played: '2025-05-05',
          GameDateISO8601: '2025-05-05T00:00:00',
          home_team_code: 'MTL',
          visiting_team_code: 'NY',
          home_goal_count: '3',
          visiting_goal_count: '0',
        }),
      ],
    });

    const scores = await hockeyData.getPWHLScores('2025-02-15');

    expect(scores).toHaveLength(1);
    // Season 5 is over (ended 2025-05-05), so every game shows its final
    // tally: rs0 MTL win, rs1 NY win, rs2 MTL win -> MTL 2-1-0, NY 1-2-0.
    // rs1 is NY (home) vs MTL (away).
    expect(scores[0].homeTeamRecord).toBe('1-2-0');
    expect(scores[0].awayTeamRecord).toBe('2-1-0');
  });

  it('uses the standings for the current group, not the local replay', async () => {
    // 2026-10-04 is covered by the 2026-27 pre-season (10), which also covers
    // "today" (2026-10-05): this is the current group, so the one-month-ago
    // behaviour applies — records from the official standings feed.
    const seasons = [
      {
        season_id: '10',
        season_name: '2026-27 Pre-Season',
        start_date: '2026-10-01',
        end_date: '2026-11-30',
      },
    ];
    global.fetch = jest.fn(async (url: string) => {
      const isSeasons = String(url).includes('view=seasons');
      const isStandings = String(url).includes('view=statviewtype');
      if (isSeasons)
        return { json: async () => ({ SiteKit: { Seasons: seasons } }) } as any;
      if (isStandings) {
        return {
          json: async () => ({
            SiteKit: {
              Statviewtype: [
                {
                  team_code: 'MTL',
                  wins: '3',
                  losses: '1',
                  ot_losses: '0',
                  games_played: '4',
                },
                {
                  team_code: 'NY',
                  wins: '1',
                  losses: '2',
                  ot_losses: '1',
                  games_played: '4',
                },
              ],
            },
          }),
        } as any;
      }
      return {
        json: async () => ({
          SiteKit: {
            Schedule: [
              // Schedule replay would give MTL 1-0-0 here — standings win.
              game({
                date_played: '2026-10-04',
                GameDateISO8601: '2026-10-04T00:00:00',
                home_team_code: 'MTL',
                visiting_team_code: 'NY',
                home_goal_count: '2',
                visiting_goal_count: '1',
              }),
            ],
          },
        }),
      } as any;
    }) as any;

    const scores = await hockeyData.getPWHLScores('2026-10-04');

    expect(scores).toHaveLength(1);
    expect(scores[0].homeTeamRecord).toBe('3-1-0');
    expect(scores[0].awayTeamRecord).toBe('1-2-1');
  });

  it('reads a single schedule when the day already belongs to the record season', async () => {
    mockFeed(SEASONS, { '8': [game({ date_played: '2026-04-11' })] });

    await hockeyData.getPWHLScores('2026-04-11');

    expect(requestedSeasonIds()).toEqual(['8']);
  });

  it('falls back to the default feed when no season covers the date', async () => {
    mockFeed(SEASONS, { default: [] });

    await hockeyData.getPWHLScores('1999-01-05');

    expect(requestedSeasonIds()).toEqual([null]);
  });

  it('returns an empty list when the date has no games', async () => {
    mockFeed(SEASONS, { '5': [game()] });

    await expect(hockeyData.getPWHLScores('2025-02-16')).resolves.toEqual([]);
  });
});

/**
 * `getPWHLStandings()` used to pick the regular season with
 * `[...seasons].reverse().find(...)`. The feed lists seasons **most recent
 * first**, so reversing walked them oldest-first and landed on the 2024
 * inaugural regular season (24 games) — every PWHL team record was a two-year-old
 * tally.
 */
describe('HockeyData.getPWHLStandings — season resolution', () => {
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
      season_id: '8',
      season_name: '2025-26 Regular Season',
      start_date: '2025-11-21',
      end_date: '2026-04-27',
    },
    {
      season_id: '5',
      season_name: '2024-25 Regular Season',
      start_date: '2024-11-25',
      end_date: '2025-05-05',
    },
    {
      season_id: '1',
      season_name: '2024 Regular Season',
      start_date: '2024-01-01',
      end_date: '2024-05-27',
    },
  ];

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reads the most recent regular season, not the oldest one', async () => {
    const requested: (string | null)[] = [];
    global.fetch = jest.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('season_id=')) {
        requested.push(new URL(u).searchParams.get('season_id'));
      }
      const body = u.includes('view=seasons')
        ? { SiteKit: { Seasons: SEASONS } }
        : {
            SiteKit: {
              Statviewtype: [
                {
                  team_code: 'MTL',
                  wins: '40',
                  losses: '30',
                  ot_losses: '12',
                  games_played: '82',
                },
              ],
            },
          };
      return { json: async () => body } as any;
    }) as any;

    const standings = await new HockeyData().getPWHLStandings();

    // 2025-26 Regular Season is the last one ended as of today; the previous
    // code asked for season 1 (2024).
    expect(requested).toEqual(['8']);
    expect(standings).toEqual({ MTL: '40-30-12' });
  });
});
