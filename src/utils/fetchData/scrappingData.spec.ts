import {
  buildLigueMagnusUrl,
  formatRencontreLine,
  LigueMagnusRencontre,
  ScrappingData,
} from './scrappingData';

const makeTeam = (id: number, short: string) => ({
  id,
  libelle: `${short} LIBELLE`,
  libelle_complet: `${short} complet`,
  libelle_court: short,
  abreviation: short,
  logo: `https://example.com/${short}.png`,
});

const makeRencontre = (
  id: number,
  overrides: Partial<LigueMagnusRencontre> = {},
): LigueMagnusRencontre => ({
  id,
  rencontre_libelle: `HOME${id} / AWAY${id}`,
  date_rencontre: '2026-09-15 20:00',
  receveur: makeTeam(1, 'HOME'),
  visiteur: makeTeam(2, 'AWAY'),
  score: [
    { equipe_id: 1, score: 3 },
    { equipe_id: 2, score: 1 },
  ],
  etat: 'T',
  ...overrides,
});

const makeResponse = (
  rows: LigueMagnusRencontre[],
  options: {
    page?: number;
    lastPage?: number;
    ok?: boolean;
    success?: boolean;
    withData?: boolean;
  } = {},
) => {
  const { page = 1, lastPage = 1, ok = true, success = true } = options;
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => ({
      success,
      data:
        options.withData === false
          ? undefined
          : {
              data: rows,
              meta: {
                current_page: page,
                last_page: lastPage,
                total: rows.length,
                per_page: 1000,
              },
              links: { next: page < lastPage ? 'next-url' : null },
            },
    }),
  };
};

describe('buildLigueMagnusUrl', () => {
  it('targets the admin-ajax get_rencontres action with the default phase', () => {
    const url = new URL(buildLigueMagnusUrl({}, 1));
    expect(url.origin + url.pathname).toBe(
      'https://liguemagnus.com/wp-admin/admin-ajax.php',
    );
    expect(url.searchParams.get('action')).toBe('get_rencontres');
    expect(url.searchParams.get('phase_id')).toBe('714');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('par_page')).toBe('1000');
    expect(url.searchParams.get('limite')).toBe('0');
  });

  it('maps every query filter onto its endpoint parameter', () => {
    const url = new URL(
      buildLigueMagnusUrl(
        {
          phaseId: 800,
          competitionId: 240,
          dateMin: '2026-09-15',
          dateMax: '2026-09-16',
          journee: 3,
          equipeId: 366,
          parPage: 10,
        },
        2,
      ),
    );
    expect(url.searchParams.get('phase_id')).toBe('800');
    expect(url.searchParams.get('competition_id')).toBe('240');
    expect(url.searchParams.get('date_min')).toBe('2026-09-15');
    expect(url.searchParams.get('date_max')).toBe('2026-09-16');
    expect(url.searchParams.get('journee')).toBe('3');
    expect(url.searchParams.get('equipe_id')).toBe('366');
    expect(url.searchParams.get('par_page')).toBe('10');
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('omits empty filters', () => {
    const url = new URL(buildLigueMagnusUrl({}, 1));
    expect(url.searchParams.get('competition_id')).toBeNull();
    expect(url.searchParams.get('date_min')).toBeNull();
    expect(url.searchParams.get('journee')).toBeNull();
    expect(url.searchParams.get('equipe_id')).toBeNull();
  });
});

describe('ScrappingData', () => {
  const fetchMock = jest.fn();
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('fetches one page of rencontres and reports the fetched count', async () => {
    const rows = [makeRencontre(1), makeRencontre(2)];
    fetchMock.mockResolvedValue(makeResponse(rows));

    const result = await new ScrappingData().getLigueMagnusRencontres();

    expect(result).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = String(fetchMock.mock.calls[0][0]);
    expect(requested).toContain('action=get_rencontres');
    expect(requested).toContain('phase_id=714');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('page 1/1 -> 2 rencontres fetched'),
    );
  });

  it('walks every page until last_page and drops duplicate ids', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse([makeRencontre(1)], { page: 1, lastPage: 2 }),
      )
      .mockResolvedValueOnce(
        makeResponse([makeRencontre(1), makeRencontre(2)], {
          page: 2,
          lastPage: 2,
        }),
      );

    const result = await new ScrappingData().getLigueMagnusRencontres();

    expect(result.map((r) => r.id)).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('page=2');
  });

  it('scrapeLigueMagnus logs a summary, the fixture lines and the raw payload', async () => {
    const rows = [
      makeRencontre(1),
      makeRencontre(2, { etat: null, score: [] }),
      makeRencontre(3, { etat: 'R' }),
    ];
    fetchMock.mockResolvedValue(makeResponse(rows));

    const result = await new ScrappingData().scrapeLigueMagnus();

    expect(result).toHaveLength(3);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '3 matches (1 finished, 1 upcoming, 1 postponed), 2 teams, phase 714',
      ),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('2026-09-15 20:00  HOME 3 - 1 AWAY'),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('(Reporté)'));
    expect(logSpy).toHaveBeenCalledWith(
      '[ScrappingData] Raw rencontres:',
      expect.any(Array),
    );
  });

  it('returns an empty array and logs the error when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await new ScrappingData().scrapeLigueMagnus();

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      '[ScrappingData] Error scraping the Ligue Magnus calendar:',
      'network down',
    );
  });

  it('fails open on a non-2xx answer', async () => {
    fetchMock.mockResolvedValue(makeResponse([], { ok: false }));

    const result = await new ScrappingData().scrapeLigueMagnus();

    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('formatRencontreLine', () => {
  it('prints the scores of a finished game', () => {
    expect(formatRencontreLine(makeRencontre(1))).toBe(
      '2026-09-15 20:00  HOME 3 - 1 AWAY',
    );
  });

  it('prints a dash when the game has no score yet', () => {
    expect(
      formatRencontreLine(makeRencontre(1, { etat: null, score: [] })),
    ).toBe('2026-09-15 20:00  HOME - AWAY');
  });

  it('tags postponed games and handles missing teams/dates', () => {
    expect(
      formatRencontreLine(
        makeRencontre(1, {
          etat: 'R',
          date_rencontre: null,
          receveur: null,
        }),
      ),
    ).toBe('Date non connue  Inconnue - AWAY (Reporté)');
  });
});
