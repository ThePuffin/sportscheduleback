import {
  applySeasonFinalRecords,
  extractCompetitorRecord,
  fetchJsonOrNull,
  getOlympicSeasonTeams,
  getSeasonFinals,
  getTeamsSchedule,
  resolveScheduleGameStatus,
} from './espnAllData';

describe('getSeasonFinals', () => {
  const game = (id, home, away, homeRecord, awayRecord) => ({
    uniqueId: id,
    startTimeUTC: '2025-04-15T23:00:00.000Z',
    homeTeamId: home,
    awayTeamId: away,
    homeTeamRecord: homeRecord,
    awayTeamRecord: awayRecord,
  });

  it('verifies a tally that accounts for every fetched game', () => {
    // BOS played 2 games here and its final tally says 2 games ("1-1-0").
    const { verified, truncated } = getSeasonFinals([
      game('g1', 'NHL-BOS', 'NHL-TOR', '1-0-0', '0-1-0'),
      game('g2', 'NHL-BOS', 'NHL-MTL', '1-1-0', '0-1-0'),
    ]);

    expect(verified.get('NHL-BOS')).toBe('1-1-0');
    expect(truncated).not.toContain('NHL-BOS');
  });

  it('rejects a tally implying more games than were fetched', () => {
    // Truncated fetch: only 1 game held, but the tally claims 82 — that is an
    // intermediate number, not the season final.
    const { verified, truncated } = getSeasonFinals([
      game('g1', 'NHL-BOS', 'NHL-TOR', '33-39-10', '42-32-7'),
    ]);

    expect(verified.has('NHL-BOS')).toBe(false);
    expect(verified.has('NHL-TOR')).toBe(false);
    expect(truncated).toEqual(expect.arrayContaining(['NHL-BOS', 'NHL-TOR']));
  });

  it('does not count the same match twice for a team', () => {
    // The same match is stored twice (one row per teamSelectedId): the tally
    // must still compare against 1 distinct game, not 2.
    const { verified, truncated } = getSeasonFinals([
      game('g1', 'NHL-BOS', 'NHL-TOR', '1-0-0', '0-1-0'),
      game('g1', 'NHL-BOS', 'NHL-TOR', '1-0-0', '0-1-0'),
    ]);

    expect(verified.get('NHL-BOS')).toBe('1-0-0');
    expect(truncated).not.toContain('NHL-BOS');
  });

  it('keeps the most complete tally per team', () => {
    // 3 games fetched for BOS, whose best tally covers exactly those 3 games.
    const { verified } = getSeasonFinals([
      game('g1', 'NHL-BOS', 'NHL-TOR', '1-0-0', '0-1-0'),
      game('g2', 'NHL-BOS', 'NHL-TOR', '2-0-0', '0-2-0'),
      game('g3', 'NHL-BOS', 'NHL-TOR', '2-1-0', '1-2-0'),
    ]);

    expect(verified.get('NHL-BOS')).toBe('2-1-0');
    expect(verified.get('NHL-TOR')).toBe('1-2-0');
  });
});

