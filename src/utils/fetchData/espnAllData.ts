import { readableDate } from '../../utils/date';
import { CollegeLeague, League } from '../../utils/enum';
import { getTeamColors } from '../Colors';
import type { ESPNTeam, TeamType } from '../interface/team';
import { UniversityLogos } from '../UniversityLogos';
import { capitalize, getLuminance, getCurrentSeasonYears } from '../utils';

const espnAPI = 'https://site.api.espn.com/apis/site/v2/sports/';

const ESPN_LOGO_RELATION_PRIORITIES = [
  ['default'],
  ['full', 'scoreboard'],
  ['scoreboard'],
  ['full'],
  ['primary_logo_on_white_color'],
  ['primary_logo_on_primary_color'],
  ['primary_logo_on_secondary_color'],
  ['primary_logo_on_black_color'],
  ['primary_logo_black'],
  ['primary_logo_white'],
];

export const getESPNTeamLogo = (
  team?: Partial<Pick<ESPNTeam['team'], 'logo' | 'logos'>>,
  preferredRelations: string[][] = [],
): string | undefined => {
  const logos = Array.isArray(team?.logos)
    ? team.logos.filter((logo) => logo && typeof logo.href === 'string')
    : [];
  const validUrl = (href?: string) =>
    typeof href === 'string' && href.trim().length > 0;

  const preferredLogo = preferredRelations
    .map(
      (relations) =>
        logos.find((logo) =>
          relations.every((relation) => logo.rel?.includes(relation)),
        )?.href,
    )
    .find(validUrl);

  return (
    preferredLogo ??
    [
      logos[2]?.href,
      logos[0]?.href,
      team?.logo,
      ...ESPN_LOGO_RELATION_PRIORITIES.map(
        (relations) =>
          logos.find((logo) =>
            relations.every((relation) => logo.rel?.includes(relation)),
          )?.href,
      ),
      ...logos.map((logo) => logo.href),
    ].find(validUrl)
  );
};

// Abort a hanging ESPN request after `timeoutMs`, using the global AbortController
// (Node >= 18). Prevents a connect-timeout from blocking the schedule/oldies
// refresh for an unbounded amount of time (undici's default is very long).
const ESPN_FETCH_TIMEOUT_MS = 15000;

// Small pacing gap between per-team batches in getTeamsSchedule(): without it
// the oldies crawl fires hundreds of team-schedule requests back-to-back and
// ESPN's Akamai edge starts answering with transient 403 "Access Denied" pages.
const ESPN_TEAM_BATCH_DELAY_MS = 120;
const ESPN_TEAM_SCHEDULE_PAGE_SIZE = 1000;
const ESPN_TEAM_SCHEDULE_MAX_PAGES = 100;

// A browser-like identity: ESPN's Akamai edge is known to answer some
// headerless / bot-like requests with a 403 "Access Denied" HTML page. Sending a
// normal User-Agent + Accept keeps us on the fast path.
const ESPN_DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

const fetchWithTimeout = (
  url: string,
  timeoutMs: number = ESPN_FETCH_TIMEOUT_MS,
  options: RequestInit = {},
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const mergedOptions: RequestInit = {
    ...options,
    headers: { ...ESPN_DEFAULT_HEADERS, ...(options.headers || {}) },
    signal: controller.signal,
  };
  return fetch(url, mergedOptions).finally(() => clearTimeout(timeout));
};

// Retry transient network errors (timeouts are often momentary). Throws the last
// error once all retries are exhausted, so the existing try/catch still works.
const fetchWithRetry = async (url: string, retries = 1) => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * (attempt + 1)),
        );
      }
    }
  }
  throw lastError;
};

// Fetches ESPN with the global timeout + one retry, then parses JSON only when
// the response is a successful JSON payload. Fails open (returns null) for
// non-2xx or non-JSON responses so a single bad response can never abort the
// whole refresh.
//
// ESPN sits behind Akamai, which answers request bursts (the oldies crawl fires
// hundreds of team-schedule calls back-to-back) with a transient HTTP 403
// "Access Denied" HTML page — functionally a soft rate-limit / bot-block, NOT a
// real "not found". We therefore treat 403 exactly like 429: back off and retry
// a couple of times before giving up, so a momentary block no longer silently
// drops a whole team's games.
const ESPN_RETRYABLE_STATUSES = new Set([403, 429]);
const ESPN_MAX_RETRIES = 2;

// Throttle the "Skipping" warning so a big crawl that really is blocked logs the
// first failure in full, then only every Nth one instead of one line per team.
let espnSkipCount = 0;
const ESPN_SKIP_LOG_EVERY = 25;

export const fetchJsonOrNull = async (url: string): Promise<any> => {
  let res = await fetchWithRetry(url);

  for (let attempt = 0; attempt < ESPN_MAX_RETRIES; attempt++) {
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('json')) {
      return res.json();
    }
    if (!ESPN_RETRYABLE_STATUSES.has(res.status)) {
      break;
    }

    // Rate-limited / bot-blocked: honour Retry-After when present, else a short
    // exponential backoff. Cap the wait so a stubborn block can't stall the run.
    const retryAfter = res.headers.get('retry-after');
    const ms =
      retryAfter && !Number.isNaN(Number(retryAfter))
        ? Number(retryAfter) * 1000
        : 500 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 15000)));
    res = await fetchWithRetry(url);
  }

  const ct = res.headers.get('content-type') || '';
  if (res.ok && ct.includes('json')) {
    return res.json();
  }

  const body = await res.text().catch(() => '');
  const snippet = body.slice(0, 160).replace(/\s+/g, ' ');
  espnSkipCount++;
  if (espnSkipCount === 1 || espnSkipCount % ESPN_SKIP_LOG_EVERY === 0) {
    console.warn(
      `[ESPN] Skipping ${res.status} ${res.statusText} ${ct ? 'non-JSON' : 'HTTP'} for ${url} — body preview: ${snippet}` +
        (espnSkipCount > 1
          ? ` (skip #${espnSkipCount}; further skips logged every ${ESPN_SKIP_LOG_EVERY})`
          : ''),
    );
  }
  return null;
};

const getNextTeamSchedulePageUrl = (
  data: any,
  currentUrl: string,
  currentPage: number,
  eventCount: number,
): string | undefined => {
  const nextLink =
    typeof data?.links?.next === 'string'
      ? data.links.next
      : typeof data?.links?.next?.href === 'string'
        ? data.links.next.href
        : typeof data?.nextPage === 'string' && !/^\d+$/.test(data.nextPage)
          ? data.nextPage
          : undefined;

  if (nextLink) return new URL(nextLink, currentUrl).toString();

  const totalPages =
    data?.pagination?.totalPages ??
    data?.pagination?.pageCount ??
    data?.totalPages ??
    data?.pageCount;
  const reportedPageIndex = data?.pagination?.pageIndex ?? data?.pageIndex;
  const reportedCurrentPage =
    data?.pagination?.currentPage ?? data?.currentPage;
  const hasNext =
    data?.pagination?.hasNext ?? data?.hasNext ?? data?.hasNextPage;
  const nextPage = data?.pagination?.nextPage ?? data?.nextPage;
  const nextPageNumber =
    typeof nextPage === 'number'
      ? nextPage
      : typeof nextPage === 'string' && /^\d+$/.test(nextPage)
        ? Number(nextPage)
        : undefined;

  if (hasNext === false) return undefined;
  if (nextPageNumber !== undefined && nextPageNumber > currentPage) {
    const nextUrl = new URL(currentUrl);
    nextUrl.searchParams.set('page', String(nextPageNumber));
    return nextUrl.toString();
  }
  if (
    typeof totalPages === 'number' &&
    Number.isFinite(totalPages) &&
    totalPages > 0
  ) {
    const pageNumber =
      typeof reportedPageIndex === 'number'
        ? reportedPageIndex + 1
        : typeof reportedCurrentPage === 'number'
          ? reportedCurrentPage
          : currentPage;
    if (pageNumber < totalPages) {
      const nextUrl = new URL(currentUrl);
      nextUrl.searchParams.set('page', String(pageNumber + 1));
      return nextUrl.toString();
    }
    return undefined;
  }
  if (hasNext === true || eventCount >= ESPN_TEAM_SCHEDULE_PAGE_SIZE) {
    const nextUrl = new URL(currentUrl);
    nextUrl.searchParams.set('page', String(currentPage + 1));
    return nextUrl.toString();
  }
  return undefined;
};

export const fetchESPNTeamScheduleEvents = async (
  initialUrl: string,
): Promise<any[]> => {
  const firstPageUrl = new URL(initialUrl);
  firstPageUrl.searchParams.set('limit', String(ESPN_TEAM_SCHEDULE_PAGE_SIZE));
  firstPageUrl.searchParams.set('page', '1');

  const events: any[] = [];
  const seenEventIds = new Set<string>();
  let nextUrl: string | undefined = firstPageUrl.toString();
  let page = 0;

  while (nextUrl) {
    if (page >= ESPN_TEAM_SCHEDULE_MAX_PAGES) {
      throw new Error(
        `ESPN team schedule exceeded the ${ESPN_TEAM_SCHEDULE_MAX_PAGES}-page safety limit for ${initialUrl}.`,
      );
    }

    const pageUrl = nextUrl;
    const data = await fetchJsonOrNull(pageUrl);
    if (!data || !Array.isArray(data.events)) {
      throw new Error(
        `ESPN returned no complete schedule data for ${pageUrl}.`,
      );
    }

    const priorEventCount = events.length;
    for (const event of data.events) {
      const eventId =
        event?.id != null ? String(event.id) : JSON.stringify(event);
      if (seenEventIds.has(eventId)) continue;
      seenEventIds.add(eventId);
      events.push(event);
    }

    page++;
    const requestedNextUrl = getNextTeamSchedulePageUrl(
      data,
      pageUrl,
      page,
      data.events.length,
    );
    if (!requestedNextUrl) {
      nextUrl = undefined;
      continue;
    }

    if (events.length === priorEventCount) {
      const hasExplicitNextPage =
        data?.links?.next ||
        data?.nextPage ||
        data?.pagination?.hasNext === true ||
        data?.hasNext === true ||
        data?.hasNextPage === true ||
        data?.pagination?.totalPages ||
        data?.pagination?.pageCount ||
        data?.totalPages ||
        data?.pageCount ||
        data.events.length >= ESPN_TEAM_SCHEDULE_PAGE_SIZE;
      if (hasExplicitNextPage) {
        throw new Error(
          `ESPN team schedule pagination made no progress at ${requestedNextUrl}.`,
        );
      }
      nextUrl = undefined;
      continue;
    }

    nextUrl = requestedNextUrl;
  }

  return events;
};

const formatSeriesSummary = (summary?: string): string => {
  if (!summary) return '';
  if (summary.length > 30) return summary.substring(0, 27) + '...';
  return summary;
};

const getScore = (competitor) => {
  const score = competitor?.score;
  return score?.value ?? (score != null ? Number(score) : null);
};

/**
 * Reads a competitor's win/loss/draw tally from an ESPN payload.
 *
 * ESPN exposes it under two different keys depending on the endpoint:
 * - `teams/{id}/schedule` -> `competitor.record` (singular) + `displayValue`
 * - `scoreboard` / `summary` -> `competitor.records` (plural) + `summary`
 *
 * Entries are typed: the season schedule uses `ytd` (NHL, NBA, NFL, ...) while
 * the post-season schedule and the scoreboard use `total`, so both are accepted
 * (in that priority order) before falling back on the first entry. `home` /
 * `road` entries are therefore never picked by mistake.
 *
 * Returns a bare `"W-L-T"` string: the trailing `", 109 PTS"` bonus-points
 * suffix that ESPN appends for hockey is stripped.
 */
