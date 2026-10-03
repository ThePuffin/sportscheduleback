import { readableDate } from '../../utils/date';
import { CollegeLeague, League } from '../../utils/enum';
import { getTeamColors } from '../Colors';
import type { ESPNTeam, TeamESPN, TeamType } from '../interface/team';
import { UniversityLogos } from '../UniversityLogos';
import { capitalize, getLuminance, getCurrentSeasonYears } from '../utils';

const espnAPI = 'https://site.api.espn.com/apis/site/v2/sports/';

// Abort a hanging ESPN request after `timeoutMs`, using the global AbortController
// (Node >= 18). Prevents a connect-timeout from blocking the schedule/oldies
// refresh for an unbounded amount of time (undici's default is very long).
const ESPN_FETCH_TIMEOUT_MS = 15000;

const fetchWithTimeout = (
  url: string,
  timeoutMs: number = ESPN_FETCH_TIMEOUT_MS,
  options: RequestInit = {},
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const mergedOptions: RequestInit = { ...options, signal: controller.signal };
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
 * Rewrites the per-game records produced by `getEachTeamSchedule()` so that:
 *
 * - **the season is over** (every fetched game has already started): every game
 *   of that season shows the same **final** season tally — the most complete
 *   record found for each team wins (max games played).
 * - **the season is still running**: the records are cleared, so readers fall
 *   back to `team.record`, which always holds the most recent tally. Keeping
 *   the per-game value there would freeze a stale record on the current season.
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
  const seasonOver = games.every((game) => {
    const start = game.startTimeUTC
      ? new Date(game.startTimeUTC).getTime()
      : NaN;
    return Number.isFinite(start) && start < now;
  });

  if (!seasonOver) {
    for (const game of games) {
      game.homeTeamRecord = '';
      game.awayTeamRecord = '';
    }
    return;
  }

  const finals = new Map<string, { gamesPlayed: number; record: string }>();
  const track = (teamId?: string, record?: string) => {
    if (!teamId || !record) return;
    const gamesPlayed = recordGamesPlayed(record);
    const current = finals.get(teamId);
    if (!current || gamesPlayed > current.gamesPlayed) {
      finals.set(teamId, { gamesPlayed, record });
    }
  };

  for (const game of games) {
    track(game.homeTeamId, game.homeTeamRecord);
    track(game.awayTeamId, game.awayTeamRecord);
  }

  for (const game of games) {
    game.homeTeamRecord =
      finals.get(game.homeTeamId)?.record ?? game.homeTeamRecord ?? '';
    game.awayTeamRecord =
      finals.get(game.awayTeamId)?.record ?? game.awayTeamRecord ?? '';
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
    league: 'olympics-mens-basketball',
  },
  [OLYMPICS_BASKETBALL_WOMEN]: {
    sport: 'basketball',
    league: 'olympics-womens-basketball',
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
        fetchTeam: teamBase,
        fetchGames: `${teamBase}/\${id}/schedule`,
        fetchDetails: `${teamBase}/`,
        fetchStandings: `${base}/standings`,
      },
    ];
  }),
);

