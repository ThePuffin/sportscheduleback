import {
  applySeasonFinalRecords,
  extractCompetitorRecord,
  fetchESPNTeamScheduleEvents,
  fetchJsonOrNull,
  getESPNTeamLogo,
  getOlympicTeamLogo,
  getOlympicSeasonTeams,
  getRecordSeasonType,
  getSeasonFinals,
  getTeamsSchedule,
  isD1Groups,
  isD1ScheduleTeam,
  resetESPNDivisionCachesForTests,
  NCAAMH_D1_TEAMS,
  NCAAWH_D1_TEAM_IDS,
  resolveScheduleGameStatus,
} from './espnAllData';

describe('getESPNTeamLogo', () => {
  const logo = (href: string, rel: string[]) => ({
    href,
    rel,
    alt: '',
    width: 500,
    height: 500,
  });

  it('preserves the existing ESPN logo preference order', () => {
    expect(
      getESPNTeamLogo({
        logo: 'singular-logo.png',
        logos: [
          logo('first-logo.png', ['default']),
          logo('second-logo.png', ['full']),
          logo('third-logo.png', ['primary_logo_on_white_color']),
        ],
      }),
    ).toBe('third-logo.png');
  });

  it('falls back to known ESPN logo relations when the original indexes are absent', () => {
    expect(
      getESPNTeamLogo({
        logos: [
          logo('', ['default']),
          logo('scoreboard-logo.png', ['full', 'scoreboard']),
        ],
      }),
    ).toBe('scoreboard-logo.png');
  });

  it('uses any remaining ESPN logo href when no known relation is present', () => {
    expect(
      getESPNTeamLogo({
        logos: [logo('alternate-logo.png', ['alternate'])],
      }),
    ).toBe('alternate-logo.png');
  });

  it('allows a caller-specific ESPN relation to take precedence', () => {
    expect(
      getESPNTeamLogo(
        {
          logo: 'singular-logo.png',
          logos: [
            logo('indexed-logo.png', ['default']),
            logo('preferred-logo.png', ['full', 'scoreboard']),
          ],
        },
        [['full', 'scoreboard']],
      ),
    ).toBe('preferred-logo.png');
  });

  it('returns undefined when ESPN provides no usable URL', () => {
    expect(getESPNTeamLogo({ logos: [] })).toBeUndefined();
    expect(getESPNTeamLogo(undefined)).toBeUndefined();
  });
});

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

describe('getRecordSeasonType', () => {
  it('normalizes ESPN phase ids and labels', () => {
    expect(getRecordSeasonType({ recordSeasonType: 1 })).toBe(1);
    expect(getRecordSeasonType({ seasonType: { id: '3', name: 'Postseason' } })).toBe(3);
    expect(getRecordSeasonType({ season: { type: { type: 'regular' } } })).toBe(2);
  });
});