/**
 * Normalizes an ESPN `STATUS_*` name into the game status stored in the DB.
 *
 * A plain equality whitelist is not enough: ESPN suffixes the final states with
 * the way the game ended — `STATUS_FINAL_AET` (after extra time), `STATUS_FINAL_PEN`
 * (shootout), `STATUS_FULL_TIME_2`, ... Those all fell through to the generic
 * `STATUS_*` branch and were stored as `"FINAL AET"`, a status no terminal-state
 * check recognized: `removeStaleUnresolvedGames()` then classified such a fully
 * played game (e.g. MLS `557514`, final 4-3) as "unresolved" and deleted it.
 *
 * Mapping:
 * - `FINAL` / `FULL_TIME*` -> `FINISHED`
 * - `POSTPONED*` -> `POSTPONED`, `CANCELLED*` -> `CANCELLED`
 * - `DELAYED*` / `SUSPENDED*` -> `DELAYED` (a temporary interruption, cf. `_resolveStatus`)
 * - `IN_PROGRESS*` -> `IN_PROGRESS`
 * - any other `STATUS_*` -> a readable value (`STATUS_HALFTIME` -> `"HALFTIME"`)
 * - no status at all -> `null`
 */
export const resolveScheduleGameStatus = (status?: string): string | null => {
  if (!status) return null;

  const name = status.toUpperCase();
  const withoutPrefix = name.startsWith('STATUS_')
    ? name.slice('STATUS_'.length)
    : name;

  if (
    withoutPrefix.startsWith('FINAL') ||
    withoutPrefix.startsWith('FULL_TIME')
  )
    return 'FINISHED';
  if (withoutPrefix.startsWith('POSTPONED')) return 'POSTPONED';
  if (
    withoutPrefix.startsWith('CANCELLED') ||
    withoutPrefix.startsWith('CANCELED')
  )
    return 'CANCELLED';
  if (
    withoutPrefix.startsWith('DELAYED') ||
    withoutPrefix.startsWith('SUSPENDED') ||
    withoutPrefix.startsWith('INTERRUPTED')
  )
    return 'DELAYED';
  if (withoutPrefix.startsWith('IN_PROGRESS')) return 'IN_PROGRESS';

  if (name.startsWith('STATUS_')) return withoutPrefix.replace(/_/g, ' ');

  return null;
};

export const extractCompetitorRecord = (competitor: any): string => {
  const entries = Array.isArray(competitor?.records)
    ? competitor.records
    : Array.isArray(competitor?.record)
      ? competitor.record
      : [];
  if (!entries.length) return '';

  const entry =
    entries.find((e) => e?.type === 'total') ??
    entries.find((e) => e?.type === 'ytd') ??
    entries.find((e) => !!e) ??
    null;

  const raw = entry?.summary ?? entry?.displayValue ?? '';
  return typeof raw === 'string' ? raw.split(',')[0].trim() : '';
};

/**
 * Games implied by a `"W-L-T"` record string. Used to compare two tallies for
 * the same team and keep the most complete one: a pre-season tally has fewer
 * games than the regular-season one, which has as many as the post-season
 * (frozen) one.
 */
const recordGamesPlayed = (record: string): number => {
  const match = /^(\d+)-(\d+)(?:-(\d+))?/.exec(record ?? '');
  if (!match) return -1;
  return Number(match[1]) + Number(match[2]) + Number(match[3] ?? 0);
};

/**
 * Computes the season tally of every team of a batch, and separates the tallies
 * that are **provably complete** from the ones that cannot be trusted.
 *
 * A team's tally on its last game of a season accounts for every game it played
 * in that season, so a final tally implies exactly as many games as were
 * fetched for that team. A tally implying **more** games than were fetched means
 * the season was **truncated** — ESPN quota exhausted, pagination cut short, or
 * a team fetch that silently failed — so the batch does not hold the whole
 * season and its "final" number is only an intermediate one.
 *
 * Games are de-duplicated per team by game identity, so the two rows a match
 * produces (one per `teamSelectedId`) never inflate the count.
 *
 * Returns `{ verified, truncated }`: `verified` maps `teamId` to the tally that
 * can safely be written on every game of the season, `truncated` lists the teams
 * whose tally was rejected as incomplete.
 */
export const getSeasonFinals = (
  games: any[],
): { verified: Map<string, string>; truncated: string[] } => {
  const list = (games || []).filter((game) => !!game);
  const verified = new Map<string, string>();
  const truncated: string[] = [];
  if (!list.length) return { verified, truncated };

  const gameKey = (game: any) =>
    game?.uniqueId ||
    `${game?.homeTeamId ?? ''}-${game?.awayTeamId ?? ''}-${game?.startTimeUTC ?? ''}`;

  // Distinct games held for each team.
  const gamesPerTeam = new Map<string, Set<string>>();
  for (const game of list) {
    for (const teamId of [game?.homeTeamId, game?.awayTeamId]) {
      if (!teamId) continue;
      if (!gamesPerTeam.has(teamId)) gamesPerTeam.set(teamId, new Set());
      gamesPerTeam.get(teamId)!.add(gameKey(game));
    }
  }

  // Most complete tally per team (games played only grows within a season).
  const finals = new Map<string, { gamesPlayed: number; record: string }>();
  const track = (teamId?: string, record?: string) => {
    if (!teamId || !record) return;
    const gamesPlayed = recordGamesPlayed(record);
    const current = finals.get(teamId);
    if (!current || gamesPlayed > current.gamesPlayed) {
      finals.set(teamId, { gamesPlayed, record });
    }
  };

  for (const game of list) {
    track(game?.homeTeamId, game?.homeTeamRecord);
    track(game?.awayTeamId, game?.awayTeamRecord);
  }

  for (const [teamId, { gamesPlayed, record }] of finals) {
    const fetched = gamesPerTeam.get(teamId)?.size ?? 0;
    if (gamesPlayed <= fetched) {
      verified.set(teamId, record);
    } else {
      truncated.push(teamId);
    }
  }

  return { verified, truncated };
};

export const getRecordSeasonType = (game: any): number => {
  const competition = game?.competitions?.[0];
  const rawType =
    game?.recordSeasonType ??
    game?.seasonType ??
    game?.season?.type?.id ??
    game?.season?.type?.type ??
    game?.season?.type ??
    competition?.season?.type?.id ??
    competition?.season?.type?.type ??
    competition?.season?.type;
  const type =
    typeof rawType === 'object' && rawType !== null
      ? (rawType.id ?? rawType.type ?? rawType.name ?? rawType.abbreviation)
      : rawType;
  const normalized = String(type ?? '').toLowerCase();

  if (normalized === '1' || normalized.includes('pre')) return 1;
  if (
    normalized === '3' ||
    normalized.includes('post') ||
    normalized.includes('playoff')
  ) {
    return 3;
  }
  return 2;
};

/**
 * Rewrites the per-game records produced by `getEachTeamSchedule()` so that:
 *
 * - preseason, regular season, and playoffs are independent record phases;
 * - **upcoming** games have their per-game record cleared, so the reader
 *   (`_enrichGameWithTeamData`) falls back to `team.record` — the team's current
 *   tally stored in the database and kept up to date by `syncGameWithScore()` and
 *   the records cron. A game that has not started has no meaningful pre-game
 *   tally, so the current DB record is the correct thing to display (never the
 *   placeholder `0-0-0`);
 * - a phase that has not started shows the initial `0-0-0` on **every** of its
 *   games (past and upcoming alike): it is the season's starting record, then
 *   replaced everywhere by the propagation of `GameService._propagateTeamRecordToSeasonGames()`
 *   as soon as the tally evolves;
 * - completed preseason and regular-season batches use the verified final tally;
 * - playoff records remain attached to their individual games, allowing series
 *   summaries (when available) and the record to progress across the bracket.
 *
 * PWHL is unaffected: its games are produced by `hockeyData.ts`, not by this
 * module.
 */
export const applySeasonFinalRecords = (allGames: Record<string, any[]>) => {
  const games = Object.values(allGames)
    .flat()
    .filter((game) => !!game);
  if (!games.length) return;

  const now = Date.now();
  // A game that has not started yet must display the team's *current* record,
  // which lives on the team document (`team.record`), not on this game. Clearing
  // the per-game tally makes `_enrichGameWithTeamData()` fall back to it.
  const isUpcoming = (game: any) => {
    const start = game.startTimeUTC
      ? new Date(game.startTimeUTC).getTime()
      : NaN;
    return Number.isFinite(start) && start > now;
  };
  const gamesByPhase = new Map<number, any[]>();
  for (const game of games) {
    const phase = getRecordSeasonType(game);
    if (!gamesByPhase.has(phase)) gamesByPhase.set(phase, []);
    gamesByPhase.get(phase)!.push(game);
  }

  for (const [phase, phaseGames] of gamesByPhase) {
    const phaseStarted = phaseGames.some((game) => {
      const status = String(game.gameStatus ?? '').toUpperCase();
      return (
        status === 'FINISHED' ||
        status === 'IN_PROGRESS' ||
        recordGamesPlayed(game.homeTeamRecord) > 0 ||
        recordGamesPlayed(game.awayTeamRecord) > 0
      );
    });

    if (!phaseStarted) {
      // First recording of a season: every game starts at `0-0-0` (past and
      // upcoming alike) — the record propagation
      // (`GameService._propagateTeamRecordToSeasonGames`) then replaces it
      // everywhere as soon as the tally evolves.
      for (const game of phaseGames) {
        game.homeTeamRecord = '0-0-0';
        game.awayTeamRecord = '0-0-0';
      }
      continue;
    }

    // Post-season tallies are event-specific. Do not copy the last game's
    // record onto earlier games; seriesSummary/seriesStatus carry the bracket
    // progression where ESPN provides it (for example, "CHI leads 2-0").
    if (phase === 3) {
      for (const game of phaseGames) {
        if (isUpcoming(game)) {
          game.homeTeamRecord = '';
          game.awayTeamRecord = '';
        } else {
          game.homeTeamRecord ||= '0-0-0';
          game.awayTeamRecord ||= '0-0-0';
        }
      }
      continue;
    }

    const phaseOver = phaseGames.every((game) => {
      const start = game.startTimeUTC
        ? new Date(game.startTimeUTC).getTime()
        : NaN;
      return Number.isFinite(start) && start < now;
    });

    if (phaseOver) {
      // Only tallies that account for every game in this phase are finals; a
      // truncated fetch must not freeze an intermediate number across the phase.
      const { verified, truncated } = getSeasonFinals(phaseGames);
      if (truncated.length) {
        console.warn(
          `[ESPN] Season type ${phase} looks truncated for ${truncated.length} team(s) (${truncated
            .slice(0, 5)
            .join(
              ', ',
            )}${truncated.length > 5 ? ', …' : ''}); their per-game record is left untouched.`,
        );
      }

      for (const game of phaseGames) {
        game.homeTeamRecord =
          verified.get(game.homeTeamId) ?? game.homeTeamRecord ?? '0-0-0';
        game.awayTeamRecord =
          verified.get(game.awayTeamId) ?? game.awayTeamRecord ?? '0-0-0';
      }
      continue;
    }

    // Keep ESPN's phase-specific in-progress tally for games already played.
    // Upcoming games clear their tally so the reader falls back to the team's
    // current `team.record`; a missing record on a played game means the team
    // has not yet played in this phase (never fall back to a prior phase).
    for (const game of phaseGames) {
      if (isUpcoming(game)) {
        game.homeTeamRecord = '';
        game.awayTeamRecord = '';
      } else {
        game.homeTeamRecord ||= '0-0-0';
        game.awayTeamRecord ||= '0-0-0';
      }
    }
  }
};