const getDivision = async (
  leagueName: string,
  id: string,
): Promise<{
  conferenceName: string;
  divisionName: string;
  record?: { wins: number; losses: number; ties?: number; otLosses?: number };
}> => {
  try {
    const url = leaguesData[leagueName].fetchDetails + id;
    const fetchedTeams = await fetchWithRetry(url);
    const fetchTeams = await fetchedTeams.json();
    const team = fetchTeams?.team || {};
    const { standingSummary = '' } = team;

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

    if (standingSummary === '') {
      return { conferenceName: '', divisionName: '', record };
    }
    const cut = standingSummary.split(' ');
    if (leagueName === League.NFL || leagueName === League.MLB) {
      return {
        conferenceName: cut[3] || '',
        divisionName: cut[2] || '',
        record,
      };
    } else if (leagueName === League.NBA) {
      const divisionName = cut[2] || '';
      const conference = {
        Atlantic: 'East',
        Central: 'East',
        Northwest: 'West',
        Pacific: 'West',
      };
      return {
        conferenceName: conference[divisionName] || '',
        divisionName,
        record,
      };
    } else if (leagueName.includes('OLYMPICS')) {
      return { conferenceName: standingSummary, divisionName: '', record };
    } else {
      return { conferenceName: '', divisionName: '', record };
    }
  } catch {
    return { conferenceName: '', divisionName: '' };
  }
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
    const fetchedTeams = await fetchWithRetry(
      leaguesData[leagueName].fetchTeam,
    );
    const fetchTeams: TeamESPN = await fetchedTeams.json();
    const { sports } = fetchTeams;
    if (!sports) return [];
    const { leagues } = sports[0];
    const allTeams: ESPNTeam[] = leagues[0].teams || [];
    const standings = await getESPNStandings(leagueName);

    if (allTeams.length === 0 && leagueName.includes('OLYMPICS')) {
      try {
        const url = leaguesData[leagueName].fetchStandings;
        const res = await fetchWithRetry(url);
        const data = await res.json();

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
        const url = `${espnAPI}${sport}/${league}/scoreboard?dates=${currentYear}`;
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
        let teamLogo = logos?.[2]?.href ?? logos?.[0]?.href;
        if (!teamLogo) {
          teamLogo = UniversityLogos[teamID] || '';
        }
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
          value: uniqueId,
          id: id,
          abbrev: teamID,
          label: capitalize(displayName),
          teamLogo,
          teamLogoDark,
          teamCommonName: capitalize(nickname || displayName),
          conferenceName: '',
          divisionName: '',
          league: normalizedLeagueName.toUpperCase(),
          color: colorTeam,
          backgroundColor: backgroundColorTeam,
          wins: record?.wins,
          losses: record?.losses,
          ties: record?.ties,
        };
      });

    for (const team of activeTeams) {
      const { conferenceName, divisionName, record } = await getDivision(
        leagueName,
        team.id,
      );
      team.conferenceName = conferenceName;
      team.divisionName = divisionName;
      if (record) {
        (team as any).wins = record.wins;
        (team as any).losses = record.losses;
        (team as any).ties = record.ties;
        if (record.otLosses !== undefined) {
          (team as any).otLosses = record.otLosses;
        }
      }
    }

    return activeTeams;
  } catch (error) {
    console.error('Error fetching data =>', error);
    return [];
  }
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

  for (let start = 0; start < activeTeams.length; start += concurrencyLimit) {
    const batch = activeTeams.slice(start, start + concurrencyLimit);
    await Promise.all(
      batch.map(
        async ({ id, abbrev, value, uniqueId, color, backgroundColor }) => {
          const leagueID = `${uniqueId}`;
          allGames[leagueID] = await getEachTeamSchedule(
            {
              id,
              abbrev,
              value,
              leagueName,
              leagueLogos,
              color,
              backgroundColor,
            },
            forceUpdate,
            season,
            teamRecords,
          );
        },
      ),
    );
  }

  // Normalize the per-game cumulative tallies into the record that must be
  // displayed: the final tally of a finished season, nothing (so the most
  // recent team record is used) while the season is still running.
  applySeasonFinalRecords(allGames);

  console.info(`updated ${leagueName}`);
  return allGames;
};