describe('resolveScheduleGameStatus', () => {
  it('maps the plain final statuses to FINISHED', () => {
    expect(resolveScheduleGameStatus('STATUS_FINAL')).toBe('FINISHED');
    expect(resolveScheduleGameStatus('STATUS_FULL_TIME')).toBe('FINISHED');
  });

  it('maps the suffixed final statuses to FINISHED', () => {
    // Regression: MLS 557514 (SEA 4-3 DAL) carries STATUS_FINAL_AET. The old
    // equality whitelist stored "FINAL AET", which no terminal-state check
    // recognized, so the fully played game was purged as "unresolved".
    expect(resolveScheduleGameStatus('STATUS_FINAL_AET')).toBe('FINISHED');
    expect(resolveScheduleGameStatus('STATUS_FINAL_PEN')).toBe('FINISHED');
    expect(resolveScheduleGameStatus('STATUS_FINAL_OT')).toBe('FINISHED');
    expect(resolveScheduleGameStatus('STATUS_FULL_TIME_2')).toBe('FINISHED');
  });

  it('is case insensitive', () => {
    expect(resolveScheduleGameStatus('status_final_aet')).toBe('FINISHED');
  });

  it('preserves postponement and cancellation', () => {
    expect(resolveScheduleGameStatus('STATUS_POSTPONED')).toBe('POSTPONED');
    expect(resolveScheduleGameStatus('STATUS_CANCELLED')).toBe('CANCELLED');
    expect(resolveScheduleGameStatus('STATUS_CANCELED')).toBe('CANCELLED');
  });

  it('maps a temporary interruption to DELAYED', () => {
    expect(resolveScheduleGameStatus('STATUS_DELAYED')).toBe('DELAYED');
    expect(resolveScheduleGameStatus('STATUS_SUSPENDED')).toBe('DELAYED');
  });

  it('keeps live statuses and readable unknown ones', () => {
    expect(resolveScheduleGameStatus('STATUS_IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(resolveScheduleGameStatus('STATUS_HALFTIME')).toBe('HALFTIME');
  });

  it('returns null when there is no status', () => {
    expect(resolveScheduleGameStatus(undefined)).toBeNull();
    expect(resolveScheduleGameStatus('')).toBeNull();
    expect(resolveScheduleGameStatus('2ND HALF')).toBeNull();
  });
});

describe('extractCompetitorRecord', () => {
  it('reads the singular `record` array of the team-schedule endpoint', () => {
    // teams/{id}/schedule?seasontype=2 -> competitor.record (singular) + displayValue
    expect(
      extractCompetitorRecord({
        record: [
          { type: 'ytd', displayValue: '33-39-10, 76 PTS' },
          { type: 'home', displayValue: '20-15-5' },
          { type: 'road', displayValue: '13-21-7' },
        ],
      }),
    ).toBe('33-39-10');
  });

  it('reads the plural `records` array of the scoreboard/summary endpoints', () => {
    expect(
      extractCompetitorRecord({
        records: [
          { type: 'home', summary: '19-13-6' },
          { type: 'total', summary: '47-20-15' },
          { type: 'road', summary: '11-23-3' },
        ],
      }),
    ).toBe('47-20-15');
  });

  it('falls back on `ytd` when ESPN sends no `total` entry (NHL scoreboard)', () => {
    // The NHL scoreboard only exposes ytd/home/road: the historical
    // `records.find(r => r.type === 'total')` lookup returned '' here.
    expect(
      extractCompetitorRecord({
        records: [
          { type: 'ytd', summary: '51-22-9' },
          { type: 'home', summary: '24-8-6' },
          { type: 'road', summary: '24-9-3' },
        ],
      }),
    ).toBe('51-22-9');
  });

  it('uses the first available entry when neither total nor ytd is present', () => {
    expect(
      extractCompetitorRecord({
        record: [{ type: 'home', displayValue: '10-4' }],
      }),
    ).toBe('10-4');
  });

  it('returns an empty string when ESPN sends no usable record', () => {
    expect(extractCompetitorRecord(undefined)).toBe('');
    expect(extractCompetitorRecord({})).toBe('');
    expect(extractCompetitorRecord({ record: [] })).toBe('');
    expect(extractCompetitorRecord({ records: null })).toBe('');
  });
});

describe('applySeasonFinalRecords', () => {
  const pastGame = (
    homeTeamId: string,
    awayTeamId: string,
    homeTeamRecord: string,
    awayTeamRecord: string,
    uniqueId?: string,
  ) => ({
    // Same start for every fixture: games are de-duplicated per team by identity,
    // so a test holding several BOS vs TOR matches must give them distinct ids.
    uniqueId: uniqueId ?? `${homeTeamId}-${awayTeamId}-${homeTeamRecord}`,
    startTimeUTC: '2025-04-15T23:00:00.000Z',
    homeTeamId,
    awayTeamId,
    homeTeamRecord,
    awayTeamRecord,
  });

  it('replaces the cumulative per-game tallies with the final season tally', () => {
    // Tallies must stay consistent with the number of games held for each team,
    // otherwise the batch is (correctly) treated as truncated.
    const allGames = {
      'NHL-BOS': [
        pastGame('NHL-BOS', 'NHL-TOR', '1-0-0', '0-1-0'), // pre-season
        pastGame('NHL-BOS', 'NHL-TOR', '1-1-0', '1-1-0'), // final (2 games)
      ],
      'NHL-TOR': [pastGame('NHL-TOR', 'NHL-BOS', '1-1-0', '1-1-0')],
    };

    applySeasonFinalRecords(allGames);

    const games = [...allGames['NHL-BOS'], ...allGames['NHL-TOR']];
    for (const game of games) {
      expect(game.homeTeamRecord).toBe(
        game.homeTeamId === 'NHL-BOS' ? '1-1-0' : '1-1-0',
      );
      expect(game.awayTeamRecord).toBe(
        game.awayTeamId === 'NHL-BOS' ? '1-1-0' : '1-1-0',
      );
    }
  });

  it('keeps the pre-season tally out of the final one (fewer games played)', () => {
    const allGames = {
      'NHL-BOS': [
        pastGame('NHL-BOS', 'NHL-TOR', '1-0-0', '0-1-0'), // 1 game
        pastGame('NHL-BOS', 'NHL-TOR', '1-1-0', '1-1-0'), // 2 games
      ],
    };

    applySeasonFinalRecords(allGames);

    expect(allGames['NHL-BOS'][0].homeTeamRecord).toBe('1-1-0');
    expect(allGames['NHL-BOS'][0].awayTeamRecord).toBe('1-1-0');
  });

  it('leaves the per-game tally untouched when the season is truncated', () => {
    // The tally claims 82 games but only 2 are held: the batch is incomplete, so
    // the intermediate number must NOT be frozen on the whole season.
    const allGames = {
      'NHL-BOS': [
        pastGame('NHL-BOS', 'NHL-TOR', '33-39-10', '42-32-7'),
        pastGame('NHL-BOS', 'NHL-TOR', '33-39-10', '42-32-7'),
      ],
    };

    applySeasonFinalRecords(allGames);

    expect(allGames['NHL-BOS'][0].homeTeamRecord).toBe('33-39-10');
    expect(allGames['NHL-BOS'][0].awayTeamRecord).toBe('42-32-7');
  });

  it('clears the records while the season is still running', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const allGames = {
      'NHL-BOS': [
        {
          ...pastGame('NHL-BOS', 'NHL-TOR', '5-2-0', '4-3-0'),
          startTimeUTC: future,
        },
      ],
    };

    applySeasonFinalRecords(allGames);

    // Cleared so that readers fall back on the up-to-date `team.record`.
    expect(allGames['NHL-BOS'][0].homeTeamRecord).toBe('');
    expect(allGames['NHL-BOS'][0].awayTeamRecord).toBe('');
  });

  it('clears every record as soon as one game of the season is still upcoming', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const allGames = {
      'NHL-BOS': [
        pastGame('NHL-BOS', 'NHL-TOR', '33-39-10', '42-32-7'),
        {
          ...pastGame('NHL-BOS', 'NHL-TOR', '0-0-0', '0-0-0'),
          startTimeUTC: future,
        },
      ],
    };

    applySeasonFinalRecords(allGames);

    expect(allGames['NHL-BOS'][0].homeTeamRecord).toBe('');
    expect(allGames['NHL-BOS'][0].awayTeamRecord).toBe('');
  });

  it('is a no-op when there is nothing to process', () => {
    expect(() => applySeasonFinalRecords({})).not.toThrow();
  });
});

