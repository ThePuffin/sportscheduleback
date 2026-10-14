/**
 * Scraping adapter for sources that do not expose a documented public API.
 *
 * The first (and currently only) source is the **Synerglace Ligue Magnus**
 * calendar (https://liguemagnus.com/calendrier/). Contrary to what the page
 * source suggests — the calendar container `<div class="calendrier-general-compet">`
 * ships **empty** — the fixtures are not server-rendered: the site's JS calls a
 * WordPress AJAX endpoint (admin-ajax.php) with `action=get_rencontres`, which
 * answers JSON built from the hockeynet.fr feed. Scraping therefore happens on
 * that JSON endpoint, no HTML parsing (cheerio) is required.
 *
 * Scope for now: fetch the raw `rencontres` and print them with `console.log`
 * so the payload can be reviewed by hand. Mapping them onto `GameFormatted`
 * (games) and `TeamType` (teams) for the database is a later step.
 */

/** WordPress AJAX endpoint behind https://liguemagnus.com/calendrier/. */
const LIGUE_MAGNUS_AJAX_URL = 'https://liguemagnus.com/wp-admin/admin-ajax.php';

/**
 * Default phase (`poule` query parameter of the calendar page): `714` is the
 * "Saison régulière" of the 2026-27 season (15/09/2026 -> 02/03/2027, 264
 * fixtures, 12 clubs). Phase ids are season-specific: when the next season
 * starts, the calendar page itself must be re-read to get the new `poule` id.
 */
const LIGUE_MAGNUS_DEFAULT_PHASE_ID = 714;

// Browser-like identity: the site can answer headerless or bot-like requests,
// mirroring what ESPN (Akamai) needs in espnAllData.ts.
const LIGUE_MAGNUS_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

const LIGUE_MAGNUS_FETCH_TIMEOUT_MS = 15000;
// `par_page` of 1000 answers the whole regular season in one request; paging
// is still implemented because the endpoint reports `meta.last_page`.
const LIGUE_MAGNUS_PAR_PAGE = 1000;
// Safety net: never walk more pages than this even if the endpoint keeps
// advertising a next page (a broken cursor would otherwise loop forever).
const LIGUE_MAGNUS_MAX_PAGES = 50;

/** One club as returned inside a rencontre (`receveur` / `visiteur`). */
export type LigueMagnusTeam = {
  id: number;
  /** e.g. `"93006S - RAPACES DE GAP"` */
  libelle: string | null;
  /** e.g. `"Rapaces de Gap"` */
  libelle_complet: string | null;
  /** e.g. `"GAP"` — the short label used by the calendar table */
  libelle_court: string | null;
  /** e.g. `"GAP"` */
  abreviation: string | null;
  /** Full-size logo URL (hockeynet.fr storage), may be null */
  logo: string | null;
};

/** One side of the `score` array; scores are keyed by `equipe_id`. */
export type LigueMagnusScoreEntry = {
  sportif_rencontre_id?: number;
  participant_id?: number;
  equipe_id: number;
  score: number;
};

export type LigueMagnusPhase = {
  id: number;
  libelle?: string;
  /** e.g. `"Synerglace Ligue Magnus"` */
  competition_libelle?: string;
  /** `"C"` = championnat, `"T"` = tournoi (bracket, rendered differently) */
  type_phase?: string;
};

/**
 * One fixture ("rencontre") of the Ligue Magnus calendar.
 *
 * `etat` values observed on the live feed: `"T"` (terminé / finished), `"R"`
 * (reporté / postponed) and `null` (not played yet). `victoire_par` explains
 * how a finished game was decided: `"S"` (shootout), `"PRL"` (prolongation),
 * `"TAB"` (tir au but).
 */
export type LigueMagnusRencontre = {
  id: number;
  rencontre_libelle: string | null;
  /** `"YYYY-MM-DD HH:mm"` in `Europe/Paris`, e.g. `"2026-09-15 20:00"` */
  date_rencontre: string | null;
  phase_id?: number;
  phase?: LigueMagnusPhase | null;
  competition?: LigueMagnusCompetition | null;
  /** Home team ("receveur") */
  receveur?: LigueMagnusTeam | null;
  /** Away team ("visiteur") */
  visiteur?: LigueMagnusTeam | null;
  score?: LigueMagnusScoreEntry[];
  lieu_de_pratique?: { id?: number; nom?: string } | null;
  tour?: number | null;
  etat?: string | null;
  en_cours?: boolean;
  victoire_par?: string | null;
  calendrier?: { date_debut?: string; date_fin?: string } | null;
};