/**
 * Captures, for the team being fetched, the cumulative tally of the latest game
 * it has **already started**, and stores it under its `uniqueId`.
 *
 * The `untilDate` cutoff inside `getEachTeamSchedule()` drops played games from
 * a normal refresh, so the tally has to be harvested *before* that filter. This
 * is the only source for leagues whose scoreboard, summary and team detail all
 * expose no record at all (e.g. college hockey), and it costs nothing extra:
 * the schedule is already being fetched.
 */
const collectTeamRecord = (
  events: any[],
  uniqueId: string,
  espnTeamId: string,
  out?: Map<string, string>,
) => {
  if (!out || !uniqueId || !Array.isArray(events) || !events.length) return;

  const now = Date.now();
  let bestDate = 0;
  let best = '';

  for (const event of events) {
    const start = event?.date ? Date.parse(event.date) : NaN;
    // Only already-played games carry a trustworthy tally; ESPN leaves
    // `record` null on games that have not been played yet.
    if (!Number.isFinite(start) || start > now) continue;

    const competitors = event?.competitions?.[0]?.competitors;
    if (!Array.isArray(competitors)) continue;

    for (const competitor of competitors) {
      if (String(competitor?.team?.id) !== String(espnTeamId)) continue;
      const record = extractCompetitorRecord(competitor);
      if (record && start >= bestDate) {
        bestDate = start;
        best = record;
      }
    }
  }

  if (!best) return;

  // A team can be visited more than once (aggregate leagues): keep the most
  // complete tally, since games played only ever grows inside a season.
  const existing = out.get(uniqueId);
  if (!existing || recordGamesPlayed(best) >= recordGamesPlayed(existing)) {
    out.set(uniqueId, best);
  }
};

/**
 * Reads a team's current cumulative `"W-L[-T]"` record from its season schedule.
 *
 * Some ESPN feeds expose no record at all — college hockey's scoreboard and
 * summary both return `records: []` and its team detail returns
 * `record.items: []` — so `TeamService.updateRecord()` had nothing to work with
 * and those teams' tallies stayed frozen at the last team refresh. The season
 * schedule does carry the tally on every already-played event, which makes it
 * the universal fallback.
 *
 * Returns `''` when nothing usable is found (unknown league, no ESPN id, no
 * played game yet, network error).
 */
export const getTeamRecordFromSchedule = async (
  leagueKey: string,
  espnTeamId: string,
): Promise<string> => {
  const config = leagueConfigs[leagueKey];
  if (!config || !espnTeamId) return '';

  try {
    const url = `${espnAPI}${config.sport}/${config.league}/teams/${espnTeamId}/schedule?seasontype=2`;
    const res = await fetchWithRetry(url);
    if (!res.ok) return '';
    const data = await res.json();

    let latest = '';
    let latestDate = 0;
    for (const event of data?.events || []) {
      const start = event?.date ? Date.parse(event.date) : NaN;
      if (!Number.isFinite(start) || start > Date.now()) continue;
      const competitors = event?.competitions?.[0]?.competitors;
      if (!Array.isArray(competitors)) continue;
      for (const competitor of competitors) {
        if (String(competitor?.team?.id) !== String(espnTeamId)) continue;
        const record = extractCompetitorRecord(competitor);
        if (record && start >= latestDate) {
          latestDate = start;
          latest = record;
        }
      }
    }
    return latest;
  } catch {
    return '';
  }
};

const getNormalizedLeagueName = (leagueName: string) => {
  if (leagueName.includes('OLYMPICS')) {
    if (leagueName.includes('WOMEN')) return 'OLYMPICS-WOMEN';
    return 'OLYMPICS-MEN';
  }
  return leagueName;
};

export const getOlympicTeamLogo = (
  leagueName: string,
  abbreviation?: string,
): string => {
  if (!leagueName?.toUpperCase().includes('OLYMPICS') || !abbreviation) {
    return '';
  }

  const countryCode = abbreviation
    .trim()
    .replace(/[-_](?:M|W)$/i, '')
    .toLowerCase();
  if (!/^[a-z]{3}$/.test(countryCode)) return '';

  return `https://a.espncdn.com/i/teamlogos/countries/500/${countryCode}.png`;
};

const ESPNAbbrevs = {
  NHL: {
    UTAH: 'UTA',
  },
};

const OLYMPICS_HOCKEY_MEN = 'OLYMPICS-HOCKEY-MEN';
const OLYMPICS_HOCKEY_WOMEN = 'OLYMPICS-HOCKEY-WOMEN';
const OLYMPICS_BASKETBALL_MEN = 'OLYMPICS-BASKETBALL-MEN';
const OLYMPICS_BASKETBALL_WOMEN = 'OLYMPICS-BASKETBALL-WOMEN';

const aggregateLeagues = {
  'OLYMPICS-MEN': [OLYMPICS_HOCKEY_MEN, OLYMPICS_BASKETBALL_MEN],
  'OLYMPICS-WOMEN': [OLYMPICS_HOCKEY_WOMEN, OLYMPICS_BASKETBALL_WOMEN],
};

const leagueConfigs = {
  [League.NHL]: { sport: 'hockey', league: 'nhl' },
  [League.MLB]: { sport: 'baseball', league: 'mlb' },
  [League.NBA]: { sport: 'basketball', league: 'nba' },
  [League.WNBA]: { sport: 'basketball', league: 'wnba' },
  [League.NFL]: { sport: 'football', league: 'nfl' },
  [League.MLS]: { sport: 'soccer', league: 'usa.1' },
  [League.NCAAF]: { sport: 'football', league: 'college-football' },
  [League.NCAAB]: { sport: 'basketball', league: 'mens-college-basketball' },
  [League.WNCAAB]: { sport: 'basketball', league: 'womens-college-basketball' },
  [League.NCCABB]: { sport: 'baseball', league: 'college-baseball' },
  [League.NCAAMH]: { sport: 'hockey', league: 'mens-college-hockey' },
  [League.NCAAWH]: { sport: 'hockey', league: 'womens-college-hockey' },
  [League.NWSL]: { sport: 'soccer', league: 'usa.nwsl' },
  [OLYMPICS_HOCKEY_MEN]: {
    sport: 'hockey',
    league: 'olympics-mens-ice-hockey',
  },
  [OLYMPICS_HOCKEY_WOMEN]: {
    sport: 'hockey',
    league: 'olympics-womens-ice-hockey',
  },
  [OLYMPICS_BASKETBALL_MEN]: {
    sport: 'basketball',
    league: 'mens-olympics-basketball',
  },
  [OLYMPICS_BASKETBALL_WOMEN]: {
    sport: 'basketball',
    league: 'womens-olympics-basketball',
  },
};

const leaguesData = Object.fromEntries(
  Object.entries(leagueConfigs).map(([key, { sport, league }]) => {
    const base = `${espnAPI}${sport}/${league}`;
    const teamBase = `${base}/teams`;
    return [
      key,
      {
        leagueName: key,
        fetchTeam: `${teamBase}?limit=1000`,
        fetchGames: `${teamBase}/\${id}/schedule`,
        fetchDetails: `${teamBase}/`,
        fetchStandings: `${base}/standings`,
      },
    ];
  }),
);

/**
 * Division-1 root group ids per college league, as exposed by ESPN's group
 * hierarchy (`groups: { id, parent: { id } }` on the per-team detail endpoint):
 * NCAAF `80/81` (FBS + FCS, both D1), NCAAB/WNCAAB `50` ("NCAA Division I"),
 * NCCABB `26` ("NCAA Division I" of college-baseball — note `27` is the SEC
 * conference, not a division).
 *
 * ESPN does NOT always parent a team to its division: a program can be parented
 * to its conference instead (e.g. every Sun Belt team reports
 * `groups.parent.id = 37` and every SWAC team `31`), so the direct parent id
 * alone is not a reliable verdict. `resolveD1FromGroups()` therefore walks the
 * group hierarchy up to one of these roots (see `getGroupParentId()`), and a
 * team is D1 when its hierarchy passes through one of them.
 *
 * `isConference` is intentionally NOT part of the test: ESPN sets it to
 * `false` for legitimate D1 teams (e.g. every NCCABB team, LSU included)
 * and for independent D1 programs, so only the group hierarchy is reliable.
 * Women's college hockey (NCAAWH) is intentionally absent: ESPN exposes no
 * such marker there, so it is kept as-is.
 *
 * Men's college hockey (NCAAMH) is a special case: ESPN's `parent.id = 51`
 * there lumps D1, D3 and even non-NCAA (U Sports) programs together, and its
 * `isConference` flag is unreliable too, so the hierarchy alone would admit
 * non-D1 teams (Adrian, Middlebury, SUNY Cortland, Laurentian…). NCAAMH is
 * therefore filtered by an explicit allowlist (`NCAAMH_D1_TEAMS`) instead —
 * see `isD1Groups()`.
 */
export const D1_PARENT_IDS: Record<string, string[]> = {
  [CollegeLeague.NCAAF]: ['80', '81'],
  [CollegeLeague.NCAAB]: ['50'],
  [CollegeLeague.WNCAAB]: ['50'],
  [CollegeLeague.NCCABB]: ['26'],
};

/**
 * College leagues whose division ESPN cannot verify: every team — D1, D3 and
 * non-NCAA (U Sports) alike — reports the same group parent, so a per-game
 * Division 1 verdict would be a guess. The per-game filter is therefore
 * skipped for these leagues and **every fetched game is kept**.
 *
 * The teams to follow are still restricted by the explicit allowlists
 * (`NCAAMH_D1_TEAMS` / `NCAAWH_D1_TEAM_IDS`), so a schedule is only requested
 * for known D1 programs — but a fixture against an opponent the allowlist does
 * not know is kept instead of being dropped.
 */
export const UNVERIFIABLE_DIVISION_LEAGUES: ReadonlySet<string> = new Set([
  CollegeLeague.NCAAMH,
  CollegeLeague.NCAAWH,
]);

/**
 * The 64 Division-1 men's college hockey programs, by ESPN abbreviation.
 *
 * ESPN exposes no reliable D1 marker for men's college hockey: every team —
 * D1, D3 and Canadian U Sports alike — reports `groups.parent.id = "51"`, and
 * `groups.isConference` is `true` for several non-D1 programs (e.g. Findlay,
 * Wayne State, St. Olaf). This allowlist is the source of truth instead. It is
 * derived from the six D1 conferences (Big Ten, NCHC, Hockey East, ECAC, CCHA,
 * Atlantic Hockey) plus the D1 independents (Alaska Anchorage/Fairbanks,
 * Lindenwood, Long Island, Stonehill).
 *
 * Keep it in sync each season: promoted/relegated D1 programs must be added or
 * removed here.
 */
export const NCAAMH_D1_TEAMS: ReadonlySet<string> = new Set([
  // Big Ten
  'MICH',
  'MSU',
  'MINN',
  'ND',
  'OSU',
  'PSU',
  'WIS',
  // NCHC
  'ASU',
  'COLC',
  'DEN',
  'M-OH',
  'OMA',
  'UND',
  'UMD',
  'SCSU',
  'WMU',
  // Hockey East
  'BC',
  'BU',
  'CONN',
  'ME',
  'MASS',
  'MRMK',
  'NE',
  'UNH',
  'PROV',
  'UML',
  'UVM',
  // ECAC
  'BRWN',
  'CLAR',
  'COLG',
  'COR',
  'DART',
  'HARV',
  'PRIN',
  'QUIN',
  'RPI',
  'UNNY',
  'USL',
  'YALE',
  // CCHA
  'AUSD',
  'BGSU',
  'BST',
  'FRST',
  'LSS',
  'MNST',
  'MTU',
  'NMI',
  'STMN',
  // Atlantic Hockey
  'AIC',
  'AF',
  'ARMY',
  'BENT',
  'CAN',
  'HC',
  'MERC',
  'NIA',
  'RIT',
  'RMU',
  'SHU',
  // Independents
  'AKFB',
  'UAA',
  'LIN',
  'LIU',
  'STO',
]);