const getEachTeamSchedule = async (
  { id, abbrev, value, leagueName, leagueLogos, color, backgroundColor },
  forceUpdate = false,
  season?: number,
  teamRecords?: Map<string, string>,
) => {
  try {
    const normalizedLeagueName = getNormalizedLeagueName(leagueName);
    if (aggregateLeagues[leagueName]) {
      let allGames = [];
      for (const subLeague of aggregateLeagues[leagueName]) {
        const games = await getEachTeamSchedule(
          {
            id,
            abbrev,
            value,
            leagueName: subLeague,
            leagueLogos,
            color,
            backgroundColor,
          },
          forceUpdate,
          season,
          teamRecords,
        );
        allGames = [...allGames, ...games];
      }
      return allGames;
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
              const res = await fetchWithRetry(url);
              const data = await res.json();
              const events = data.events || [];
              const eventsFiltered = events.filter((ev) =>
                ev.competitions?.[0]?.competitors?.some(
                  (c) => c.team?.id === id,
                ),
              );
              games.push(...eventsFiltered);
              if (events.length < 1000) {
                hasMore = false;
              } else {
                page++;
              }
            }
          }
        } catch (error) {
          console.info('no games found ' + leagueName, value, error);
        }
      }
      // Scoreboard path: read the tally before anything is filtered out.
      collectTeamRecord(games, value, id, teamRecords);
    } else {
      try {
        const baseUrl = leaguesData[leagueName].fetchGames.replace('${id}', id);
        games = [];
        const seasonTypes = [1, 2, 3];

        for (const type of seasonTypes) {
          try {
            const seasonParam = season ? `&season=${season}` : '';
            const link = `${baseUrl}?seasontype=${type}${seasonParam}`;
            const fetchedGames = await fetchWithRetry(link);
            const fetchGamesData = await fetchedGames.json();

            if (fetchGamesData.events && fetchGamesData.events.length > 0) {
              games = [...games, ...fetchGamesData.events];
            }
          } catch (err) {
            console.error(
              `Error type ${type} for ${leagueName} team ${id}:`,
              err,
            );
          }
        }

        const now = new Date();
        const tenMonthAgo = new Date(now.getTime() - 300 * 24 * 60 * 60 * 1000);
        const untilDate = forceUpdate ? tenMonthAgo : now;

        // Harvest the tally of the latest played game BEFORE the cutoff below
        // throws those games away — it is the only place some leagues (college
        // hockey) expose it at all.
        collectTeamRecord(games, value, id, teamRecords);

        const gamesFilter = season
          ? games
          : games.filter(({ date }) => new Date(date) >= untilDate);

        games = gamesFilter;
      } catch (error) {
        console.info('no', value, error);
        games = [];
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

        const venueTimezone = 'America/Los_Angeles';
        const currentDate = new Date(
          new Date(date).toLocaleString('en-US', { timeZone: venueTimezone }),
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
          awayTeam?.logos?.find(
            (l) => l.rel?.includes('full') && l.rel?.includes('scoreboard'),
          )?.href || leagueLogos[awayAbbrev];
        const homeTeamLogo =
          homeTeam?.logos?.find(
            (l) => l.rel?.includes('full') && l.rel?.includes('scoreboard'),
          )?.href || leagueLogos[homeAbbrev];

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
          awayTeamLogo,
          awayTeamLogoDark,
          awayTeamShort,
          backgroundColor: backgroundColor ?? undefined,
          color: color ?? undefined,
          gameDate: gameDate,
          homeTeam: capitalize(homeTeam.displayName),
          homeTeamId: `${leagueName}-${homeAbbrev}`,
          homeTeamLogo,
          homeTeamLogoDark,
          homeTeamShort,
          homeTeamScore: homeTeamScore,
          awayTeamScore: awayTeamScore,
          // Cumulative tally at the time of this game. `getTeamsSchedule()` then
          // rewrites them into the season's final tally (finished season) or
          // clears them (season in progress) via `applySeasonFinalRecords()`.
          homeTeamRecord: extractCompetitorRecord(homeCompetitor),
          awayTeamRecord: extractCompetitorRecord(awayCompetitor),
          seriesSummary: formatSeriesSummary(
            comp?.notes?.[0]?.headline || game.notes?.[0]?.headline || '',
          ),
          seriesStatus: formatSeriesSummary(
            comp?.series?.summary || game.series?.summary || '',
          ),
          league: normalizedLeagueName.toUpperCase(),
          placeName: capitalize(venue?.address?.city) ?? '',
          selectedTeam: homeAbbrev === abbrev,
          show: homeAbbrev === abbrev,
          startTimeUTC: new Date(date).toISOString(),
          gameStatus: (function () {
            const status = comp?.status?.type?.name || game?.status?.type?.name;
            if (
              status === 'STATUS_FINAL' ||
              status === 'STATUS_FULL_TIME' ||
              status === 'STATUS_POSTPONED' ||
              status === 'STATUS_CANCELLED'
            ) {
              return status === 'STATUS_FINAL' || status === 'STATUS_FULL_TIME'
                ? 'FINISHED'
                : status.replace('STATUS_', '');
            }
            if (status === 'STATUS_IN_PROGRESS') return 'IN_PROGRESS';
            if (status && status.startsWith('STATUS_')) {
              return status.replace('STATUS_', '').replace(/_/g, ' ');
            }
            return null;
          })(),
          teamSelectedId: value,
          isActive,
          uniqueId: id ? `${value}-${id}` : `${value}-${gameDate}-${number}`,
          venueTimezone,
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
    console.error(`Error in getEachTeamSchedule for ${value}:`, error);
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
