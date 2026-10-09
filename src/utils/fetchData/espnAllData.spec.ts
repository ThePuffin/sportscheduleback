import {
  applySeasonFinalRecords,
  extractCompetitorRecord,
  fetchJsonOrNull,
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

describe('fetchJsonOrNull', () => {
  let fetchSpy;

  const jsonResponse = { events: [{ id: '1', date: '2026-01-01T00:00:00Z' }] };

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(null)));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns parsed JSON for a 2xx response with a JSON content-type', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (name) => (name === 'content-type' ? 'application/json; charset=UTF-8' : null) },
      json: () => Promise.resolve(jsonResponse),
    });

    const result = await fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=2');

    expect(result).toBe(jsonResponse);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null instead of throwing when the response is 4xx/5xx with an HTML body', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: (name) => (name === 'content-type' ? 'text/html' : null) },
      text: () => Promise.resolve('<HTML><HEA</HTML>'),
    });

    const result = await fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=1');

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries once on 429, then returns null when still rate limited', async () => {
    const rateLimited = {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: {
        get: (name) =>
          name === 'content-type' ? 'text/html' : name === 'retry-after' ? '1' : null,
      },
      text: () => Promise.resolve('<html>rate limited</html>'),
    };
    fetchSpy
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited);

    const result = await fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=2');

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns parsed JSON on the retry when the 429 is lifted', async () => {
    const rateLimited = {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: {
        get: (name) =>
          name === 'content-type' ? 'text/html' : name === 'retry-after' ? '1' : null,
      },
      text: () => Promise.resolve('<html>rate limited</html>'),
    };
    fetchSpy
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name) => (name === 'content-type' ? 'application/json; charset=UTF-8' : null) },
        json: () => Promise.resolve(jsonResponse),
      });

    const result = await fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=2');

    expect(result).toBe(jsonResponse);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on a network-level failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    fetchSpy.mockRejectedValueOnce(new Error('network down'));

    await expect(
      fetchJsonOrNull('https://site.api.espn.com/teams/302/schedule?seasontype=2'),
    ).rejects.toThrow('network down');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