/**
 * NCAA women's hockey has no usable ESPN division marker: D1, D2 and D3 teams
 * all report group 51. Keep the current D1 ESPN team IDs explicitly listed.
 * Update this set when the NCAA D1 roster changes.
 */
export const NCAAWH_D1_TEAM_IDS: ReadonlySet<string> = new Set([
  '132',
  '103',
  '104',
  '225',
  '2137',
  '2142',
  '172',
  '159',
  '108',
  '107',
  '2815',
  '2341',
  '311',
  '2385',
  '2771',
  '134',
  '135',
  '2364',
  '160',
  '315',
  '155',
  '111',
  '194',
  '213',
  '163',
  '2507',
  '2514',
  '178',
  '2528',
  '2523',
  '2529',
  '2594',
  '2779',
  '2900',
  '284',
  '183',
  '41',
  '2785',
  '261',
  '275',
  '43',
]);

/**
 * Whether an ESPN team-detail `groups` object marks a Division 1 team by its
 * DIRECT group parent id. Synchronous and network-free, so it only decides
 * the hockey allowlists and reports `true` on missing info: the parent-id
 * leagues are actually decided by `resolveD1FromGroups()` (same allowlist
 * delegation, but the group hierarchy is walked because ESPN parents many
 * teams to their conference instead of their division).
 * Returns `true` when there is no `groups` info (transient fetch failure):
 * a team must never be dropped on a network error, only on positive proof
 * that it plays outside D1.
 *
 * For men's college hockey (NCAAMH) the group parent id is not trustworthy, so
 * the decision is delegated to the explicit `NCAAMH_D1_TEAMS` allowlist; a
 * team is kept only when its abbreviation is listed there.
 * Women's college hockey uses an explicit ESPN team-id allowlist because ESPN
 * exposes no reliable division marker for that league.
 */
export const isD1Groups = (
  leagueName: string,
  groups?: { id: string; parent?: { id: string }; isConference?: boolean },
  teamAbbrev?: string,
  teamId?: string,
): boolean => {
  if (leagueName === CollegeLeague.NCAAMH) {
    // No groups info (transient failure): keep, never drop on a network error.
    if (!groups && !teamAbbrev) return true;
    return !!teamAbbrev && NCAAMH_D1_TEAMS.has(teamAbbrev);
  }
  if (leagueName === CollegeLeague.NCAAWH) {
    return !!teamId && NCAAWH_D1_TEAM_IDS.has(teamId);
  }
  const d1Parents = D1_PARENT_IDS[leagueName];
  if (!d1Parents) return true;
  if (!groups) return true;
  return !!(groups.parent?.id && d1Parents.includes(groups.parent.id));
};

const ESPN_DIVISION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const espnDivisionCache = new Map<
  string,
  { isD1: boolean; checkedAt: number }
>();

const getTeamRecord = async (
  leagueName: string,
  id: string,
): Promise<{
  record?: { wins: number; losses: number; ties?: number; otLosses?: number };
  groups?: { id: string; parent?: { id: string }; isConference?: boolean };
  // True when ESPN could not be reached or answered a non-2xx / team-less
  // payload (e.g. `{"code":404}` for an id the detail endpoint does not know).
  // Lets callers tell a fetch failure apart from "the payload has no groups".
  fetchFailed?: boolean;
}> => {
  try {
    const url = leaguesData[leagueName].fetchDetails + id;
    const fetchedTeams = await fetchWithRetry(url);
    if (!fetchedTeams.ok) {
      return { fetchFailed: true };
    }
    const fetchTeams = await fetchedTeams.json();
    const team = fetchTeams?.team;
    if (!team) {
      return { fetchFailed: true };
    }

    let record;
    if (team.record?.items) {
      const total = team.record.items.find((i) => i.type === 'total');
      if (total?.stats) {
        const wins = total.stats.find((s) => s.name === 'wins')?.value;
        const losses = total.stats.find((s) => s.name === 'losses')?.value;
        const ties = total.stats.find((s) => s.name === 'ties')?.value;
        const otLosses = total.stats.find((s) => s.name === 'otLosses')?.value;
        record = { wins, losses, ties, otLosses };
      }
    }

    return { record, groups: team.groups };
  } catch {
    return { fetchFailed: true };
  }
};

/**
 * Full ESPN roster of a college league (`teams?limit=1000`), keyed by ESPN
 * team id with each team's `groups`. Second source of truth used when the
 * per-team detail endpoint cannot verify an opponent (it answers 404 for ids
 * it does not know). NOTE: ESPN stopped shipping `groups` on this endpoint
 * (0/762 NCAAF entries in late 2026), so callers must treat a fetched roster
 * whose entries all lack `groups` as unproven (fail-open), not as proof of
 * non-D1. The roster is cached for six hours; a failed fetch is
 * remembered for one minute so a whole crawl does not storm ESPN during an
 * outage. Returns `null` when the roster could not be fetched, so callers can
 * tell "the roster says the id is unknown" from "the roster was unavailable".
 */
const ESPN_ROSTER_GROUPS_TTL_MS = 6 * 60 * 60 * 1000;
const ESPN_ROSTER_RETRY_AFTER_FAILURE_MS = 60 * 1000;
type ESPNTeamGroups = {
  id: string;
  parent?: { id: string };
  isConference?: boolean;
};
const espnRosterGroupsCache = new Map<
  string,
  { groupsById: Map<string, ESPNTeamGroups> | null; checkedAt: number }
>();

const getLeagueTeamGroups = async (
  leagueName: string,
): Promise<Map<string, ESPNTeamGroups> | null> => {
  if (!leaguesData[leagueName]) return null;

  const cached = espnRosterGroupsCache.get(leagueName);
  if (cached) {
    const ttl = cached.groupsById
      ? ESPN_ROSTER_GROUPS_TTL_MS
      : ESPN_ROSTER_RETRY_AFTER_FAILURE_MS;
    if (Date.now() - cached.checkedAt < ttl) return cached.groupsById;
  }

  try {
    const res = await fetchWithRetry(leaguesData[leagueName].fetchTeam);
    if (!res.ok) {
      espnRosterGroupsCache.set(leagueName, {
        groupsById: null,
        checkedAt: Date.now(),
      });
      return null;
    }
    const data = await res.json();
    const teams = data?.sports?.[0]?.leagues?.[0]?.teams;
    if (!Array.isArray(teams)) {
      espnRosterGroupsCache.set(leagueName, {
        groupsById: null,
        checkedAt: Date.now(),
      });
      return null;
    }
    const groupsById = new Map<string, ESPNTeamGroups>();
    for (const entry of teams) {
      const team = entry?.team;
      if (!team?.id) continue;
      groupsById.set(String(team.id), team.groups);
    }
    espnRosterGroupsCache.set(leagueName, {
      groupsById,
      checkedAt: Date.now(),
    });
    return groupsById;
  } catch {
    espnRosterGroupsCache.set(leagueName, {
      groupsById: null,
      checkedAt: Date.now(),
    });
    return null;
  }
};

// ESPN's core API exposes the group hierarchy of a league
// (`.../v2/sports/{sport}/leagues/{league}/seasons/{year}/types/2/groups/{id}`
// → `{ id, name, parent: { $ref: ".../groups/{parentId}" } }`), which the
// site.api team detail does not: the roster (`teams?limit=1000`) no longer
// carries any `groups` field at all (0/762 entries in late 2026) and the
// detail endpoint parents many teams to their conference instead of their
// division (Sun Belt `37`, SWAC `31`, SEC `27`, …). Walking this hierarchy is
// therefore the only way to tell "conference-parented D1 team" from "D2/D3/
// NAIA program" — e.g. `167 (Sun Belt East) → 37 (Sun Belt) → 80 (FBS)`.
const ESPN_CORE_API = 'https://sports.core.api.espn.com/v2/sports';

const ESPN_GROUP_META_TTL_MS = 6 * 60 * 60 * 1000;
const ESPN_GROUP_META_RETRY_AFTER_FAILURE_MS = 60 * 1000;
// Safety bound: real chains are at most 4 hops long (division → conference →
// FBS/FCS → NCAA Division I). Anything deeper (or cyclic) is unverifiable.
const ESPN_GROUP_CHAIN_MAX_HOPS = 8;
const espnGroupMetaCache = new Map<
  string,
  { ok: boolean; parentId: string | null; checkedAt: number }
>();

/**
 * Parent group id of one ESPN group, via the core API's group hierarchy.
 * Resolves `string` (has a parent), `null` (the group is a root, e.g. NAIA
 * `186` or "NCAA Football" `99`) or `undefined` (could not verify — ESPN
 * unreachable, unknown league or unusable payload; callers must fail open).
 * Successful answers are cached six hours, failures sixty seconds so an
 * outage does not storm ESPN during a crawl. The current and previous season
 * are tried because the season-ful path is the only stable one and its year
 * must exist for the league.
 */
const getGroupParentId = async (
  leagueName: string,
  groupId: string,
): Promise<string | null | undefined> => {
  const config = leagueConfigs[leagueName];
  if (!config) return undefined;

  const cacheKey = `${leagueName}:${groupId}`;
  const cached = espnGroupMetaCache.get(cacheKey);
  if (cached) {
    const ttl = cached.ok
      ? ESPN_GROUP_META_TTL_MS
      : ESPN_GROUP_META_RETRY_AFTER_FAILURE_MS;
    if (Date.now() - cached.checkedAt < ttl) {
      return cached.ok ? cached.parentId : undefined;
    }
  }

  const year = new Date().getFullYear();
  for (const season of [String(year), String(year - 1)]) {
    const url = `${ESPN_CORE_API}/${config.sport}/leagues/${config.league}/seasons/${season}/types/2/groups/${groupId}`;
    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) continue;
      const data = await res.json();
      // A usable group payload always carries its own id; anything else (e.g.
      // an error body with HTTP 200) proves nothing.
      if (String(data?.id ?? '') !== groupId) continue;
      const parentRef = data?.parent?.$ref;
      const parentId =
        data?.parent?.id ??
        (typeof parentRef === 'string'
          ? parentRef.match(/\/groups\/(\d+)/)?.[1]
          : undefined);
      espnGroupMetaCache.set(cacheKey, {
        ok: true,
        parentId: parentId ?? null,
        checkedAt: Date.now(),
      });
      return parentId ?? null;
    } catch {
      // Try the other season before giving up.
    }
  }

  espnGroupMetaCache.set(cacheKey, {
    ok: false,
    parentId: null,
    checkedAt: Date.now(),
  });
  return undefined;
};

/**
 * Walks a team's group hierarchy up to a D1 root (`D1_PARENT_IDS[league]`).
 * Resolves `true` / `false` when the hierarchy proves the verdict — a team is
 * D1 when any node on the path `groups.id → groups.parent → …` is a D1 root —
 * and `undefined` when ESPN could not supply the hierarchy (fail open
 * upstream: never drop a team on missing info). Starting at `groups.id`
 * matters: ESPN reports the division as the group id for some leagues (e.g.
 * baseball Tennessee `{ id: 26 (D1), parent: 25 }`) and as the parent for
 * others (e.g. basketball `{ id: 2, parent: 50 }`); the id's chain always
 * contains the parent chain, so it covers both shapes.
 */