describe('applySeasonFinalRecords', () => {
  const pastGame = (
    homeTeamId: string,
    awayTeamId: string,
    homeTeamRecord: string,
    awayTeamRecord: string,
    uniqueId?: string,
    recordSeasonType = 2,
  ) => ({
    // Same start for every fixture: games are de-duplicated per team by identity,
    // so a test holding several BOS vs TOR matches must give them distinct ids.
    uniqueId: uniqueId ?? `${homeTeamId}-${awayTeamId}-${homeTeamRecord}`,
    startTimeUTC: '2025-04-15T23:00:00.000Z',
    homeTeamId,
    awayTeamId,
    homeTeamRecord,
    awayTeamRecord,
    recordSeasonType,
  });

  it('keeps preseason and regular-season final records separate', () => {
    // Tallies must stay consistent with the number of games held for each team,
    // otherwise the batch is (correctly) treated as truncated.
    const allGames = {
      'NHL-BOS': [
        pastGame('NHL-BOS', 'NHL-TOR', '1-0-0', '0-1-0', 'pre-1', 1),
        pastGame('NHL-BOS', 'NHL-TOR', '1-1-0', '1-1-0', 'reg-1', 2),
      ],
      'NHL-TOR': [
        pastGame('NHL-TOR', 'NHL-BOS', '1-1-0', '1-1-0', 'reg-1', 2),
      ],
    };

    applySeasonFinalRecords(allGames);

    expect(allGames['NHL-BOS'][0].homeTeamRecord).toBe('1-0-0');
    expect(allGames['NHL-BOS'][0].awayTeamRecord).toBe('0-1-0');
    expect(allGames['NHL-BOS'][1].homeTeamRecord).toBe('1-1-0');
    expect(allGames['NHL-BOS'][1].awayTeamRecord).toBe('1-1-0');
  });

  it('does not copy the last regular-season tally to preseason games', () => {
    const allGames = {
      'NHL-BOS': [
        pastGame('NHL-BOS', 'NHL-TOR', '1-0-0', '0-1-0', 'pre-1', 1),
        pastGame('NHL-BOS', 'NHL-TOR', '1-1-0', '1-1-0', 'reg-1', 2),
      ],
    };

    applySeasonFinalRecords(allGames);

    expect(allGames['NHL-BOS'][0].homeTeamRecord).toBe('1-0-0');
    expect(allGames['NHL-BOS'][0].awayTeamRecord).toBe('0-1-0');
    expect(allGames['NHL-BOS'][1].homeTeamRecord).toBe('1-1-0');
    expect(allGames['NHL-BOS'][1].awayTeamRecord).toBe('1-1-0');
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

  it('keeps phase-specific records for a played game while that phase is in progress', () => {
    const allGames = {
      'NHL-BOS': [pastGame('NHL-BOS', 'NHL-TOR', '5-2-0', '4-3-0')],
      'NHL-TOR': [pastGame('NHL-TOR', 'NHL-BOS', '4-3-0', '5-2-0')],
    };

    applySeasonFinalRecords(allGames);

    expect(allGames['NHL-BOS'][0].homeTeamRecord).toBe('5-2-0');
    expect(allGames['NHL-BOS'][0].awayTeamRecord).toBe('4-3-0');
  });

  it('clears the per-game record of an upcoming game so the reader uses team.record', () => {
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

    // An unstarted game has no pre-game tally: the empty record makes
    // `_enrichGameWithTeamData()` fall back to the team's current `team.record`.
    expect(allGames['NHL-BOS'][0].homeTeamRecord).toBe('');
    expect(allGames['NHL-BOS'][0].awayTeamRecord).toBe('');
  });

  it('keeps playoff match records distinct as a series progresses', () => {
    const allGames: Record<string, any[]> = {
      'NFL-CHI': [
        {
          ...pastGame('NFL-CHI', 'NFL-DET', '1-0-0', '0-1-0', 'playoff-1', 3),
          seriesSummary: 'CHI leads 2-0',
        },
        pastGame('NFL-CHI', 'NFL-DET', '2-0-0', '0-2-0', 'playoff-2', 3),
      ],
      'NFL-SF': [
        pastGame('NFL-SF', 'NFL-LA', '1-0-0', '0-1-0', 'single-playoff', 3),
      ],
    };

    applySeasonFinalRecords(allGames);

    expect(allGames['NFL-CHI'][0].homeTeamRecord).toBe('1-0-0');
    expect(allGames['NFL-CHI'][0].awayTeamRecord).toBe('0-1-0');
    expect(allGames['NFL-CHI'][0].seriesSummary).toBe('CHI leads 2-0');
    expect(allGames['NFL-CHI'][1].homeTeamRecord).toBe('2-0-0');
    expect(allGames['NFL-CHI'][1].awayTeamRecord).toBe('0-2-0');
    expect(allGames['NFL-SF'][0].homeTeamRecord).toBe('1-0-0');
  });

  it('keeps an unstarted past phase at zero but clears an unstarted upcoming phase', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const allGames = {
      'NHL-BOS': [
        pastGame('NHL-BOS', 'NHL-TOR', '33-39-10', '42-32-7', 'regular', 2),
        {
          ...pastGame('NHL-BOS', 'NHL-TOR', '0-0-0', '0-0-0', 'pre', 1),
          startTimeUTC: future,
        },
      ],
    };

    applySeasonFinalRecords(allGames);

    // Played regular season keeps its verified tally.
    expect(allGames['NHL-BOS'][0].homeTeamRecord).toBe('33-39-10');
    expect(allGames['NHL-BOS'][0].awayTeamRecord).toBe('42-32-7');
    // An upcoming preseason game falls back to the team's current record.
    expect(allGames['NHL-BOS'][1].homeTeamRecord).toBe('');
    expect(allGames['NHL-BOS'][1].awayTeamRecord).toBe('');
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

describe('getOlympicTeamLogo', () => {
  it.each([
    ['OLYMPICS-MEN', 'KOR-W', 'kor'],
    ['OLYMPICS-WOMEN', 'KOR-W', 'kor'],
    ['OLYMPICS-MEN', 'CHN-M', 'chn'],
    ['OLYMPICS-WOMEN', 'CHN-W', 'chn'],
    ['OLYMPICS-WOMEN', 'ROC-W', 'roc'],
  ])('resolves %s team code %s to its ESPN flag', (league, abbrev, code) => {
    expect(getOlympicTeamLogo(league, abbrev)).toBe(
      `https://a.espncdn.com/i/teamlogos/countries/500/${code}.png`,
    );
  });

  it('does not apply country-flag fallbacks outside Olympic leagues', () => {
    expect(getOlympicTeamLogo('NHL', 'KOR')).toBe('');
    expect(getOlympicTeamLogo('OLYMPICS-MEN', 'UNKNOWN')).toBe('');
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

describe('fetchESPNTeamScheduleEvents pagination', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const response = (payload) =>
    new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    });

  it('fetches every page reported by ESPN and deduplicates overlapping events', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async (input) => {
        const url = new URL(String(input));
        const page = Number(url.searchParams.get('page'));
        return page === 1
          ? response({
              pageIndex: 0,
              pageCount: 2,
              events: [{ id: 'game-1' }, { id: 'game-2' }],
            })
          : response({
              pageIndex: 1,
              pageCount: 2,
              events: [{ id: 'game-2' }, { id: 'game-3' }],
            });
      },
    );

    const events = await fetchESPNTeamScheduleEvents(
      'https://site.api.espn.com/teams/302/schedule?seasontype=2&season=2025',
    );

    expect(events.map(({ id }) => id)).toEqual([
      'game-1',
      'game-2',
      'game-3',
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(
      fetchSpy.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('page')),
    ).toEqual(['1', '2']);
    expect(
      fetchSpy.mock.calls.every(
        ([input]) => new URL(String(input)).searchParams.get('limit') === '1000',
      ),
    ).toBe(true);
  });

  it('does not request another page when the schedule fits in one response', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(response({ events: [{ id: 'game-1' }] }));

    await expect(
      fetchESPNTeamScheduleEvents(
        'https://site.api.espn.com/teams/302/schedule?seasontype=2',
      ),
    ).resolves.toEqual([{ id: 'game-1' }]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly when ESPN advertises another page but returns no new events', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () =>
      response({
        hasNext: true,
        events: [{ id: 'game-1' }],
      }),
    );

    await expect(
      fetchESPNTeamScheduleEvents(
        'https://site.api.espn.com/teams/302/schedule?seasontype=2',
      ),
    ).rejects.toThrow('pagination made no progress');
  });
});

/**
 * D1 filtering regression.
 *
 * For every college league except men's hockey, ESPN's `groups.parent.id` is a
 * reliable D1 marker, so `isD1Groups()` keeps a team when its group parent id
 * is one of the D1 parents and drops it otherwise (never on a missing group —
 * a transient fetch failure must not drop a team).
 *
 * Men's college hockey (NCAAMH) is the exception: ESPN reports `parent.id = 51`
 * for D1, D3 and Canadian U Sports programs alike, and `isConference` is true
 * for several non-D1 programs too, so neither marker can be trusted. NCAAMH is
 * therefore filtered by the explicit `NCAAMH_D1_TEAMS` allowlist.
 */
describe('isD1Groups', () => {
  describe('parent-id leagues (NCAAF/NCAAB/WNCAAB/NCCABB)', () => {
    it('keeps a D1 team (NCAAB parent 50)', () => {
      expect(
        isD1Groups('NCAAB', { id: '100', parent: { id: '50' } }, 'DUKE'),
      ).toBe(true);
    });

    it('drops a non-D1 team (NCAAB under a non-50 parent)', () => {
      expect(
        isD1Groups('NCAAB', { id: '99', parent: { id: '49' } }, 'D3TEAM'),
      ).toBe(false);
    });

    it('keeps FBS and FCS football (parents 80/81)', () => {
      expect(isD1Groups('NCAAF', { id: '1', parent: { id: '80' } }, 'ALA')).toBe(true);
      expect(isD1Groups('NCAAF', { id: '1', parent: { id: '81' } }, 'NDSU')).toBe(true);
      expect(isD1Groups('NCAAF', { id: '1', parent: { id: '35' } }, 'D3')).toBe(false);
    });

    it('keeps a team with no groups info (transient fetch failure)', () => {
      expect(isD1Groups('NCAAB', undefined, 'DUKE')).toBe(true);
    });

    it('keeps Division I NCAAWH teams and drops D2/D3 teams by ESPN id', () => {
      expect(NCAAWH_D1_TEAM_IDS.size).toBe(41);
      expect(isD1Groups('NCAAWH', undefined, undefined, '103')).toBe(true);
      expect(isD1Groups('NCAAWH', undefined, undefined, '127962')).toBe(false);
      expect(isD1Groups('NCAAWH', undefined, undefined, '121934')).toBe(false);
    });
  });

  describe('men\u2019s college hockey (NCAAMH) allowlist', () => {
    it('keeps a D1 program even though ESPN reports parent.id 51 for it', () => {
      // Adrian/Middlebury-style D3 teams also report parent 51, so the marker
      // alone is not enough: the allowlist is what decides.
      expect(
        isD1Groups('NCAAMH', { id: '58', parent: { id: '51' } }, 'MIDB'),
      ).toBe(false);
      expect(
        isD1Groups('NCAAMH', { id: '62', parent: { id: '51' } }, 'MICH'),
      ).toBe(true);
    });

    it('drops known non-D1 programs (D3 / U Sports)', () => {
      for (const ab of ['ADR', 'CORTLAND', 'LAUREN', 'TRNE', 'WORC', 'UWEC']) {
        expect(NCAAMH_D1_TEAMS.has(ab)).toBe(false);
        expect(
          isD1Groups('NCAAMH', { id: '58', parent: { id: '51' } }, ab),
        ).toBe(false);
      }
    });

    it('keeps known D1 programs across every conference + independents', () => {
      for (const ab of [
        'MICH', // Big Ten
        'DEN', // NCHC
        'BC', // Hockey East
        'QUIN', // ECAC
        'MNST', // CCHA
        'RIT', // Atlantic Hockey
        'UAA', // Independent
      ]) {
        expect(NCAAMH_D1_TEAMS.has(ab)).toBe(true);
      }
    });

    it('contains exactly the 64 D1 programs', () => {
      expect(NCAAMH_D1_TEAMS.size).toBe(64);
    });

    it('keeps a team with no groups info (transient fetch failure)', () => {
      expect(isD1Groups('NCAAMH', undefined, 'MICH')).toBe(true);
      expect(isD1Groups('NCAAMH', undefined, undefined)).toBe(true);
    });
  });

  describe('getTeamsSchedule Division I filtering', () => {
    beforeEach(() => {
      // The division / roster verdicts live in module-level caches shared by
      // the whole suite: reset them so each test starts from a known state.
      resetESPNDivisionCachesForTests();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('only requests schedules for verified D1 teams', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        async (input) => {
          const url = String(input);
          const isSchedule = url.includes('/schedule?');
          // Group-hierarchy lookup (core API): group 200 is a non-D1 root, so
          // the walk from the D2 team's `groups.id` proves it non-D1.
          if (url.includes('/groups/')) {
            return new Response(
              JSON.stringify({ id: '200', name: 'Non-D1 Conference' }),
              { headers: { 'content-type': 'application/json' } },
            );
          }
          const teamId = url.match(/\/teams\/(\d+)/)?.[1];
          const payload = isSchedule
            ? { events: [] }
            : {
                team: {
                  groups: {
                    id: teamId === '99001' ? '100' : '200',
                    parent: { id: teamId === '99001' ? '50' : '49' },
                  },
                },
              };

          return new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json' },
          });
        },
      );

      const result = await getTeamsSchedule(
        [
          {
            id: '99001',
            abbrev: 'D1',
            uniqueId: 'NCAAB-D1',
            label: 'D1 University',
          },
          {
            id: '99002',
            abbrev: 'D2',
            uniqueId: 'NCAAB-D2',
            label: 'D2 University',
          },
        ],
        'NCAAB',
        {},
        true,
      );

      expect(result['NCAAB-D1']).toEqual([]);
      expect(result['NCAAB-D2']).toEqual([]);
      expect(
        fetchSpy.mock.calls.filter(([url]) => String(url).includes('/schedule?')),
      ).toHaveLength(3);
    });

    it('fails the league fetch instead of accepting an invalid schedule payload', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        async (input) => {
          const url = String(input);
          const payload = url.includes('/schedule?')
            ? { unexpected: [] }
            : { team: { groups: { parent: { id: '50' } } } };
          return new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json' },
          });
        },
      );

      await expect(
        getTeamsSchedule(
          [
            {
              id: '99003',
              abbrev: 'D1',
              uniqueId: 'NCAAB-INCOMPLETE',
              label: 'D1 University',
            },
          ],
          'NCAAB',
          {},
          true,
        ),
      ).rejects.toThrow('refusing to return a partial league schedule');

      expect(
        fetchSpy.mock.calls.filter(([url]) => String(url).includes('/schedule?')),
      ).toHaveLength(1);
    });

    it('keeps a game whose only D1 side is the crawled team (opponent unknown to both ESPN sources)', async () => {
      // A fixture belongs to a Division 1 program's schedule as soon as ONE
      // side is D1, so a D1 team's game against a lower division (here an
      // opponent ESPN's detail endpoint answers 404 for and the league roster
      // does not list either) is now SAVED instead of dropped. The league
      // refresh still completes: one unverifiable opponent never aborts it.
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      jest.spyOn(console, 'info').mockImplementation(() => undefined);
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/teams/99201/schedule?')) {
          const hasGame = url.includes('seasontype=2');
          return new Response(
            JSON.stringify({
              events: hasGame
                ? [
                    {
                      date: futureDate,
                      id: '99200',
                      competitions: [
                        {
                          competitors: [
                            {
                              homeAway: 'home',
                              team: {
                                id: '99201',
                                abbreviation: 'D1',
                                displayName: 'D1 University',
                              },
                            },
                            {
                              homeAway: 'away',
                              team: {
                                id: '99202',
                                abbreviation: 'SFA',
                                displayName: 'Unknown Opponent',
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ]
                : [],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/teams?limit=1000')) {
          // League roster: a valid payload that simply does not list 99202.
          return new Response(
            JSON.stringify({ sports: [{ leagues: [{ teams: [] }] }] }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/teams/99202')) {
          // ESPN's detail endpoint answers 404 for ids it does not know.
          return new Response(JSON.stringify({ code: 404 }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            team: { groups: { id: '100', parent: { id: '50' } } },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });

      const result = await getTeamsSchedule(
        [
          {
            id: '99201',
            abbrev: 'D1',
            uniqueId: 'NCAAB-404OPP',
            label: 'D1 University',
          },
        ],
        'NCAAB',
        {},
        false,
      );

      // The league refresh completes (no "refusing partial schedule") and the
      // D1 side is enough: the fixture against the opponent unknown to both
      // ESPN sources is saved, and no exclusion is reported for it.
      expect(result['NCAAB-404OPP']).toHaveLength(1);
      expect(result['NCAAB-404OPP'][0].awayTeamId).toBe('NCAAB-SFA');
      expect(console.info).not.toHaveBeenCalledWith(
        expect.stringContaining('excluded 1 distinct game(s)'),
      );
    });

    it('keeps an opponent that the league roster verifies as D1 (detail 404)', async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/teams/99211/schedule?')) {
          const hasGame = url.includes('seasontype=2');
          return new Response(
            JSON.stringify({
              events: hasGame
                ? [
                    {
                      date: futureDate,
                      id: '99210',
                      competitions: [
                        {
                          competitors: [
                            {
                              homeAway: 'home',
                              team: {
                                id: '99211',
                                abbreviation: 'D1',
                                displayName: 'D1 University',
                              },
                            },
                            {
                              homeAway: 'away',
                              team: {
                                id: '99212',
                                abbreviation: 'FCS',
                                displayName: 'Recent Program',
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ]
                : [],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/teams?limit=1000')) {
          // League roster verifies BOTH ids as D1 (FBS/FCS parents).
          return new Response(
            JSON.stringify({
              sports: [
                {
                  leagues: [
                    {
                      teams: [
                        {
                          team: {
                            id: '99211',
                            groups: { id: '1', parent: { id: '80' } },
                          },
                        },
                        {
                          team: {
                            id: '99212',
                            groups: { id: '2', parent: { id: '81' } },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        // Detail endpoint: 404 for the opponent, D1 payload otherwise.
        if (url.includes('/teams/99212')) {
          return new Response(JSON.stringify({ code: 404 }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            team: { groups: { id: '1', parent: { id: '80' } } },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });

      const result = await getTeamsSchedule(
        [
          {
            id: '99211',
            abbrev: 'D1',
            uniqueId: 'NCAAF-ROSTERD1',
            label: 'D1 University',
          },
        ],
        'NCAAF',
        {},
        false,
      );

      // The game survives: the roster proves the opponent a D1 (FCS) program
      // even though the per-team detail endpoint does not know it.
      expect(result['NCAAF-ROSTERD1']).toHaveLength(1);
      expect(result['NCAAF-ROSTERD1'][0].awayTeamId).toBe('NCAAF-FCS');
    });

    it('keeps a D1-vs-non-D1 game and still reports malformed events separately', async () => {
      // One D1 side is enough: the FBS program's game against the provably D3
      // opponent (parent 35) is saved, because it belongs to a D1 schedule.
      // The malformed event (empty competitors) is skipped and logged apart.
      jest.spyOn(console, 'info').mockImplementation(() => undefined);
      const warnSpy = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/teams/99301/schedule?')) {
          const hasGame = url.includes('seasontype=2');
          return new Response(
            JSON.stringify({
              events: hasGame
                ? [
                    {
                      date: futureDate,
                      id: '99300',
                      competitions: [
                        {
                          competitors: [
                            {
                              homeAway: 'home',
                              team: {
                                id: '99301',
                                abbreviation: 'D1',
                                displayName: 'D1 University',
                              },
                            },
                            {
                              homeAway: 'away',
                              team: {
                                id: '99302',
                                abbreviation: 'D3',
                                displayName: 'D3 University',
                              },
                            },
                          ],
                        },
                      ],
                    },
                    {
                      date: futureDate,
                      id: '99302',
                      competitions: [{ competitors: [] }],
                    },
                  ]
                : [],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        const teamId = url.match(/\/teams\/(\d+)$/)?.[1];
        // Roster team is FBS; the opponent is provably D3 (parent 35).
        return new Response(
          JSON.stringify({
            team: {
              groups: { id: '1', parent: { id: teamId === '99302' ? '35' : '80' } },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });

      const result = await getTeamsSchedule(
        [
          {
            id: '99301',
            abbrev: 'D1',
            uniqueId: 'NCAAF-D3OPP',
            label: 'D1 University',
          },
        ],
        'NCAAF',
        {},
        false,
      );

      // The D1-vs-D3 game is saved, and no exclusion is reported for it.
      expect(result['NCAAF-D3OPP']).toHaveLength(1);
      expect(result['NCAAF-D3OPP'][0].awayTeamId).toBe('NCAAF-D3');
      expect(console.info).not.toHaveBeenCalledWith(
        expect.stringContaining('excluded 1 distinct game(s)'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '[Schedule] NCAAF: skipped 1 game occurrence(s) with invalid or missing competitor data across 1 team schedule(s).',
      );
    });

    it('excludes a game where NEITHER side is D1', async () => {
      // Safety net of the per-game filter: a fixture between two provably
      // non-D1 programs is dropped even though it surfaced while crawling a
      // team the pre-filter had to keep fail-open (ESPN was unreachable at
      // that moment, so no verdict was cached and no schedule was skipped).
      jest.spyOn(console, 'info').mockImplementation(() => undefined);
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const futureDate = new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString();
      const homeDetailCalls = { count: 0 };
      jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/teams/99401/schedule?')) {
          const hasGame = url.includes('seasontype=2');
          return new Response(
            JSON.stringify({
              events: hasGame
                ? [
                    {
                      date: futureDate,
                      id: '99400',
                      competitions: [
                        {
                          competitors: [
                            {
                              homeAway: 'home',
                              team: {
                                id: '99401',
                                abbreviation: 'NON1',
                                displayName: 'Non D1 Home',
                              },
                            },
                            {
                              homeAway: 'away',
                              team: {
                                id: '99402',
                                abbreviation: 'NON2',
                                displayName: 'Non D1 Away',
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ]
                : [],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        // The league roster stays unreachable for the whole run, so the
        // pre-filter keeps the home team fail-open (nothing cached).
        if (url.includes('/teams?limit=1000')) {
          return new Response(JSON.stringify({ code: 500 }), { status: 500 });
        }
        // Group-hierarchy lookups: group 1 sits under non-D1 root 49, so both
        // sides walk to a root that is not `50` → provably non-D1.
        if (url.includes('/groups/1')) {
          return new Response(
            JSON.stringify({
              id: '1',
              name: 'Some Conference',
              parent: {
                $ref: 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/seasons/2026/types/2/groups/49',
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/groups/49')) {
          return new Response(
            JSON.stringify({ id: '49', name: 'Non-D1 Division' }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        const teamId = url.match(/\/teams\/(\d+)$/)?.[1];
        if (teamId === '99401') {
          // First lookup (pre-filter): ESPN is down → fail-open. Later
          // lookups (per-game filter): ESPN answers, proving D3 (parent 35).
          homeDetailCalls.count++;
          if (homeDetailCalls.count === 1) {
            return new Response(JSON.stringify({ code: 500 }), {
              status: 500,
            });
          }
          return new Response(
            JSON.stringify({
              team: { groups: { id: '1', parent: { id: '35' } } },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        // The opponent is provably non-D1 (parent 49).
        return new Response(
          JSON.stringify({
            team: { groups: { id: '1', parent: { id: '49' } } },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });

      const result = await getTeamsSchedule(
        [
          {
            id: '99401',
            abbrev: 'NON1',
            uniqueId: 'NCAAB-NOND1BOTH',
            label: 'Non D1 Home',
          },
        ],
        'NCAAB',
        {},
        false,
      );

      expect(result['NCAAB-NOND1BOTH']).toHaveLength(0);
      expect(console.info).toHaveBeenCalledWith(
        '[Schedule] NCAAB: excluded 1 distinct game(s) with no participant verified as D1 across 1 team schedule(s); opponents: Non D1 Away [99402] (1), Non D1 Home [99401] (1).',
      );
    });

    it('applies the same per-game rule on the oldies (season) path', async () => {
      // The per-game filter sits after the date cutoff and is independent of
      // `season`, so historical recovery (`getLeagueGames({ season })`) follows
      // the same rule as the live refresh: a past D1-vs-D3 fixture of a
      // followed program is inserted, not dropped.
      jest.spyOn(console, 'info').mockImplementation(() => undefined);
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const pastDate = new Date('2024-02-10T19:00:00.000Z').toISOString();
      jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/teams/99511/schedule?')) {
          const hasGame = url.includes('seasontype=2');
          return new Response(
            JSON.stringify({
              events: hasGame
                ? [
                    {
                      date: pastDate,
                      id: '99510',
                      competitions: [
                        {
                          competitors: [
                            {
                              homeAway: 'home',
                              team: {
                                id: '99511',
                                abbreviation: 'D1',
                                displayName: 'D1 University',
                              },
                            },
                            {
                              homeAway: 'away',
                              team: {
                                id: '99512',
                                abbreviation: 'D3',
                                displayName: 'D3 University',
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ]
                : [],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        const teamId = url.match(/\/teams\/(\d+)$/)?.[1];
        return new Response(
          JSON.stringify({
            team: {
              groups: {
                id: '1',
                parent: { id: teamId === '99512' ? '35' : '80' },
              },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });

      // `season` + `forceUpdate` is exactly how the oldies crawl calls it.
      const result = await getTeamsSchedule(
        [
          {
            id: '99511',
            abbrev: 'D1',
            uniqueId: 'NCAAF-OLDIESD3',
            label: 'D1 University',
          },
        ],
        'NCAAF',
        {},
        true,
        2024,
      );

      expect(result['NCAAF-OLDIESD3']).toHaveLength(1);
      expect(result['NCAAF-OLDIESD3'][0].awayTeamId).toBe('NCAAF-D3');
      expect(console.info).not.toHaveBeenCalledWith(
        expect.stringContaining('excluded 1 distinct game(s)'),
      );
    });

    it('keeps every game of a college hockey league whose division ESPN cannot verify', async () => {
      // NCAAMH has no usable ESPN division marker: the per-game D1 filter is
      // skipped, so a game against an opponent the `NCAAMH_D1_TEAMS` allowlist
      // does not know is kept. Only the allowlist decides which teams are
      // crawled (MICH is listed, so its schedule is requested).
      jest.spyOn(console, 'info').mockImplementation(() => undefined);
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const futureDate = new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString();
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/teams/130/schedule?')) {
            const hasGame = url.includes('seasontype=2');
            return new Response(
              JSON.stringify({
                events: hasGame
                  ? [
                      {
                        date: futureDate,
                        id: '99600',
                        competitions: [
                          {
                            competitors: [
                              {
                                homeAway: 'home',
                                team: {
                                  id: '130',
                                  abbreviation: 'MICH',
                                  displayName: 'Michigan Wolverines',
                                },
                              },
                              {
                                homeAway: 'away',
                                team: {
                                  id: '2399',
                                  abbreviation: 'MIDB',
                                  displayName: 'Middlebury Panthers',
                                },
                              },
                            ],
                          },
                        ],
                      },
                    ]
                  : [],
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        });

      const result = await getTeamsSchedule(
        [
          {
            id: '130',
            abbrev: 'MICH',
            uniqueId: 'NCAAMH-MICH',
            label: 'Michigan Wolverines',
          },
        ],
        'NCAAMH',
        {},
        false,
      );

      expect(result['NCAAMH-MICH']).toHaveLength(1);
      expect(result['NCAAMH-MICH'][0].awayTeamId).toBe('NCAAMH-MIDB');
      expect(console.info).not.toHaveBeenCalledWith(
        expect.stringContaining('excluded 1 distinct game(s)'),
      );
      // No per-game division lookup: only the schedule requests hit the network.
      expect(
        fetchSpy.mock.calls.filter(([url]) =>
          String(url).includes('/schedule?'),
        ),
      ).toHaveLength(3);
    });
  });
});

/**
 * `isD1ScheduleTeam()` gives the per-team D1 verdict for the four parent-id
 * college leagues (NCAAF/NCAAB/WNCAAB/NCCABB) and delegates NCAAMH/NCAAWH to
 * their allowlists. Regression suite for the production incident where an
 * opponent ESPN could not verify (detail endpoint 404 — small D3 schools such
 * as St. Francis IL, or programs too recent such as Little Rock) threw
 * "Cannot verify Division I status … ESPN did not return a group parent" and
 * aborted the whole league refresh.
 */
describe('isD1ScheduleTeam', () => {
  beforeEach(() => {
    // Division / roster verdicts live in module-level caches: reset them so
    // each test starts from a known state.
    resetESPNDivisionCachesForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails open without caching when neither ESPN source can verify the team', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ code: 404 }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      );

    expect(await isD1ScheduleTeam('NCAAF', '99101')).toBe(true);
    expect(await isD1ScheduleTeam('NCAAF', '99101')).toBe(true);

    // First call: detail + roster fallback (2 fetches). The failed roster
    // fetch is remembered for 60s, so the second call only re-tries the detail
    // (1 fetch). The unverifiable verdict itself is never cached.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('fails open when the detail fetch rejects (network error)', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => Promise.reject(new Error('boom')));

    expect(await isD1ScheduleTeam('NCAAB', '99111')).toBe(true);
  });

  it('fails open when the detail payload carries no groups', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ team: { id: '99102' } }), {
            headers: { 'content-type': 'application/json' },
          }),
      );

    expect(await isD1ScheduleTeam('NCAAB', '99102')).toBe(true);
  });

  it('caches a verified verdict for 6h and walks the group hierarchy', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        // Group hierarchy (core API): the real D2 chain of Bowie State
        // (CIAA 104 → D2 57 → D2/D3 35 → NCAA Football 99, a non-D1 root).
        const groupParents: Record<string, string | undefined> = {
          '104': '57',
          '57': '35',
          '35': '99',
          '99': undefined,
        };
        const groupId = url.match(/\/groups\/(\d+)/)?.[1];
        if (groupId) {
          const parentId = groupParents[groupId];
          return new Response(
            JSON.stringify({
              id: groupId,
              name: `Group ${groupId}`,
              ...(parentId
                ? {
                    parent: {
                      $ref: `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/types/2/groups/${parentId}`,
                    },
                  }
                : {}),
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        const id = url.match(/\/teams\/(\d+)$/)?.[1];
        return new Response(
          JSON.stringify({
            team: {
              groups:
                id === '99103'
                  ? // FBS independent: direct FBS parent → fast path, no walk.
                    { id: '18', parent: { id: '80' } }
                  : // CIAA (D2) program: hierarchy walk to a non-D1 root.
                    { id: '104', parent: { id: '57' } },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });

    expect(await isD1ScheduleTeam('NCAAF', '99103')).toBe(true);
    expect(await isD1ScheduleTeam('NCAAF', '99103')).toBe(true);
    expect(await isD1ScheduleTeam('NCAAF', '99104')).toBe(false);
    expect(await isD1ScheduleTeam('NCAAF', '99104')).toBe(false);

    // One detail fetch per team plus one hierarchy lookup per group id
    // (104/57/35/99); both verdicts come from the cache afterwards.
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('keeps a D1 opponent that only the league roster can verify (detail 404)', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/teams?limit=1000')) {
          return new Response(
            JSON.stringify({
              sports: [
                {
                  leagues: [
                    {
                      teams: [
                        {
                          team: {
                            id: '99501',
                            groups: { id: '100', parent: { id: '50' } },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        // The per-team detail endpoint answers 404 for this id.
        return new Response(JSON.stringify({ code: 404 }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      });

    expect(await isD1ScheduleTeam('WNCAAB', '99501')).toBe(true);
    expect(await isD1ScheduleTeam('WNCAAB', '99501')).toBe(true);

    // 1st call: detail + roster (2 fetches). The verified verdict is cached
    // for 6h, so the 2nd call performs no request at all.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(['99502', '99503'])(
    'excludes team %s when the roster fallback proves it is not D1',
    async (id) => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          // Group hierarchy (core API): group 777 is a non-D1 root.
          if (url.includes('/groups/777')) {
            return new Response(
              JSON.stringify({ id: '777', name: 'Non-D1 Root Group' }),
              { headers: { 'content-type': 'application/json' } },
            );
          }
          if (url.includes('/teams?limit=1000')) {
            // 99503 is listed with a non-D1 group; 99502 is absent entirely.
            return new Response(
              JSON.stringify({
                sports: [
                  {
                    leagues: [
                      {
                        teams: [
                          {
                            team: {
                              id: '99503',
                              groups: { id: '777' },
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(JSON.stringify({ code: 404 }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        });

      expect(await isD1ScheduleTeam('NCCABB', id)).toBe(false);
      expect(await isD1ScheduleTeam('NCCABB', id)).toBe(false);

      // The negative verdict is cached (6h): one detail fetch per call to
      // `isD1ScheduleTeam`… except the second call hits the cache, plus one
      // hierarchy lookup for 99503's group — and one roster fetch (cached).
      expect(
        fetchSpy.mock.calls.filter(([url]) => {
          const target = String(url);
          return (
            !target.includes('/teams?limit=1000') && !target.includes('/groups/')
          );
        }),
      ).toHaveLength(1);
    },
  );

  it.each(['NCAAMH', 'NCAAWH'])(
    'uses the %s allowlist without ever calling ESPN',
    async (league) => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(async () => new Response('{}'));

      expect(await isD1ScheduleTeam(league, '99105', 'NOTLISTED')).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
  it('keeps conference-parented teams (Sun Belt / SWAC) by walking the group hierarchy', async () => {
    // Regression for the reported bug: ESPN parents these programs to their
    // CONFERENCE instead of FBS/FCS (`groups.parent.id` is 37 for every Sun
    // Belt team and 31 for every SWAC team), so the direct-parent test
    // wrongly classified them as non-D1 and dropped their games.
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        const groupParents: Record<string, string | undefined> = {
          '167': '37', // Sun Belt - East
          '37': '80', // Sun Belt Conference → FBS
          '33': '31', // SWAC - East
          '31': '81', // Southwestern Athletic Conference → FCS
        };
        const groupId = url.match(/\/groups\/(\d+)/)?.[1];
        if (groupId) {
          const parentId = groupParents[groupId];
          return new Response(
            JSON.stringify({
              id: groupId,
              name: `Group ${groupId}`,
              ...(parentId
                ? {
                    parent: {
                      $ref: `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/types/2/groups/${parentId}`,
                    },
                  }
                : {}),
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        const teamId = url.match(/\/teams\/(\d+)$/)?.[1];
        return new Response(
          JSON.stringify({
            team: {
              groups:
                teamId === '99701'
                  ? { id: '167', parent: { id: '37' } }
                  : { id: '33', parent: { id: '31' } },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });

    expect(await isD1ScheduleTeam('NCAAF', '99701')).toBe(true); // Sun Belt
    expect(await isD1ScheduleTeam('NCAAF', '99702')).toBe(true); // SWAC

    // 2 detail fetches + 4 hierarchy lookups (167 → 37 and 33 → 31); the
    // roster is never consulted and nothing is warned about.
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(
      fetchSpy.mock.calls.filter(([url]) =>
        String(url).includes('/teams?limit=1000'),
      ),
    ).toHaveLength(0);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('classifies a NAIA team (group 186, no parent) non-D1 from the detail payload alone', async () => {
    // Real shape of Virginia Lynchburg / UFTL:
    // `groups: { id: '186', isConference: false }` with no parent — 186
    // ("NAIA") is a non-D1 root of the hierarchy, so the walk decides
    // without ever consulting the roster.
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/groups/186')) {
          return new Response(JSON.stringify({ id: '186', name: 'NAIA' }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            team: { groups: { id: '186', isConference: false } },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });

    expect(await isD1ScheduleTeam('NCAAF', '99777')).toBe(false);
    expect(await isD1ScheduleTeam('NCAAF', '99777')).toBe(false);

    // One detail fetch + one hierarchy lookup; the negative verdict is
    // cached (6h) and the roster is never consulted.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(
      fetchSpy.mock.calls.filter(([url]) =>
        String(url).includes('/teams?limit=1000'),
      ),
    ).toHaveLength(0);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('fails open without caching when the roster was fetched but carries no groups', async () => {
    // The real ESPN state: the roster answers but every entry lacks
    // `groups` (0/762 NCAAF entries in late 2026), so it can neither
    // confirm nor refute anything. A team whose detail fetch fails (here a
    // transient 404) must be kept, warned about, and re-verified next
    // refresh — NOT classified non-D1 on missing info.
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/teams/99888')) {
          return new Response(JSON.stringify({ code: 404 }), { status: 404 });
        }
        if (url.includes('/teams?limit=1000')) {
          // ESPN answered, but the roster carries no `groups` for any team.
          return new Response(
            JSON.stringify({
              sports: [
                {
                  leagues: [
                    {
                      teams: [{ team: { id: '99889' } }],
                    },
                  ],
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}');
      });

    expect(await isD1ScheduleTeam('NCAAF', '99888')).toBe(true);
    expect(await isD1ScheduleTeam('NCAAF', '99888')).toBe(true);

    // 1st call: detail + roster (2 fetches). The verdict is NOT cached, but
    // the roster answer is (6h), so the 2nd call only re-tries the detail.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'the league roster was fetched but carries no division info',
      ),
    );
  });

  it('fails open when the group hierarchy itself is unreachable', async () => {
    // The hierarchy lookup (core API) answers 404 for every group id: the
    // verdict stays unproven, the team is kept fail-open twice and nothing
    // is cached.
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/groups/')) {
          return new Response(JSON.stringify({ code: 404 }), { status: 404 });
        }
        if (url.includes('/teams/99701')) {
          return new Response(
            JSON.stringify({
              team: { groups: { id: '167', parent: { id: '37' } } },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        // Roster unreachable too.
        return new Response(JSON.stringify({ code: 404 }), { status: 404 });
      });

    expect(await isD1ScheduleTeam('NCAAF', '99701')).toBe(true);
    expect(await isD1ScheduleTeam('NCAAF', '99701')).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