describe('getTeamsSchedule (leagues with no ESPN schedule config)', () => {
  // Regression: `leaguesData[leagueName].fetchGames` threw
  // "Cannot read properties of undefined (reading 'fetchGames')" for any league
  // absent from `leagueConfigs` (the PWHL, unknown names). The TypeError was
  // swallowed by the catch, which returned `undefined`, and that then broke
  // the callers (`[...allGames, ...games]` and the `allGames[leagueID]` store)
  // with a second TypeError on `Array.map`.
  const team = {
    id: '1',
    abbrev: 'SEA',
    uniqueId: 'PWHL-SEA',
  };

  it('resolves with an empty list instead of throwing', async () => {
    await expect(getTeamsSchedule([team], 'PWHL', {}, true)).resolves.toEqual({
      'PWHL-SEA': [],
    });
  });

  it('never stores an undefined entry, whatever the league', async () => {
    const result = await getTeamsSchedule([team], 'NOT_A_LEAGUE', {}, true);
    for (const games of Object.values(result)) {
      expect(games).toEqual([]);
    }
  });
});

describe('getOlympicSeasonTeams', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('discovers separate hockey and basketball teams from that season scoreboard', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: {
            get: (name) =>
              name === 'content-type' ? 'application/json' : null,
          },
          json: async () => ({
            events: [
              {
                competitions: [
                  {
                    competitors: [
                      {
                        team: {
                          id: '2193',
                          abbreviation: 'CAN',
                          displayName: 'Canada',
                          logos: [],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        }) as Response,
    );

    const teams = await getOlympicSeasonTeams('OLYMPICS-MEN', 2021);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(teams.map(({ uniqueId }) => uniqueId)).toEqual(
      expect.arrayContaining([
        'OLYMPICS-HOCKEY-MEN-CAN',
        'OLYMPICS-BASKETBALL-MEN-CAN',
      ]),
    );
    expect(teams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: '2193',
          abbrev: 'CAN',
          league: 'OLYMPICS-MEN',
          isActive: false,
        }),
      ]),
    );
  });

  it('uses the valid ESPN basketball slugs (mens-/womens-olympics-basketball)', async () => {
    // Regression: the scoreboard slugs were `olympics-mens-basketball` /
    // `olympics-womens-basketball`, which ESPN answers with 400 Bad Request
    // ("Failed to get events endpoint"), so the whole oldies basketball crawl
    // returned nothing. The valid slugs swap the word order.
    // Return an empty scoreboard so the pagination loop ends after one call
    // per sub-league; we only assert on the URLs that were requested.
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => 'application/json' },
          json: async () => ({ events: [] }),
        }) as any,
    );

    await getOlympicSeasonTeams('OLYMPICS-MEN', 2024);
    await getOlympicSeasonTeams('OLYMPICS-WOMEN', 2024);

    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    const basketballUrls = urls.filter((u) => u.includes('/basketball/'));
    expect(basketballUrls.length).toBeGreaterThan(0);
    for (const url of basketballUrls) {
      // Every basketball scoreboard call must use a valid slug and never the
      // old, word-order-reversed ones that ESPN rejects with 400.
      expect(url).toMatch(
        /\/basketball\/(mens|womens)-olympics-basketball\/scoreboard/,
      );
      expect(url).not.toMatch(/olympics-(mens|womens)-basketball/);
    }
    expect(urls.some((u) => u.includes('/basketball/mens-olympics-basketball/'))).toBe(
      true,
    );
    expect(
      urls.some((u) => u.includes('/basketball/womens-olympics-basketball/')),
    ).toBe(true);
  });
});