const resolveD1ViaGroupHierarchy = async (
  leagueName: string,
  startGroupId: string,
): Promise<boolean | undefined> => {
  const d1Parents = D1_PARENT_IDS[leagueName];
  if (!d1Parents) return true;

  const seen = new Set<string>();
  let currentId: string | undefined = startGroupId;
  for (let hops = 0; currentId && hops < ESPN_GROUP_CHAIN_MAX_HOPS; hops++) {
    if (d1Parents.includes(currentId)) return true;
    if (seen.has(currentId)) return undefined;
    seen.add(currentId);
    const parentId = await getGroupParentId(leagueName, currentId);
    if (parentId === undefined) return undefined;
    if (parentId === null) return false; // reached a non-D1 root
    currentId = parentId;
  }
  // Pathologically deep or cyclic hierarchy: unverifiable, not non-D1.
  return undefined;
};

/**
 * Division verdict from an ESPN team `groups` payload (detail endpoint or a
 * roster entry that still carries one). Delegates the hockey allowlists and
 * leagues without a division marker to `isD1Groups()` (always decisive);
 * for the parent-id leagues it answers `true`/`false` when the group
 * hierarchy proves the verdict and `undefined` when it cannot (no `groups`
 * at all, or ESPN's hierarchy unreachable — callers fail open on `undefined`).
 */
const resolveD1FromGroups = async (
  leagueName: string,
  groups?: ESPNTeamGroups,
  teamAbbrev?: string,
  teamId?: string,
): Promise<boolean | undefined> => {
  if (
    leagueName === CollegeLeague.NCAAMH ||
    leagueName === CollegeLeague.NCAAWH ||
    !D1_PARENT_IDS[leagueName]
  ) {
    return isD1Groups(leagueName, groups, teamAbbrev, teamId);
  }
  if (!groups) return undefined;

  const d1Parents = D1_PARENT_IDS[leagueName];
  // Fast path: the direct parent (or the group itself) already is a D1 root —
  // the common case (every NCAAB team, FBS/FCS-parented football teams), no
  // hierarchy fetch needed.
  if (groups.parent?.id && d1Parents.includes(groups.parent.id)) {
    return true;
  }
  if (groups.id && d1Parents.includes(groups.id)) {
    return true;
  }
  const startGroupId = groups.id ?? groups.parent?.id;
  if (!startGroupId) return undefined;
  return resolveD1ViaGroupHierarchy(leagueName, startGroupId);
};

/** Whether a fetched league roster carries `groups` for at least one team. */
const rosterCarriesGroupInfo = (
  rosterGroups: Map<string, ESPNTeamGroups>,
): boolean => [...rosterGroups.values()].some((entry) => entry !== undefined);

/**
 * Test hook: clears the module-level division / roster caches so each spec can
 * start from a known state. NEVER call from production code.
 */
export const resetESPNDivisionCachesForTests = (): void => {
  espnDivisionCache.clear();
  espnRosterGroupsCache.clear();
  espnGroupMetaCache.clear();
};

/**
 * Division-1 verdict for one team, cached for six hours once it has been
 * actually verified (ESPN's detail endpoint, the group hierarchy, the league
 * roster fallback, or an allowlist decided).
 *
 * Never throws when ESPN cannot verify the team: the per-team detail endpoint
 * answers HTTP 404 for ids it does not know (small non-D1 opponents such as
 * St. Francis IL, or programs too recent for the endpoint such as Little Rock)
 * and a transient fetch failure is indistinguishable downstream. Throwing there
 * aborted the WHOLE league refresh and lost every valid schedule of that
 * league. Instead the verification degrades in four steps:
 *   1. detail endpoint has `groups` → the group hierarchy is walked to a D1
 *      root (a team can be parented to its conference — Sun Belt `37`, SWAC
 *      `31` — so the direct parent id alone is not decisive) via the core
 *      API's group metadata, cached six hours;
 *   2. detail inconclusive (fetch failed / no `groups`) → the league roster
 *      (`teams?limit=1000`) is consulted as a second source: a roster entry
 *      that still carries `groups` decides the same way; an id absent from a
 *      successfully fetched roster that carries division info is non-D1 (no
 *      D1 program of a college league is unknown to both ESPN sources);
 *   3. the roster is fetched but carries no `groups` for ANY team (its actual
 *      state since ESPN removed the field) → it proves nothing, so the team is
 *      kept fail-open with a warning and nothing is cached;
 *   4. even the roster is unreachable (network outage) → same fail-open.
 * One unverifiable team never aborts the league refresh and is re-verified on
 * the next refresh.
 */
export const isD1ScheduleTeam = async (
  leagueName: string,
  id: string,
  abbrev?: string,
): Promise<boolean> => {
  const cacheKey = `${leagueName}:${id}`;
  const cached = espnDivisionCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < ESPN_DIVISION_CACHE_TTL_MS) {
    return cached.isD1;
  }

  let isD1: boolean;
  if (leagueName === CollegeLeague.NCAAMH) {
    isD1 = isD1Groups(leagueName, undefined, abbrev);
  } else if (leagueName === CollegeLeague.NCAAWH) {
    isD1 = isD1Groups(leagueName, undefined, undefined, id);
  } else {
    const { groups, fetchFailed } = await getTeamRecord(leagueName, id);
    let verdict = await resolveD1FromGroups(leagueName, groups, abbrev, id);
    let rosterGroups: Map<string, ESPNTeamGroups> | null = null;

    if (verdict === undefined) {
      // Detail inconclusive (fetch failed, payload without `groups`, or the
      // group hierarchy unreachable). Consult the league roster as a second
      // source of truth.
      rosterGroups = await getLeagueTeamGroups(leagueName);
      const rosterEntry = rosterGroups?.get(id);
      if (rosterEntry) {
        verdict = await resolveD1FromGroups(
          leagueName,
          rosterEntry,
          abbrev,
          id,
        );
      } else if (rosterGroups && rosterCarriesGroupInfo(rosterGroups)) {
        // The roster was fetched, carries division info for other teams, but
        // knows nothing about this id: no D1 program of a college league is
        // unknown to both ESPN sources, so the team is provably non-D1.
        verdict = false;
      }
    }

    if (verdict === undefined) {
      // Neither ESPN source could prove anything (the roster carries no
      // `groups` at all these days, or was unreachable). Fail open so no team
      // is dropped on missing info, and do not cache the verdict so the next
      // refresh re-verifies.
      console.warn(
        `[Schedule] ${leagueName} team ${id}${abbrev ? ` (${abbrev})` : ''}: ESPN returned no resolvable group hierarchy` +
          (fetchFailed ? ' (team detail fetch failed)' : '') +
          ` and the league roster was ${
            rosterGroups
              ? 'fetched but carries no division info'
              : 'unavailable'
          }; assuming Division I (fail-open) and not caching the verdict.`,
      );
      return true;
    }
    isD1 = verdict;
  }

  espnDivisionCache.set(cacheKey, { isD1, checkedAt: Date.now() });
  return isD1;
};

const getD1ScheduleTeamIds = async (
  leagueName: string,
  teams: TeamType[],
): Promise<Set<string> | undefined> => {
  if (
    !D1_PARENT_IDS[leagueName] &&
    leagueName !== CollegeLeague.NCAAMH &&
    leagueName !== CollegeLeague.NCAAWH
  ) {
    return undefined;
  }

  const d1TeamIds = new Set<string>();
  const nonD1Teams: TeamType[] = [];
  const concurrencyLimit = 4;

  for (let start = 0; start < teams.length; start += concurrencyLimit) {
    if (start > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, ESPN_TEAM_BATCH_DELAY_MS),
      );
    }

    const batch = teams.slice(start, start + concurrencyLimit);
    await Promise.all(
      batch.map(async (team) => {
        const id = String(team.id || '');
        if (!id) {
          throw new Error(
            `[Schedule] Cannot verify Division I status for ${leagueName} team ${team.uniqueId}: ESPN id is missing.`,
          );
        }

        const abbrev =
          team.abbrev || team.uniqueId?.split('-').slice(1).join('-');
        const isD1 = await isD1ScheduleTeam(leagueName, id, abbrev);

        if (isD1) {
          d1TeamIds.add(id);
        } else {
          nonD1Teams.push(team);
        }
      }),
    );
  }

  if (nonD1Teams.length > 0) {
    console.info(
      `[Schedule] ${leagueName}: skipped ${nonD1Teams.length} non-D1 team(s): ${nonD1Teams
        .map((team) => team.uniqueId)
        .join(', ')}.`,
    );
  }

  return d1TeamIds;
};

type D1ScheduleDiagnostics = {
  excludedGames: Map<
    string,
    { opponents: Set<string>; sourceSchedules: Set<string> }
  >;
  invalidGames: Map<string, number>;
};

const getESPNStandings = async (leagueName: string) => {
  try {
    const url = leaguesData[leagueName].fetchStandings;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    const records = {};

    const traverse = (node) => {
      if (node.standings?.entries) {
        node.standings.entries.forEach((entry) => {
          const teamId = entry.team.id;
          const stats = entry.stats;
          if (stats) {
            const wins = stats.find((s) => s.name === 'wins')?.value;
            const losses = stats.find((s) => s.name === 'losses')?.value;
            const ties = stats.find((s) => s.name === 'ties')?.value;
            records[teamId] = { wins, losses, ties };
          }
        });
      }
      if (node.children) {
        node.children.forEach((child) => traverse(child));
      }
    };

    traverse(data);
    return records;
  } catch (error) {
    console.error('Error fetching ESPN standings:', error);
    return {};
  }
};

