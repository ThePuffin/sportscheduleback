import { readableDate } from '../../utils/date';
import { League } from '../../utils/enum';
import type { MLSGameAPI } from '../../utils/interface/gameMLS';
import type { ESPNTeam, TeamESPN, TeamType } from '../interface/team';
import { TeamDetailed } from '../interface/teamDetails';
import { capitalize } from '../utils';

const espnAPI = 'https://site.api.espn.com/apis/site/v2/sports/';

// const ESPNAbbrevs = {
//   NHL: {
//     NJ: 'NJD',
//     TB: 'TBL',
//     LA: 'LAK',
//     SJ: 'SJS',
//     VG: 'VGK',
//   },
// };

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
    const base = `${espnAPI}${sport}/${league}/teams`;
    return [
      key,
      {
        leagueName: key,
        fetchTeam: base,
        fetchGames: `${base}/\${id}/schedule`,
        fetchDetails: `${base}/`,
      },
    ];
  }),
);

const getDivision = async (
  leagueName: string,
  id: string,
): Promise<{ conferenceName: string; divisionName: string }> => {
  const url = leaguesData[leagueName].fetchDetails + id;
  const fetchedTeams = await fetch(url);
  const fetchTeams = await fetchedTeams.json();
  const { standingSummary = '' } = fetchTeams?.team;
  if (standingSummary === '') {
    return { conferenceName: '', divisionName: '' };
  }
  const cut = standingSummary.split(' ');
  if (leagueName === League.NFL) {
    return { conferenceName: cut[3] || '', divisionName: cut[2] || '' };
  } else if (leagueName === League.NBA) {
    const divisionName = cut[2] || '';
    const conference = {
      Atlantic: 'East',
      Central: 'East',
      Northwest: 'West',
      Pacific: 'West',
    };
    return { conferenceName: conference[divisionName] || '', divisionName };
  } else if (leagueName === League.MLB) {
    return { conferenceName: cut[3] || '', divisionName: cut[2] || '' };
  } else {
    return { conferenceName: '', divisionName: '' };
  }
};

export const getESPNTeams = async (leagueName: string): Promise<TeamType[]> => {
  try {
    const fetchedTeams = await fetch(leaguesData[leagueName].fetchTeam);
    const fetchTeams: TeamESPN = await fetchedTeams.json();
    const { sports } = fetchTeams;
    const { leagues } = sports[0];
    const allTeams: ESPNTeam[] = leagues[0].teams;

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
        const teamID = abbreviation;
        const uniqueId = `${leagueName}-${teamID}`;
        return {
          uniqueId,
          value: uniqueId,
          id: id,
          abbrev: teamID,
          label: capitalize(displayName),
          teamLogo: logos?.[2]?.href ?? logos?.[0]?.href,
          teamCommonName: capitalize(nickname),
          conferenceName: '',
          divisionName: '',
          league: leagueName.toUpperCase(),
          color: color || undefined,
          backgroundColor: alternateColor || undefined,
        };
      });

    for (const team of activeTeams) {
      const { conferenceName, divisionName } = await getDivision(
        leagueName,
        team.id,
      );
      team.conferenceName = conferenceName;
      team.divisionName = divisionName;
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

      games = events && events?.length && events[0] ? events : [];

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
        const { date, competitions, id } = game;

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

        return {
          arenaName: capitalize(venue?.fullName) ?? '',
          awayTeam: capitalize(awayTeam.displayName),
          awayTeamId: `${leagueName}-${awayAbbrev}`,
          awayTeamLogo: awayTeam?.logos?.[2]?.href || leagueLogos[awayAbbrev],
          awayTeamShort: awayAbbrev,
          backgroundColor: backgroundColor ?? undefined,
          color: color ?? undefined,
          gameDate: gameDate,
          homeTeam: capitalize(homeTeam.displayName),
          homeTeamId: `${leagueName}-${homeAbbrev}`,
          homeTeamLogo: homeTeam?.logos?.[2]?.href || leagueLogos[homeAbbrev],
          homeTeamShort: homeAbbrev,
          league: leagueName.toUpperCase(),
          placeName: capitalize(venue?.address?.city) ?? '',
          selectedTeam: homeAbbrev === abbrev,
          show: homeAbbrev === abbrev,
          startTimeUTC: new Date(date).toISOString(),
          teamSelectedId: value,
          isActive,
          uniqueId: id ? `${value}-${id}` : `${value}-${gameDate}-${number}`,
          venueTimezone,
        };
      });
    }

    gamesData = gamesData.filter((game) => game !== undefined && game !== null);
    return gamesData;
  } catch (error) {
    console.error('Error fetching data', error);
    return {};
  }
};
