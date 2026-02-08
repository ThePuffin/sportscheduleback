import { readableDate } from '../../utils/date';
import { League } from '../../utils/enum';
import type { MLSGameAPI } from '../../utils/interface/gameMLS';
import { Colors } from '../Colors';
import type { ESPNTeam, TeamESPN, TeamType } from '../interface/team';
import { TeamDetailed } from '../interface/teamDetails';
import { capitalize, getLuminance } from '../utils';

const espnAPI = 'https://site.api.espn.com/apis/site/v2/sports/';

const ESPNAbbrevs = {
  NHL: {
    UTAH: 'UTA',
  },
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
  const url = leaguesData[leagueName].fetchDetails + id;
  const fetchedTeams = await fetch(url);
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
  } else {
    return { conferenceName: '', divisionName: '', record };
  }
};

const getESPNStandings = async (leagueName: string) => {
  try {
    const url = leaguesData[leagueName].fetchStandings;
    const res = await fetch(url);
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
    const fetchedTeams = await fetch(leaguesData[leagueName].fetchTeam);
    const fetchTeams: TeamESPN = await fetchedTeams.json();
    const { sports } = fetchTeams;
    const { leagues } = sports[0];
    const allTeams: ESPNTeam[] = leagues[0].teams;
    const standings = await getESPNStandings(leagueName);

    const activeTeams: TeamType[] = allTeams
      .filter(({ team }) => team.isActive)
      .sort((a, b) => (a.team.slug > b.team.slug ? 1 : -1))
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
        let teamID = abbreviation;

        if (ESPNAbbrevs[leagueName]?.[teamID]) {
          teamID = ESPNAbbrevs[leagueName][teamID];
        }
        const uniqueId = `${leagueName}-${teamID}`;
        const teamLogo = logos?.[2]?.href ?? logos?.[0]?.href;
        const teamLogoDark =
          logos?.find(
            (l) => l.rel?.includes('dark') && l.rel?.includes('scoreboard'),
          )?.href || teamLogo;

        const record = standings[id];

        let colorTeam = color
          ? '#' + color
          : Colors[uniqueId]?.color || Colors.default.color;
        let backgroundColorTeam = alternateColor
          ? '#' + alternateColor
          : Colors[uniqueId]?.backgroundColor || Colors.default.backgroundColor;

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
          teamCommonName: capitalize(nickname),
          conferenceName: '',
          divisionName: '',
          league: leagueName.toUpperCase(),
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
) => {
  const allGames = {};
  await Promise.all(
    activeTeams.map(
      async ({ id, abbrev, value, uniqueId, color, backgroundColor }) => {
        const leagueID = `${uniqueId}`;
        allGames[leagueID] = await getEachTeamSchedule({
          id,
          abbrev,
          value,
          leagueName,
          leagueLogos,
          color,
          backgroundColor,
        });
      },
    ),
  );

  console.info(`updated ${leagueName}`);
  return allGames;
};

const getEachTeamSchedule = async ({
  id,
  abbrev,
  value,
  leagueName,
  leagueLogos,
  color,
  backgroundColor,
}) => {
  try {
    let games;
    try {
      const link = leaguesData[leagueName].fetchGames.replace('${id}', id);
      const fetchedGames = await fetch(link);
      const fetchGames: MLSGameAPI = await fetchedGames.json();
      const { events } = fetchGames;

      games = events?.[0] ? events : [];

      const now = new Date();
      const gamesFilter = games.filter(({ date }) => new Date(date) >= now);
      if (gamesFilter.length === 0) {
        const link = leaguesData[leagueName].fetchTeam + '/' + id;
        const fetchedTeams = await fetch(link);
        const fetchTeams: TeamDetailed = await fetchedTeams.json();
        games = fetchTeams?.team?.nextEvent || [];
      }

      console.info('yes', value);
    } catch (error) {
      console.info('no', value, error);
      games = [];
    }
    let gamesData = [];
    if (!games.length) {
      return gamesData;
    } else {
      let number = 0;
      const now = new Date();
      gamesData = games.map((game) => {
        const { date, competitions, id, links } = game;

        if (new Date(date) < now) return;
        const { venue, competitors } = competitions[0];
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

        return {
          arenaName: capitalize(venue?.fullName) ?? '',
          awayTeam: capitalize(awayTeam.displayName),
          awayTeamId: `${leagueName}-${awayAbbrev}`,
          awayTeamLogo,
          awayTeamLogoDark,
          awayTeamShort: awayAbbrev,
          backgroundColor: backgroundColor ?? undefined,
          color: color ?? undefined,
          gameDate: gameDate,
          homeTeam: capitalize(homeTeam.displayName),
          homeTeamId: `${leagueName}-${homeAbbrev}`,
          homeTeamLogo,
          homeTeamLogoDark,
          homeTeamShort: homeAbbrev,
          homeTeamScore: null,
          awayTeamScore: null,
          league: leagueName.toUpperCase(),
          placeName: capitalize(venue?.address?.city) ?? '',
          selectedTeam: homeAbbrev === abbrev,
          show: homeAbbrev === abbrev,
          startTimeUTC: new Date(date).toISOString(),
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
            '',
        };
      });
    }

    gamesData = gamesData.filter((game) => game !== undefined && game !== null);
    return gamesData;
  } catch (error) {
    console.error(`Error in getEachTeamSchedule for ${value}:`, error);
    return [];
  }
};

export const getESPNScores = async (leagueKey: string, date: string) => {
  try {
    const results = [];
    if (!leagueConfigs[leagueKey]) return results;
    const { sport, league } = leagueConfigs[leagueKey];
    const base = `${espnAPI}${sport}/${league}`;
    // ESPN scoreboard endpoint: /scoreboard?dates=YYYYMMDD
    const datestr = date.replace(/-/g, '');
    const url = `${base}/scoreboard?dates=${datestr}`;
    try {
      const res = await fetch(url);
      const json = await res.json();
      const events = json?.events || [];
      let finishedCount = 0;
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
            /final|completed|post/i.test(status.name)) ||
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
                const r = await fetch(url);
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
                const homeTeamRecord =
                  home?.records?.find((r) => r.type === 'total')?.summary || '';
                const awayTeamRecord =
                  away?.records?.find((r) => r.type === 'total')?.summary || '';

                const displayClockDetail = comp.status?.displayClock || '';
                const statusIndicatesFinishedDetail =
                  statusDetail?.completed === true ||
                  statusDetail?.state === 'post' ||
                  (typeof statusDetail?.name === 'string' &&
                    /final|completed|post/i.test(statusDetail.name)) ||
                  (typeof displayClockDetail === 'string' &&
                    /final|completed/i.test(displayClockDetail));
                const isFinalDetail =
                  statusIndicatesFinishedDetail || startedLongAgo;
                if (homeScore === null && awayScore === null) return null;
                const id =
                  ev.id || j.id || (comp.id || Math.random()).toString();
                return {
                  uniqueId: id,
                  league: leagueKey,
                  startTimeUTC: ev.date,
                  homeTeamScore: homeScore,
                  awayTeamScore: awayScore,
                  homeTeamId: home
                    ? `${leagueKey}-${home.team?.abbreviation || home.team?.id}`
                    : undefined,
                  awayTeamId: away
                    ? `${leagueKey}-${away.team?.abbreviation || away.team?.id}`
                    : undefined,
                  homeTeamShort: home?.team?.abbreviation || undefined,
                  awayTeamShort: away?.team?.abbreviation || undefined,
                  isFinal:
                    statusIndicatesFinishedDetail === true ||
                    isFinalDetail === true,
                  homeTeamRecord,
                  awayTeamRecord,
                  status: statusDetail?.name || displayClockDetail || '',
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

        const homeTeamRecord =
          home?.records?.find((r) => r.type === 'total')?.summary || '';
        const awayTeamRecord =
          away?.records?.find((r) => r.type === 'total')?.summary || '';

        finishedCount++;
        const normalized = {
          uniqueId: id,
          league: leagueKey,
          startTimeUTC: ev.date,
          homeTeamScore: homeScore,
          awayTeamScore: awayScore,
          homeTeamId: home
            ? `${leagueKey}-${home.team?.abbreviation || home.team?.id}`
            : undefined,
          awayTeamId: away
            ? `${leagueKey}-${away.team?.abbreviation || away.team?.id}`
            : undefined,
          homeTeamShort: home?.team?.abbreviation || undefined,
          awayTeamShort: away?.team?.abbreviation || undefined,
          isFinal: statusIndicatesFinished === true,
          homeTeamRecord,
          awayTeamRecord,
          status: status?.name || displayClock || '',
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