export const getESPNTeams = async (leagueName: string): Promise<TeamType[]> => {
  try {
    // Handle aggregate leagues (e.g. OLYMPICS-WOMEN)
    if (aggregateLeagues[leagueName]) {
      let allTeams: TeamType[] = [];
      for (const subLeague of aggregateLeagues[leagueName]) {
        const teams = await getESPNTeams(subLeague);
        allTeams = [...allTeams, ...teams];
      }
      return allTeams;
    }
    if (!leaguesData[leagueName]) return [];
    const fetchTeams = await fetchJsonOrNull(leaguesData[leagueName].fetchTeam);
    if (!fetchTeams) return [];
    const { sports } = fetchTeams;
    if (!sports) return [];
    const { leagues } = sports[0];
    const allTeams: ESPNTeam[] = leagues[0].teams || [];
    const standings = await getESPNStandings(leagueName);

    if (allTeams.length === 0 && leagueName.includes('OLYMPICS')) {
      try {
        const url = leaguesData[leagueName].fetchStandings;
        const data = await fetchJsonOrNull(url);
        if (!data) {
          console.warn(
            `[ESPN] Skipping standings fallback for ${leagueName}: non-JSON or HTTP error`,
          );
        } else {
          const traverse = (node) => {
            if (node.standings?.entries) {
              node.standings.entries.forEach((entry) => {
                if (entry.team) {
                  if (!allTeams.find((t) => t.team.id === entry.team.id)) {
                    allTeams.push({ team: entry.team });
                  }
                }
              });
            }
            if (node.children) {
              node.children.forEach((child) => traverse(child));
            }
          };
          traverse(data);
        }
      } catch (error) {
        console.error('Error fetching standings for teams fallback:', error);
      }
    }

    if (
      (allTeams.length === 0 && leagueName.includes('OLYMPICS')) ||
      CollegeLeague.hasOwnProperty(leagueName)
    ) {
      const currentYear = new Date().getFullYear();
      try {
        const { sport, league } = leagueConfigs[leagueName];
        const url = `${espnAPI}${sport}/${league}/scoreboard?dates=${currentYear}&limit=1000`;
        const res = await fetchWithRetry(url);
        const data = await res.json();
        const events = data.events || [];
        events.forEach((event) => {
          event.competitions?.[0]?.competitors?.forEach((comp) => {
            if (
              comp.team &&
              !allTeams.some((t) => t.team.id === comp.team.id)
            ) {
              allTeams.push({ team: comp.team });
            }
          });
        });
      } catch (error) {
        console.error('Error fetching scoreboard for teams fallback:', error);
      }
    }

    const activeTeams: TeamType[] = allTeams
      .filter(({ team }) => {
        if (leagueName.includes('OLYMPICS')) return true;
        return team.isActive;
      })
      .sort((a, b) =>
        (a.team.slug || a.team.id) > (b.team.slug || b.team.id) ? 1 : -1,
      )
      .map(({ team }) => {
        const {
          abbreviation,
          displayName,
          logos,
          nickname,
          id,
          color,
          alternateColor,
        } = team;
        let teamID = abbreviation || id;

        if (ESPNAbbrevs[leagueName]?.[teamID]) {
          teamID = ESPNAbbrevs[leagueName][teamID];
        }
        const normalizedLeagueName = getNormalizedLeagueName(leagueName);
        const uniqueId = `${leagueName}-${teamID}`;
        // ESPN sometimes returns no logos; fall back to our manual list if we
        // have an entry for this abbreviation. the abbreviation is the second
        // part of the uniqueId when saved in the database.
        const teamLogo =
          getESPNTeamLogo(team) ||
          UniversityLogos[teamID] ||
          getOlympicTeamLogo(leagueName, teamID);
        const teamLogoDark =
          logos?.find(
            (l) => l.rel?.includes('dark') && l.rel?.includes('scoreboard'),
          )?.href ||
          teamLogo ||
          UniversityLogos[teamID] ||
          '';

        const record = standings[id];

        // University teams sometimes come without colors from ESPN. The shared
        // resolver falls back to the same university in another college league
        // (e.g. NCAAB-X -> NCAAF-X) before using the default placeholder.
        const fallbackColors = getTeamColors(uniqueId);
        let colorTeam = color ? '#' + color : fallbackColors.color;
        let backgroundColorTeam = alternateColor
          ? '#' + alternateColor
          : fallbackColors.backgroundColor;

        // Safeguard: ESPN sometimes returns color === alternateColor (or an
        // entry that collapses into the fallback); such a pair is unusable, so
        // keep the resolved fallback colors instead.
        if (colorTeam.toLowerCase() === backgroundColorTeam.toLowerCase()) {
          colorTeam = fallbackColors.color;
          backgroundColorTeam = fallbackColors.backgroundColor;
        }

        if (getLuminance(colorTeam) < getLuminance(backgroundColorTeam)) {
          const temp = colorTeam;
          colorTeam = backgroundColorTeam;
          backgroundColorTeam = temp;
        }

        return {
          uniqueId,
          id: id,
          abbrev: teamID,
          label: capitalize(displayName),
          teamLogo,
          teamLogoDark,
          teamCommonName: capitalize(nickname || displayName),
          league: normalizedLeagueName.toUpperCase(),
          color: colorTeam,
          backgroundColor: backgroundColorTeam,
          wins: record?.wins,
          losses: record?.losses,
          ties: record?.ties,
        };
      });

    // College leagues: keep Division 1 teams only. `getTeamRecord()` hits the
    // per-team detail endpoint, which exposes `groups`; the verdict walks the
    // ESPN group hierarchy (a team can be parented to its conference — Sun
    // Belt `37`, SWAC `31` — so the direct parent id alone is not decisive).
    // A team is dropped only on positive proof it plays outside D1 (see
    // `resolveD1FromGroups()`); an unverifiable team stays fail-open during
    // discovery so a transient outage does not erase it. NCAAWH is excluded
    // (ESPN exposes no D1 marker there) and non-college leagues are
    // unaffected.
    const filteredTeams: TeamType[] = [];
    for (const team of activeTeams) {
      const { record, groups } = await getTeamRecord(leagueName, team.id);
      if (record) {
        (team as any).wins = record.wins;
        (team as any).losses = record.losses;
        (team as any).ties = record.ties;
        if (record.otLosses !== undefined) {
          (team as any).otLosses = record.otLosses;
        }
      }
      const verdict = await resolveD1FromGroups(
        leagueName,
        groups,
        team.abbrev,
        team.id,
      );
      if (verdict !== false) {
        filteredTeams.push(team);
      } else {
        console.info(
          `[Teams] ${leagueName}: skipping non-D1 team ${team.uniqueId} (group ${groups?.id}, parent ${groups?.parent?.id}).`,
        );
      }
    }

    return filteredTeams;
  } catch (error) {
    console.error('Error fetching data =>', error);
    return [];
  }
};

/**
 * Discovers every team that appeared in an Olympic scoreboard for a season.
 * Olympic rosters change between editions, so the current team list is not a
 * sufficient source for historical schedule recovery.
 */
export const getOlympicSeasonTeams = async (
  leagueName: string,
  season: number,
): Promise<TeamType[]> => {
  const sourceLeagues = aggregateLeagues[leagueName] || [leagueName];
  const discovered = new Map<string, TeamType>();
  const normalizedLeagueName =
    getNormalizedLeagueName(leagueName).toUpperCase();

  for (const sourceLeague of sourceLeagues) {
    const config = leagueConfigs[sourceLeague];
    if (!config) continue;

    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const url = `${espnAPI}${config.sport}/${config.league}/scoreboard?dates=${season}&limit=1000&page=${page}`;
      const data = await fetchJsonOrNull(url);
      if (!data) break;

      const events = data.events || [];
      for (const event of events) {
        for (const competitor of event.competitions?.[0]?.competitors || []) {
          const team = competitor?.team;
          if (!team?.id) continue;

          const abbrev = team.abbreviation || team.id;
          const uniqueId = `${sourceLeague}-${abbrev}`;
          if (discovered.has(uniqueId)) continue;

          const fallbackColors = getTeamColors(uniqueId);
          let color = team.color ? `#${team.color}` : fallbackColors.color;
          let backgroundColor = team.alternateColor
            ? `#${team.alternateColor}`
            : fallbackColors.backgroundColor;
          if (color.toLowerCase() === backgroundColor.toLowerCase()) {
            color = fallbackColors.color;
            backgroundColor = fallbackColors.backgroundColor;
          }
          if (getLuminance(color) < getLuminance(backgroundColor)) {
            [color, backgroundColor] = [backgroundColor, color];
          }

          const teamLogo =
            getESPNTeamLogo(team) ||
            UniversityLogos[abbrev] ||
            getOlympicTeamLogo(sourceLeague, abbrev);
          discovered.set(uniqueId, {
            uniqueId,
            id: String(team.id),
            abbrev,
            label: capitalize(team.displayName || team.name || abbrev),
            teamLogo,
            teamLogoDark:
              team.logos?.find(
                (logo) =>
                  logo.rel?.includes('dark') &&
                  logo.rel?.includes('scoreboard'),
              )?.href ||
              teamLogo ||
              '',
            teamCommonName: capitalize(
              team.nickname || team.displayName || team.name || abbrev,
            ),
            league: normalizedLeagueName,
            color,
            backgroundColor,
            isActive: false,
          });
        }
      }

      hasMore = events.length === 1000;
      page++;
    }
  }

  return [...discovered.values()];
};

export const getTeamsSchedule = async (
  activeTeams,
  leagueName,
  leagueLogos,
  forceUpdate = false,
  season?: number,
  teamRecords?: Map<string, string>,
) => {
  const allGames = {};
  const concurrencyLimit = 2;
  const d1Diagnostics: D1ScheduleDiagnostics = {
    excludedGames: new Map(),
    invalidGames: new Map(),
  };
  let d1TeamIds: Set<string> | undefined;
  try {
    d1TeamIds = await getD1ScheduleTeamIds(leagueName, activeTeams);
  } catch (error) {
    for (const team of activeTeams) {
      console.info(
        `[Schedule] ${leagueName} ${team.label || team.uniqueId}: 0 game(s) fetched (team division could not be verified; refresh aborted).`,
      );
    }
    console.info(
      `[Schedule] ${leagueName}: fetched schedules for 0 team(s), 0 distinct game(s) across those schedules; division verification failed, league refresh aborted.`,
    );
    throw error;
  }
  const teamsToFetch =
    d1TeamIds === undefined
      ? activeTeams
      : activeTeams.filter((team) => d1TeamIds.has(String(team.id)));
  const scheduleErrors: unknown[] = [];

  if (d1TeamIds) {
    for (const team of activeTeams) {
      if (!d1TeamIds.has(String(team.id))) {
        allGames[team.uniqueId] = [];
        console.info(
          `[Schedule] ${leagueName} ${team.label || team.uniqueId}: 0 game(s) fetched (non-D1 team skipped).`,
        );
      }
    }
  }

  for (let start = 0; start < teamsToFetch.length; start += concurrencyLimit) {
    // Pace the crawl: a short gap between batches keeps ESPN's Akamai edge from
    // rate-limiting / bot-blocking us (transient 403 "Access Denied" pages) when
    // the oldies recovery fires hundreds of team-schedule calls in a row.
    if (start > 0 && ESPN_TEAM_BATCH_DELAY_MS > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, ESPN_TEAM_BATCH_DELAY_MS),
      );
    }
    const batch = teamsToFetch.slice(start, start + concurrencyLimit);
    await Promise.all(
      batch.map(async ({ id, abbrev, uniqueId, label }) => {
        const leagueID = `${uniqueId}`;
        try {
          const teamGames = await getEachTeamSchedule(
            {
              id,
              abbrev,
              teamUniqueId: uniqueId,
              leagueName,
              leagueLogos,
            },
            forceUpdate,
            season,
            teamRecords,
            d1TeamIds,
            d1Diagnostics,
          );
          allGames[leagueID] = teamGames;
          console.info(
            `[Schedule] ${leagueName} ${label || uniqueId}: ${teamGames.length} game(s) fetched.`,
          );
        } catch (error) {
          scheduleErrors.push(error);
          allGames[leagueID] = [];
          console.error(
            `[Schedule] ${leagueName} ${label || uniqueId}: schedule fetch failed; league refresh will be aborted.`,
            error,
          );
          console.info(
            `[Schedule] ${leagueName} ${label || uniqueId}: 0 game(s) fetched (request failed; league refresh aborted).`,
          );
        }
      }),
    );
  }

  // Normalize records independently for preseason, regular season, and playoffs.
  applySeasonFinalRecords(allGames);

  const fetchedGames = Object.values(allGames).flat() as any[];
  const distinctGames = new Set(
    fetchedGames.map((game) =>
      game?.startTimeUTC && game?.homeTeamId && game?.awayTeamId
        ? `${game.startTimeUTC}|${game.homeTeamId}|${game.awayTeamId}`
        : game?.uniqueId,
    ),
  );
  console.info(
    `[Schedule] ${leagueName}: fetched schedules for ${teamsToFetch.length} team(s), ${distinctGames.size} distinct game(s) across those schedules.` +
      (scheduleErrors.length
        ? ` ${scheduleErrors.length} team schedule request(s) failed; league refresh aborted.`
        : ''),
  );
  if (d1Diagnostics.excludedGames.size > 0) {
    const excludedGames = [...d1Diagnostics.excludedGames.values()];
    const opponentCounts = new Map<string, number>();
    const sourceSchedules = new Set<string>();
    for (const excludedGame of excludedGames) {
      for (const opponent of excludedGame.opponents) {
        opponentCounts.set(opponent, (opponentCounts.get(opponent) ?? 0) + 1);
      }
      for (const sourceSchedule of excludedGame.sourceSchedules) {
        sourceSchedules.add(sourceSchedule);
      }
    }
    const topOpponents = [...opponentCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([opponent, count]) => `${opponent} (${count})`);
    const omittedOpponents = opponentCounts.size - topOpponents.length;
    const opponentSummary =
      topOpponents.join(', ') +
      (omittedOpponents > 0 ? `, and ${omittedOpponents} more` : '');
    console.info(
      `[Schedule] ${leagueName}: excluded ${excludedGames.length} distinct game(s) with no participant verified as D1 across ${sourceSchedules.size} team schedule(s); opponents: ${opponentSummary}.`,
    );
  }
  if (d1Diagnostics.invalidGames.size > 0) {
    const invalidEvents = [...d1Diagnostics.invalidGames.values()].reduce(
      (total, count) => total + count,
      0,
    );
    console.warn(
      `[Schedule] ${leagueName}: skipped ${invalidEvents} game occurrence(s) with invalid or missing competitor data across ${d1Diagnostics.invalidGames.size} team schedule(s).`,
    );
  }
  if (scheduleErrors.length > 0) {
    throw new Error(
      `[Schedule] ${leagueName}: ${scheduleErrors.length} team schedule request(s) failed; refusing to return a partial league schedule.`,
    );
  }
  return allGames;
};

