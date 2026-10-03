import {
  applySeasonFinalRecords,
  extractCompetitorRecord,
} from './espnAllData';

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
  ) => ({
    startTimeUTC: '2025-04-15T23:00:00.000Z',
    homeTeamId,
    awayTeamId,
    homeTeamRecord,
    awayTeamRecord,
  });

  it('replaces the cumulative per-game tallies with the final season tally', () => {
    const allGames = {
      'NHL-BOS': [
        pastGame('NHL-BOS', 'NHL-TOR', '1-1-0', '1-1-0'), // pre-season
        pastGame('NHL-BOS', 'NHL-TOR', '33-39-10', '42-32-7'), // final
      ],
      'NHL-TOR': [pastGame('NHL-TOR', 'NHL-BOS', '42-32-7', '33-39-10')],
    };

    applySeasonFinalRecords(allGames);

    const games = [...allGames['NHL-BOS'], ...allGames['NHL-TOR']];
    for (const game of games) {
      expect(game.homeTeamRecord).toBe(
        game.homeTeamId === 'NHL-BOS' ? '33-39-10' : '42-32-7',
      );
      expect(game.awayTeamRecord).toBe(
        game.awayTeamId === 'NHL-BOS' ? '33-39-10' : '42-32-7',
      );
    }
  });

  it('keeps the pre-season tally out of the final one (fewer games played)', () => {
    const allGames = {
      'NHL-BOS': [
        pastGame('NHL-BOS', 'NHL-TOR', '4-1-0', '2-3-0'), // pre-season, 5 games
        pastGame('NHL-BOS', 'NHL-TOR', '33-39-10', '42-32-7'), // 82 games
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
