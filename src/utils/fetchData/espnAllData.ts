import { readableDate } from '../../utils/date';
import { League } from '../../utils/enum';
import type { MLBGameAPI } from '../../utils/interface/gameMLB';
import type { NBAGameAPI } from '../../utils/interface/gameNBA';
import type { NFLGameAPI } from '../../utils/interface/gameNFL';
import type { ESPNTeam, TeamESPN, TeamType } from '../interface/team';
const { NODE_ENV } = process.env;

const espnAPI = 'https://site.api.espn.com/apis/site/v2/sports/';

const leagueConfigs = {
  [League.MLB]: { sport: 'baseball', league: 'mlb' },
  [League.NBA]: { sport: 'basketball', league: 'nba' },
  [League.WNBA]: { sport: 'basketball', league: 'wnba' },
  [League.NFL]: { sport: 'football', league: 'nfl' },
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
  const { standingSummary = '' } = fetchTeams.team;
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
    let allTeams: ESPNTeam[];

    const fetchedTeams = await fetch(leaguesData[leagueName].fetchTeam);
    const fetchTeams: TeamESPN = await fetchedTeams.json();
    const { sports } = fetchTeams;
    const { leagues } = sports[0];
    allTeams = leagues[0].teams;

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
          label: displayName,
          teamLogo: logos[2].href ?? logos[0].href,
          teamCommonName: nickname,
          conferenceName: '',
          divisionName: '',
          league: leagueName,
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
      const fetchGames: MLBGameAPI | NBAGameAPI | NFLGameAPI =
        await fetchedGames.json();
      games =
        fetchGames?.events?.length && fetchGames.events[0]
          ? fetchGames.events
          : [];
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

        const awayTeam = competitors.find((team) => team.homeAway === 'away');
        const homeTeam = competitors.find((team) => team.homeAway === 'home');
        number++;

        return {
          arenaName: venue?.fullName ?? '',
          awayTeam: awayTeam.team.displayName,
          awayTeamId: `${leagueName}-${awayTeam.team.abbreviation}`,
          awayTeamLogo: leagueLogos[awayTeam.team.abbreviation],
          awayTeamShort: awayTeam.team.abbreviation,
          backgroundColor: backgroundColor ?? undefined,
          color: color ?? undefined,
          gameDate: gameDate,
          homeTeam: homeTeam.team.displayName,
          homeTeamId: `${leagueName}-${homeTeam.team.abbreviation}`,
          homeTeamLogo: leagueLogos[homeTeam.team.abbreviation],
          homeTeamShort: homeTeam.team.abbreviation,
          league: leagueName,
          placeName: venue?.address?.city ?? '',
          selectedTeam: homeTeam.team.abbreviation === abbrev,
          show: homeTeam.team.abbreviation === abbrev,
          startTimeUTC: date,
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