const getEachTeamSchedule = async (
  { id, abbrev, teamUniqueId, leagueName, leagueLogos },
  forceUpdate = false,
  season?: number,
  teamRecords?: Map<string, string>,
  d1TeamIds?: Set<string>,
  d1Diagnostics?: D1ScheduleDiagnostics,
) => {
  try {
    const normalizedLeagueName = getNormalizedLeagueName(leagueName);
    if (aggregateLeagues[leagueName]) {
      let allGames = [];
      for (const subLeague of aggregateLeagues[leagueName]) {
        if (!teamUniqueId.startsWith(`${subLeague}-`)) continue;
        const games = await getEachTeamSchedule(
          {
            id,
            abbrev,
            teamUniqueId,
            leagueName: subLeague,
            leagueLogos,
          },
          forceUpdate,
          season,
          teamRecords,
          d1TeamIds,
          d1Diagnostics,
        );
        allGames = [...allGames, ...games];
      }
      return allGames;
    }

    // `leaguesData` is derived from `leagueConfigs`, so any league missing from
    // it (the PWHL, which is served by `hockeyData.ts`, or an unknown/typo'd
    // name) has no `fetchGames` URL to build. Bail out explicitly instead of
    // letting `leaguesData[leagueName].fetchGames` throw a TypeError that the
    // catch below would swallow into an `undefined` return.
    if (!leaguesData[leagueName]) {
      console.error(
        `No ESPN schedule config for league "${leagueName}" (team ${teamUniqueId}) — skipped.`,
      );
      return [];
    }

    let games = [];
    const soccerLeagues = new Set([League.MLS, League.NWSL]);

    // NOTE: college leagues (NCAAF, NCAAB, NCCABB, WNCAAB, NCAAMH, NCAAWH)
    // intentionally use the team schedule endpoint below (else branch):
    // the scoreboard?dates={year} path does not return their full history.
    // Olympics + soccer keep the scoreboard path (incl. oldies via season).
    if (
      leagueName.includes('OLYMPICS') ||
      soccerLeagues.has(leagueName as League)
    ) {
      const years = season ? [season] : getCurrentSeasonYears(leagueName);

      for (const year of years) {
        try {
          if (leagueConfigs[leagueName]) {
            const { sport, league } = leagueConfigs[leagueName];
            let page = 1;
            let hasMore = true;
            while (hasMore) {
              const url = `${espnAPI}${sport}/${league}/scoreboard?dates=${year}&limit=1000&page=${page}`;
              const data = await fetchJsonOrNull(url);
              if (!data) {
                throw new Error(
                  `ESPN returned no schedule data for ${teamUniqueId} in season ${year}.`,
                );
              }
              if (!Array.isArray(data.events)) {
                throw new Error(
                  `ESPN returned an invalid schedule payload for ${teamUniqueId} in season ${year}.`,
                );
              }
              const events = data.events;
              const eventsFiltered = events
                .filter((ev) =>
                  ev.competitions?.[0]?.competitors?.some(
                    (c) => c.team?.id === id,
                  ),
                )
                .map((ev) => ({
                  ...ev,
                  recordSeasonType: getRecordSeasonType(ev),
                }));
              games.push(...eventsFiltered);
              if (events.length < 1000) {
                hasMore = false;
              } else {
                page++;
              }
            }
          }
        } catch (error) {
          console.error(
            `[Schedule] ESPN scoreboard fetch failed for ${teamUniqueId}:`,
            error,
          );
          throw error;
        }
      }
      // Scoreboard path: read the tally before anything is filtered out.
      collectTeamRecord(games, teamUniqueId, id, teamRecords);
    } else {
      try {
        const baseUrl = leaguesData[leagueName].fetchGames.replace('${id}', id);
        games = [];
        const seasonTypes = [1, 2, 3];

        for (const type of seasonTypes) {
          try {
            const seasonParam = season ? `&season=${season}` : '';
            const link = `${baseUrl}?seasontype=${type}${seasonParam}`;
            const scheduleEvents = await fetchESPNTeamScheduleEvents(link);

            if (scheduleEvents.length > 0) {
              games = [
                ...games,
                ...scheduleEvents.map((event) => ({
                  ...event,
                  recordSeasonType: type,
                })),
              ];
            }
          } catch (err) {
            console.error(
              `Error type ${type} for ${leagueName} team ${id}:`,
              err,
            );
            throw err;
          }
        }

        const now = new Date();
        const tenMonthAgo = new Date(now.getTime() - 300 * 24 * 60 * 60 * 1000);
        const untilDate = forceUpdate ? tenMonthAgo : now;

        // Harvest the tally of the latest played game BEFORE the cutoff below
        // throws those games away — it is the only place some leagues (college
        // hockey) expose it at all.
        collectTeamRecord(games, teamUniqueId, id, teamRecords);

        const gamesFilter = season
          ? games
          : games.filter(({ date }) => new Date(date) >= untilDate);

        games = gamesFilter;
      } catch (error) {
        console.info('no', teamUniqueId, error);
        throw error;
      }
    }

    // Leagues whose division ESPN cannot verify (NCAAMH / NCAAWH) skip the
    // per-game filter entirely: every fetched game is kept (the allowlist
    // upstream already restricts which teams have a schedule requested).
    const applyPerGameDivisionFilter =
      !!d1TeamIds && !UNVERIFIABLE_DIVISION_LEAGUES.has(leagueName);

    if (applyPerGameDivisionFilter) {
      const d1Games = [];
      let invalidCompetitorCount = 0;
      for (const game of games) {
        const competitors = game?.competitions?.[0]?.competitors;
        if (!Array.isArray(competitors) || competitors.length !== 2) {
          invalidCompetitorCount++;
          continue;
        }
        const teamDivisionResults = await Promise.all(
          competitors.map((competitor) =>
            isD1ScheduleTeam(
              leagueName,
              String(competitor?.team?.id || ''),
              competitor?.team?.abbreviation,
            ),
          ),
        );
        // A fixture is kept as soon as ONE side is Division 1: a D1 program's
        // game against a lower division belongs to its schedule. Only a game
        // between two teams that are both provably non-D1 is excluded.
        if (teamDivisionResults.some(Boolean)) {
          d1Games.push(game);
          continue;
        }

        const eventId = game?.id
          ? String(game.id)
          : `${game?.date || 'unknown-date'}|${competitors
              .map((competitor) => String(competitor?.team?.id || 'unknown'))
              .sort()
              .join('|')}`;
        const excludedGame = d1Diagnostics?.excludedGames.get(eventId) ?? {
          opponents: new Set<string>(),
          sourceSchedules: new Set<string>(),
        };
        excludedGame.sourceSchedules.add(teamUniqueId);
        for (let index = 0; index < teamDivisionResults.length; index++) {
          if (teamDivisionResults[index]) continue;
          const team = competitors[index]?.team;
          const teamName =
            team?.displayName || team?.abbreviation || 'unknown team';
          const teamId = team?.id ? ` [${team.id}]` : '';
          excludedGame.opponents.add(`${teamName}${teamId}`);
        }
        d1Diagnostics?.excludedGames.set(eventId, excludedGame);
      }
      games = d1Games;
      if (invalidCompetitorCount > 0) {
        d1Diagnostics?.invalidGames.set(teamUniqueId, invalidCompetitorCount);
      }
    }

    let gamesData = [];
    if (!games.length) {
      return gamesData;
    } else {
      let number = 0;
      const now = new Date();
      const tenMonthAgo = new Date(now.getTime() - 300 * 24 * 60 * 60 * 1000);
      const untilDate = forceUpdate ? tenMonthAgo : now;

      gamesData = games.map((game) => {
        const { date, competitions, id, links } = game;

        if (
          !season &&
          new Date(date) < untilDate &&
          !leagueName.includes('OLYMPICS')
        )
          return;
        const { venue, competitors } = competitions[0];

        const homeCompetitor = competitors.find((c) => c.homeAway === 'home');
        const awayCompetitor = competitors.find((c) => c.homeAway === 'away');
        const homeTeamScore = getScore(homeCompetitor);
        const awayTeamScore = getScore(awayCompetitor);

        const displayTimezone = 'America/Los_Angeles';
        const currentDate = new Date(
          new Date(date).toLocaleString('en-US', { timeZone: displayTimezone }),
        );

        const gameDate = readableDate(new Date(currentDate));
        const isActive = true;

        const { team: awayTeam } = competitors.find(
          (team) => team.homeAway === 'away',
        );
        const { team: homeTeam } = competitors.find(
          (team) => team.homeAway === 'home',
        );
        number++;
        const awayAbbrev = `${awayTeam.abbreviation}`;
        const homeAbbrev = `${homeTeam.abbreviation}`;

        const awayTeamLogo =
          getESPNTeamLogo(awayTeam, [['full', 'scoreboard']]) ||
          awayTeam?.logo ||
          leagueLogos[awayAbbrev] ||
          getOlympicTeamLogo(leagueName, awayAbbrev);
        const homeTeamLogo =
          getESPNTeamLogo(homeTeam, [['full', 'scoreboard']]) ||
          homeTeam?.logo ||
          leagueLogos[homeAbbrev] ||
          getOlympicTeamLogo(leagueName, homeAbbrev);

        const awayTeamLogoDark =
          awayTeam?.logos?.find(
            (l) => l.rel?.includes('dark') && l.rel?.includes('scoreboard'),
          )?.href || awayTeamLogo;
        const homeTeamLogoDark =
          homeTeam?.logos?.find(
            (l) => l.rel?.includes('dark') && l.rel?.includes('scoreboard'),
          )?.href || homeTeamLogo;

        const homeTeamShort = homeAbbrev;
        const awayTeamShort = awayAbbrev;
        const comp = competitions[0];

        return {
          arenaName: capitalize(venue?.fullName) ?? '',
          awayTeam: capitalize(awayTeam.displayName),
          awayTeamId: `${leagueName}-${awayAbbrev}`,
          awayTeamESPNId: String(awayTeam.id),
          awayTeamLogo,
          awayTeamLogoDark,
          awayTeamShort,
          gameDate: gameDate,
          homeTeam: capitalize(homeTeam.displayName),
          homeTeamId: `${leagueName}-${homeAbbrev}`,
          homeTeamESPNId: String(homeTeam.id),
          homeTeamLogo,
          homeTeamLogoDark,
          homeTeamShort,
          homeTeamScore: homeTeamScore,
          awayTeamScore: awayTeamScore,
          // Cumulative phase tally at the time of this game. Completed
          // preseason/regular-season phases are normalized to their final tally;
          // playoff records remain game-specific.
          homeTeamRecord: extractCompetitorRecord(homeCompetitor),
          awayTeamRecord: extractCompetitorRecord(awayCompetitor),
          recordSeasonType: getRecordSeasonType(game),
          seriesSummary: formatSeriesSummary(
            comp?.notes?.[0]?.headline || game.notes?.[0]?.headline || '',
          ),
          seriesStatus: formatSeriesSummary(
            comp?.series?.summary || game.series?.summary || '',
          ),
          league: normalizedLeagueName.toUpperCase(),
          placeName: capitalize(venue?.address?.city) ?? '',
          selectedTeam: homeAbbrev === abbrev,
          startTimeUTC: new Date(date).toISOString(),
          gameStatus: resolveScheduleGameStatus(
            comp?.status?.type?.name || game?.status?.type?.name,
          ),
          teamSelectedId: teamUniqueId,
          isActive,
          uniqueId: id
            ? `${teamUniqueId}-${id}`
            : `${teamUniqueId}-${gameDate}-${number}`,
          urlLive:
            links?.find(
              (l) => l.rel?.includes('boxscore') && l.rel?.includes('desktop'),
            )?.href ||
            links?.find(
              (l) => l.rel?.includes('summary') && l.rel?.includes('desktop'),
            )?.href ||
            (id &&
            leagueConfigs[leagueName] &&
            leagueName !== League.MLS &&
            !leagueName.includes('OLYMPICS')
              ? `https://www.espn.com/${leagueConfigs[leagueName].league}/game/_/gameId/${id}`
              : ''),
        };
      });
    }

    gamesData = gamesData.filter((game) => game !== undefined && game !== null);
    return gamesData;
  } catch (error) {
    console.error(`Error in getEachTeamSchedule for ${teamUniqueId}:`, error);
    throw error;
  }
};