/** Filters accepted by the scraper; every field maps to an endpoint parameter. */
export type LigueMagnusQuery = {
  /** Defaults to `714` (2026-27 regular season) */
  phaseId?: number;
  competitionId?: number | string;
  /** Lower bound, `YYYY-MM-DD` or any format the endpoint accepts */
  dateMin?: string;
  /** Upper bound (the site sends the day after the last wanted day) */
  dateMax?: string;
  journee?: number | string;
  equipeId?: number;
  /** Page size, defaults to 1000 (one page for a full season) */
  parPage?: number;
};

/** Pagination envelope returned under `data` by the endpoint. */
type RencontresPage = {
  data?: LigueMagnusRencontre[];
  meta?: {
    current_page?: number;
    last_page?: number;
    total?: number;
    per_page?: number;
  };
  links?: { next?: string | null } | unknown;
};

type RencontresResponse = {
  success?: boolean;
  data?: RencontresPage;
};

/**
 * Fetch with a hard timeout, the same idea as `fetchWithTimeout()` in
 * `espnAllData.ts`: a hanging request must not block a refresh forever.
 */
const fetchWithTimeout = async (
  url: string,
  timeoutMs: number = LIGUE_MAGNUS_FETCH_TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { ...LIGUE_MAGNUS_HEADERS },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

/** Build the endpoint URL for one page of rencontres. */
export const buildLigueMagnusUrl = (
  query: LigueMagnusQuery,
  page: number,
): string => {
  const params = new URLSearchParams();
  params.set('action', 'get_rencontres');
  params.set(
    'phase_id',
    String(query.phaseId ?? LIGUE_MAGNUS_DEFAULT_PHASE_ID),
  );
  params.set('page', String(page));
  params.set('par_page', String(query.parPage ?? LIGUE_MAGNUS_PAR_PAGE));
  // The site always sends `limite=0`; any other value caps the result set.
  params.set('limite', '0');
  if (query.competitionId !== undefined && query.competitionId !== '') {
    params.set('competition_id', String(query.competitionId));
  }
  if (query.dateMin) params.set('date_min', query.dateMin);
  if (query.dateMax) params.set('date_max', query.dateMax);
  if (query.journee !== undefined && query.journee !== '') {
    params.set('journee', String(query.journee));
  }
  if (query.equipeId !== undefined) {
    params.set('equipe_id', String(query.equipeId));
  }
  return `${LIGUE_MAGNUS_AJAX_URL}?${params.toString()}`;
};

export type LigueMagnusCompetition = {
  id: number;
  libelle?: string;
  /** Season year carried by the competition, e.g. `2027` for 2026-27 */
  saison?: number;
};

/**
 * Human-readable one-line rendering of a fixture, used by the `console.log`
 * dump: `2026-09-15 20:00  GAP 2 - 1 CHAMONIX`.
 * Postponed games are tagged `(Reporté)`, unknown/upcoming scores show `-`.
 */
export const formatRencontreLine = (
  rencontre: LigueMagnusRencontre,
): string => {
  const home = rencontre.receveur?.libelle_court ?? 'Inconnue';
  const away = rencontre.visiteur?.libelle_court ?? 'Inconnue';
  const homeScore = rencontre.score?.find(
    (entry) => entry.equipe_id === rencontre.receveur?.id,
  );
  const awayScore = rencontre.score?.find(
    (entry) => entry.equipe_id === rencontre.visiteur?.id,
  );
  const played = rencontre.etat === 'T' || rencontre.etat === 'R';
  const score =
    !played || homeScore === undefined || awayScore === undefined
      ? '-'
      : `${homeScore.score} - ${awayScore.score}`;
  const tag = rencontre.etat === 'R' ? ' (Reporté)' : '';
  return `${rencontre.date_rencontre ?? 'Date non connue'}  ${home} ${score} ${away}${tag}`;
};

export class ScrappingData {
  /**
   * Fetch **one page** of Ligue Magnus fixtures.
   * Throws when the HTTP request fails or the endpoint reports
   * `success: false`, so the caller's try/catch stays in charge of fallbacks.
   */
  private async getRencontresPage(
    query: LigueMagnusQuery,
    page: number,
  ): Promise<RencontresPage> {
    const url = buildLigueMagnusUrl(query, page);
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`Ligue Magnus endpoint answered HTTP ${response.status}`);
    }
    const json = (await response.json()) as RencontresResponse;
    if (json?.success === false || !json?.data) {
      throw new Error('Ligue Magnus endpoint answered an unexpected payload');
    }
    return json.data;
  }

  /**
   * Fetch every fixture of a phase, following `meta.last_page` until the last
   * page (one request for a full regular season with the default page size).
   * Logs one fetched-match count per page to keep the crawl observable.
   */
  async getLigueMagnusRencontres(
    query: LigueMagnusQuery = {},
  ): Promise<LigueMagnusRencontre[]> {
    const phaseId = query.phaseId ?? LIGUE_MAGNUS_DEFAULT_PHASE_ID;
    const rencontres: LigueMagnusRencontre[] = [];
    const seenIds = new Set<number>();

    for (let page = 1; page <= LIGUE_MAGNUS_MAX_PAGES; page++) {
      const payload = await this.getRencontresPage(query, page);
      const rows = Array.isArray(payload.data) ? payload.data : [];
      for (const rencontre of rows) {
        // Guard against a cursor that wraps around: never emit the same
        // fixture twice, duplicates would double-count games in the BDD.
        if (seenIds.has(rencontre.id)) continue;
        seenIds.add(rencontre.id);
        rencontres.push(rencontre);
      }

      const current = payload.meta?.current_page ?? page;
      const last = payload.meta?.last_page ?? current;
      console.log(
        `[ScrappingData] Ligue Magnus phase ${phaseId}: page ${current}/${last} -> ${rows.length} rencontres fetched (${rencontres.length} distinct so far)`,
      );

      if (current >= last || rows.length === 0) break;
    }

    return rencontres;
  }

  /**
   * Entry point for now: scrape the calendar and **print the raw payload**.
   *
   * Logs three things: a per-page progress line (from
   * `getLigueMagnusRencontres`), a compact one-line-per-fixture summary, and
   * the full raw `rencontres` array so every field of the payload is visible
   * while the future database mapping is designed. Returns the raw fixtures
   * (empty array on failure) rather than throwing, matching the error
   * handling style of `HockeyData` / `ESPNAllData`.
   */
  async scrapeLigueMagnus(
    query: LigueMagnusQuery = {},
  ): Promise<LigueMagnusRencontre[]> {
    try {
      const phaseId = query.phaseId ?? LIGUE_MAGNUS_DEFAULT_PHASE_ID;
      const rencontres = await this.getLigueMagnusRencontres(query);

      const teams = new Map<number, string>();
      for (const rencontre of rencontres) {
        if (rencontre.receveur?.id) {
          teams.set(
            rencontre.receveur.id,
            rencontre.receveur.libelle_court ??
              rencontre.receveur.libelle ??
              '',
          );
        }
        if (rencontre.visiteur?.id) {
          teams.set(
            rencontre.visiteur.id,
            rencontre.visiteur.libelle_court ??
              rencontre.visiteur.libelle ??
              '',
          );
        }
      }
      const finished = rencontres.filter((r) => r.etat === 'T').length;
      const postponed = rencontres.filter((r) => r.etat === 'R').length;
      const upcoming = rencontres.length - finished - postponed;

      console.log(
        `[ScrappingData] Ligue Magnus scrape done: ${rencontres.length} matches (${finished} finished, ${upcoming} upcoming, ${postponed} postponed), ${teams.size} teams, phase ${phaseId}`,
      );
      console.log(
        `[ScrappingData] Fixtures:\n${rencontres
          .map(formatRencontreLine)
          .join('\n')}`,
      );
      console.log(
        '[ScrappingData] Raw rencontres:',
        JSON.parse(JSON.stringify(rencontres)),
      );

      return rencontres;
    } catch (error) {
      console.error(
        '[ScrappingData] Error scraping the Ligue Magnus calendar:',
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }
}