describe('fetchJsonOrNull', () => {
  let fetchSpy;

  const jsonResponse = { events: [{ id: '1', date: '2026-01-01T00:00:00Z' }] };

  const jsonRes = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name) =>
        name === 'content-type' ? 'application/json; charset=UTF-8' : null,
    },
    json: () => Promise.resolve(jsonResponse),
  };

  // A retryable block: ESPN's Akamai edge returns an HTML "Access Denied" page
  // with either 403 (bot-block) or 429 (explicit rate-limit).
  const blocked = (status, retryAfter = null) => ({
    ok: false,
    status,
    statusText: status === 403 ? 'Forbidden' : 'Too Many Requests',
    headers: {
      get: (name) =>
        name === 'content-type'
          ? 'text/html'
          : name === 'retry-after'
            ? retryAfter
            : null,
    },
    text: () => Promise.resolve('<HTML><HEAD><TITLE>Access Denied</TITLE>'),
  });

  // fetchJsonOrNull backs off with real setTimeout between retries. Drive fake
  // timers so those waits fire instantly (flushing microtasks in between) until
  // the promise settles, instead of sleeping for the actual backoff duration.
  const settle = async (promise) => {
    let done = false;
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 200 && !done; i++) {
      await jest.advanceTimersByTimeAsync(1000);
    }
    return promise;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(null)));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    fetchSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('returns parsed JSON for a 2xx response with a JSON content-type', async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes);

    const result = await settle(
      fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=2'),
    );

    expect(result).toBe(jsonResponse);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fails open (null) without retrying on a genuine non-retryable error (404)', async () => {
    fetchSpy.mockResolvedValueOnce(blocked(404));

    const result = await settle(
      fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=1'),
    );

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 403 bot-block and returns JSON once it lifts', async () => {
    fetchSpy.mockResolvedValueOnce(blocked(403)).mockResolvedValueOnce(jsonRes);

    const result = await settle(
      fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=2'),
    );

    expect(result).toBe(jsonResponse);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries a transient 429 rate-limit and returns JSON once it lifts', async () => {
    fetchSpy
      .mockResolvedValueOnce(blocked(429, '0'))
      .mockResolvedValueOnce(jsonRes);

    const result = await settle(
      fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=2'),
    );

    expect(result).toBe(jsonResponse);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('gives up (null) after exhausting retries on a persistent 403', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(blocked(403)));

    const result = await settle(
      fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=2'),
    );

    expect(result).toBeNull();
    // 1 initial call + ESPN_MAX_RETRIES (2) retries.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('throttles the skip warning instead of logging one line per blocked URL', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(blocked(403)));
    const warnSpy = console.warn as jest.Mock;

    for (let i = 0; i < 30; i++) {
      await settle(
        fetchJsonOrNull(`https://site.api.espn.com/teams/${i}/schedule?seasontype=2`),
      );
    }

    // The module-level skip counter means we can't assert an exact number here,
    // but any window of 30 consecutive skips contains at most one "first" log
    // plus the multiples of 25 (at most two) — never one line per URL.
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('throws after exhausting retries on a network-level failure', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error('network down')));

    await expect(
      settle(
        fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=2'),
      ),
    ).rejects.toThrow('network down');
    // fetchWithRetry itself retries once (2 calls); the throw propagates.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