export const getESPNScores = async (
  leagueKey: string,
  date?: string,
  seasonType?: number,
) => {
  try {
    if (aggregateLeagues[leagueKey]) {
      let allScores = [];
      for (const subLeague of aggregateLeagues[leagueKey]) {
        const scores = await getESPNScores(subLeague, date, seasonType);
        allScores = [...allScores, ...scores];
      }
      return allScores;
    }
    const results = [];
    const normalizedLeagueName = getNormalizedLeagueName(leagueKey);
    if (!leagueConfigs[leagueKey]) return results;
    const { sport, league } = leagueConfigs[leagueKey];
    const base = `${espnAPI}${sport}/${league}`;
    const params = new URLSearchParams();
    if (date) params.append('dates', date.replace(/-/g, ''));
    if (seasonType) params.append('seasontype', seasonType.toString());

    const queryString = params.toString() ? `?${params.toString()}` : '';
    const url = `${base}/scoreboard${queryString}`;
    try {
      const res = await fetchWithRetry(url);
      const json = await res.json();
      const events = json?.events || [];
      for (const ev of events) {
        const competitions = ev.competitions?.[0];
        if (!competitions) continue;
        const status = competitions.status?.type || competitions.status;
        const displayClock = competitions.status?.displayClock || '';

        const now = new Date();
        const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
        const eventStart = ev.date ? new Date(ev.date) : null;

        const statusIndicatesFinished =
          status?.completed === true ||
          status?.state === 'post' ||
          (typeof status?.name === 'string' &&
            /final|completed|post|full|finished/i.test(status.name)) ||
          (typeof displayClock === 'string' &&
            /final|completed/i.test(displayClock));

        const startedLongAgo = eventStart ? eventStart <= threeHoursAgo : false;
        const isFinished = statusIndicatesFinished || startedLongAgo;

        // If not finished, try to fetch a boxscore/summary link (sometimes scores are available even if status not final)
        if (!isFinished) {
          try {
            const tryFetchDetail = async () => {
              try {
                const url = `${espnAPI}${sport}/${league}/summary?event=${ev.id}`;
                const r = await fetchWithRetry(url);
                if (!r.ok) return null;
                const j = await r.json();
                // normalize competitions structure
                const comp =
                  j?.header?.competitions?.[0] ||
                  j?.competitions?.[0] ||
                  competitions;
                if (!comp) return null;
                const home = comp.competitors?.find(
                  (c) => c.homeAway === 'home',
                );
                const away = comp.competitors?.find(
                  (c) => c.homeAway === 'away',
                );
                const homeScore =
                  home?.score !== undefined && home?.score !== null
                    ? Number(home.score)
                    : null;
                const awayScore =
                  away?.score !== undefined && away?.score !== null
                    ? Number(away.score)
                    : null;
                const statusDetail = comp.status?.type || comp.status;
                const homeTeamRecord = extractCompetitorRecord(home);
                const awayTeamRecord = extractCompetitorRecord(away);

                const homeTeamShort = home?.team?.abbreviation || undefined;
                const awayTeamShort = away?.team?.abbreviation || undefined;

                const displayClockDetail = comp.status?.displayClock || '';
                const statusIndicatesFinishedDetail =
                  statusDetail?.completed === true ||
                  statusDetail?.state === 'post' ||
                  (typeof statusDetail?.name === 'string' &&
                    /final|completed|post|full|finished/i.test(
                      statusDetail.name,
                    )) ||
                  (typeof displayClockDetail === 'string' &&
                    /final|completed/i.test(displayClockDetail));
                const isFinalDetail =
                  statusIndicatesFinishedDetail || startedLongAgo;
                if (homeScore === null && awayScore === null) return null;
                const id =
                  ev.id || j.id || (comp.id || Math.random()).toString();
                return {
                  uniqueId: id,
                  league: normalizedLeagueName,
                  startTimeUTC: ev.date,
                  homeTeamScore: homeScore,
                  awayTeamScore: awayScore,
                  homeTeamId: home
                    ? `${leagueKey}-${home.team?.abbreviation || home.team?.id}`
                    : undefined,
                  awayTeamId: away
                    ? `${leagueKey}-${away.team?.abbreviation || away.team?.id}`
                    : undefined,
                  homeTeamShort,
                  awayTeamShort,
                  isFinal:
                    statusIndicatesFinishedDetail === true ||
                    isFinalDetail === true,
                  homeTeamRecord,
                  awayTeamRecord,
                  seriesSummary: formatSeriesSummary(
                    comp.notes?.[0]?.headline || j.notes?.[0]?.headline || '',
                  ),
                  seriesStatus: formatSeriesSummary(
                    comp.series?.summary || j.series?.summary || '',
                  ),
                  status: isFinalDetail
                    ? 'FINISHED'
                    : statusDetail?.name || displayClockDetail || '',
                  gameClock: displayClockDetail,
                  gamePeriod: comp.status?.period,
                  gameStatus: isFinalDetail
                    ? 'FINISHED'
                    : statusDetail?.shortDetail || statusDetail?.description,
                };
              } catch (e) {
                console.error(`Error fetching summary for event ${ev.id}:`, e);
                return null;
              }
            };

            const detail = await tryFetchDetail();
            if (detail) {
              results.push(detail);
              continue;
            }
          } catch (e) {
            console.error(
              `Error processing detailed fetch for event ${ev.id}:`,
              e,
            );
          }
          continue;
        }

        const competitors = competitions.competitors || [];
        const home = competitors.find((c) => c.homeAway === 'home');
        const away = competitors.find((c) => c.homeAway === 'away');
        const id =
          ev.id ||
          `${ev.date}-${(competitions.id || Math.random()).toString()}`;

        const homeScore =
          home?.score !== undefined && home?.score !== null
            ? Number(home.score)
            : null;
        const awayScore =
          away?.score !== undefined && away?.score !== null
            ? Number(away.score)
            : null;

        const homeTeamRecord = extractCompetitorRecord(home);
        const awayTeamRecord = extractCompetitorRecord(away);

        const homeTeamShort = home?.team?.abbreviation || undefined;
        const awayTeamShort = away?.team?.abbreviation || undefined;

        const normalized = {
          uniqueId: id,
          league: normalizedLeagueName,
          startTimeUTC: ev.date,
          homeTeamScore: homeScore,
          awayTeamScore: awayScore,
          homeTeamId: home
            ? `${leagueKey}-${home.team?.abbreviation || home.team?.id}`
            : undefined,
          awayTeamId: away
            ? `${leagueKey}-${away.team?.abbreviation || away.team?.id}`
            : undefined,
          homeTeamShort,
          awayTeamShort,
          isFinal: isFinished === true,
          homeTeamRecord,
          awayTeamRecord,
          seriesSummary: formatSeriesSummary(
            competitions.notes?.[0]?.headline || ev.notes?.[0]?.headline || '',
          ),
          seriesStatus: formatSeriesSummary(
            competitions.series?.summary || ev.series?.summary || '',
          ),
          status: isFinished
            ? 'FINISHED'
            : status?.type?.name ||
              status?.name ||
              status?.shortDetail ||
              displayClock ||
              '',
          gameClock: displayClock,
          gamePeriod: competitions.status?.period,
          gameStatus: isFinished
            ? 'FINISHED'
            : status?.type?.detail ||
              status?.detail ||
              status?.shortDetail ||
              status?.description,
        };
        results.push(normalized);
      }
    } catch (err) {
      console.error(`Error fetching ESPN scores for ${leagueKey}:`, err);
    }

    return results;
  } catch (error) {
    console.error('Error in getESPNScores', error);
    return [];
  }
};

export const getESPNGameScore = async (leagueKey: string, gameId: string) => {
  try {
    if (aggregateLeagues[leagueKey]) {
      for (const subLeague of aggregateLeagues[leagueKey]) {
        const result = await getESPNGameScore(subLeague, gameId);
        if (result) return result;
      }
      return null;
    }

    const normalizedLeagueName = getNormalizedLeagueName(leagueKey);
    if (!leagueConfigs[leagueKey]) return null;
    const { sport, league } = leagueConfigs[leagueKey];
    const url = `${espnAPI}${sport}/${league}/summary?event=${gameId}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) return null;
    const data = await res.json();

    const header = data.header;
    const competitions = header?.competitions?.[0];
    if (!competitions) return null;

    const competition = competitions;
    const home = competition.competitors?.find((c) => c.homeAway === 'home');
    const away = competition.competitors?.find((c) => c.homeAway === 'away');

    const homeScore =
      home?.score !== undefined && home?.score !== null
        ? Number(home.score)
        : null;
    const awayScore =
      away?.score !== undefined && away?.score !== null
        ? Number(away.score)
        : null;

    if (homeScore === null && awayScore === null) return null;

    const status = competition.status?.type || competition.status;
    const displayClock = competition.status?.displayClock;

    const isFinal =
      status?.completed === true ||
      status?.state === 'post' ||
      (typeof status?.name === 'string' &&
        /final|completed|post|full|finished/i.test(status.name));

    const homeTeamRecord = extractCompetitorRecord(home);
    const awayTeamRecord = extractCompetitorRecord(away);

    return {
      uniqueId: gameId,
      league: normalizedLeagueName,
      startTimeUTC: competition.date || header?.gameDate,
      homeTeamScore: homeScore,
      awayTeamScore: awayScore,
      homeTeamId: home
        ? `${leagueKey}-${home.team?.abbreviation || home.team?.id}`
        : undefined,
      awayTeamId: away
        ? `${leagueKey}-${away.team?.abbreviation || away.team?.id}`
        : undefined,
      homeTeamShort: home?.team?.abbreviation,
      awayTeamShort: away?.team?.abbreviation,
      isFinal,
      homeTeamRecord,
      awayTeamRecord,
      seriesSummary: formatSeriesSummary(
        competition.notes?.[0]?.headline || data.notes?.[0]?.headline || '',
      ),
      seriesStatus: formatSeriesSummary(
        competition.series?.summary || data.series?.summary || '',
      ),
      status: isFinal ? 'FINISHED' : status?.name || displayClock || '',
      gameClock: displayClock,
      gamePeriod: competition.status?.period,
      gameStatus: isFinal ? 'FINISHED' : status?.detail || status?.shortDetail,
    };
  } catch (error) {
    console.error(`Error in getESPNGameScore for ${gameId}:`, error);
    return null;
  }
};
