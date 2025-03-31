import type { MLBGameAPI } from '../../utils/interface/gameMLB';
import type { NBAGameAPI } from '../../utils/interface/gameNBA';
import type { NFLGameAPI } from '../../utils/interface/gameNFL';
import type { ESPNTeam, TeamESPN, TeamType } from '../interface/team';
import { readableDate } from '../../utils/date';
import { League } from '../../utils/enum';
import {
  clearNbaSchedule,
  filterGamesByTeam,
  getNBASchedule,
} from './nbaSchedule';
const { NODE_ENV } = process.env;

const leaguesData = {
  [League.MLB]: {
    leagueName: League.MLB,
    fetchTeam:
      'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams',
    fetchGames:
      'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${id}/schedule',
    fetchDetails:
      'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/',
  },
  [League.NBA]: {
    leagueName: League.NBA,
    fetchTeam:
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams',
    fetchGames:
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/${id}/schedule',
    fetchDetails:
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/',
  },
  [League.WNBA]: {
    leagueName: League.WNBA,
    fetchTeam:
      'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams',
    fetchGames:
      'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/${id}/schedule',
    fetchDetails:
      'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/',
  },
  [League.NFL]: {
    leagueName: League.NFL,
    fetchTeam:
      'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams',
    fetchGames:
      'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/schedule',
    fetchDetails:
      'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/',
  },
};

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
        const { abbreviation, displayName, logos, nickname, id } = team;
        const teamID = abbreviation;
        const uniqueId = `${leagueName}-${teamID}`;
        return {
          uniqueId,
          value: uniqueId,
          id: id,
          abbrev: teamID,
          label: displayName,
          teamLogo: logos[0].href,
          teamCommonName: nickname,
          conferenceName: '',
          divisionName: '',
          league: leagueName,
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
  if (leagueName === League.NBA) {
    await getNBASchedule();
  }
  await Promise.all(
    activeTeams.map(async ({ id, abbrev, value, uniqueId }) => {
      const leagueID = `${uniqueId}`;
      allGames[leagueID] = await getEachTeamSchedule({
        id,
        abbrev,
        value,
        leagueName,
        leagueLogos,
      });
    }),
  );
  clearNbaSchedule();
  console.info(`updated ${leagueName}`);
  return allGames;
};

const getEachTeamSchedule = async ({
  id,
  abbrev,
  value,
  leagueName,
  leagueLogos,
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
      if (leagueName === League.NBA) {
        gamesData = filterGamesByTeam(abbrev, value, leagueLogos);
      }
    } else {
      let number = 0;
      const now = new Date();
      gamesData = games.map((game) => {
        const { date, competitions } = game;

        if (new Date(date) < now) return;
        const { venue, competitors } = competitions[0];
        const venueTimezone = 'America/New_York';
        const gameDate = readableDate(new Date(date));
        const currentDate = new Date(
          new Date(date).toLocaleString('en-US', { timeZone: venueTimezone }),
        );
        const hourStart = currentDate.getUTCHours().toString().padStart(2, '0');
        const minStart = currentDate.getMinutes().toString().padStart(2, '0');
        const timeStart = `${hourStart}:${minStart}`;

        const awayTeam = competitors.find((team) => team.homeAway === 'away');
        const homeTeam = competitors.find((team) => team.homeAway === 'home');
        number++;

        return {
          uniqueId: `${value}-${gameDate}-${number}`,
          arenaName: venue?.fullName || '',
          awayTeamId: `${leagueName}-${awayTeam.team.abbreviation}`,
          awayTeam: awayTeam.team.displayName,
          awayTeamShort: awayTeam.team.abbreviation,
          awayTeamLogo: leagueLogos[awayTeam.team.abbreviation],
          homeTeam: homeTeam.team.displayName,
          homeTeamId: `${leagueName}-${homeTeam.team.abbreviation}`,
          homeTeamShort: homeTeam.team.abbreviation,
          homeTeamLogo: leagueLogos[homeTeam.team.abbreviation],
          gameDate: gameDate,
          teamSelectedId: value,
          show: homeTeam.team.abbreviation === abbrev,
          selectedTeam: homeTeam.team.abbreviation === abbrev,
          league: leagueName,
          venueTimezone,
          timeStart,
          startTimeUTC: date,
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
