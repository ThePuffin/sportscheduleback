import { League } from '../../utils/enum';
import type { GameFormatted } from '../../utils/interface/game';
import type { NHLGameAPI } from '../../utils/interface/gameNHL';
import type { TeamNHL, TeamType } from '../../utils/interface/team';
import { capitalize } from '../utils';
const leagueName = League.NHL;
const { NODE_ENV } = process.env;

export class HockeyData {
  async getNhlTeams(): Promise<TeamType[]> {
    try {
      let allTeams: TeamNHL[];

      const fetchedTeams = await fetch(
        'https://api-web.nhle.com/v1/standings/now',
      );
      const fetchTeams = await fetchedTeams.json();
      allTeams = await fetchTeams.standings;

      allTeams = allTeams.map((team: TeamNHL) => {
        if (team.teamAbbrev.default === 'ARI') {
          team.teamAbbrev.default = 'UTA';
          team.teamCommonName.default = 'Utah';
        }
        return team;
      });

      const activeTeams = allTeams.map((team: TeamNHL) => {
        const {
          teamAbbrev,
          teamName,
          teamLogo,
          divisionName,
          teamCommonName,
          conferenceName,
        } = team;
        const teamID = teamAbbrev.default;
        const uniqueId = `${leagueName}-${teamID}`;

        return {
          uniqueId,
          value: uniqueId,
          id: teamID,
          abbrev: teamID,
          label: capitalize(teamName?.default),
          teamLogo: teamLogo,
          teamCommonName: capitalize(teamCommonName.default),
          conferenceName,
          divisionName,
          league: leagueName.toUpperCase(),
          color: undefined,
          backgroundColor: undefined,
        };
      });

      return activeTeams;
    } catch (error) {
      console.error('Error fetching data =>', error);
      return [];
    }
  }

  getNhlSchedule = async (activeTeams, leagueLogos) => {
    const allGames = {};

    await Promise.all(
      activeTeams.map(async (team) => {
        try {
          const { id, value, color, backgroundColor } = team;
          const leagueID = `${leagueName}-${id}`;
          allGames[leagueID] = await this.getNhlTeamSchedule(
            id,
            value,
            leagueLogos,
            color,
            backgroundColor,
          );
        } catch (error) {
          console.error(`Error fetching schedule for team ${error.id}:`, error);
          throw team;
        }
      }),
    );

    for (const team of Object.keys(allGames)) {
      if (allGames[team].length === 0) {
        delete allGames[team];
      }
    }

    console.info('updated NHL');
    return allGames;
  };

  fetchGamesData = async (id: string) => {
    try {
      const fetchedGames = await fetch(
        `https://api-web.nhle.com/v1/club-schedule-season/${id}/now`,
      );
      const fetchGames = await fetchedGames.json();
      console.info('yes', id);
      return await fetchGames.games;
    } catch (error) {
      console.error('Error fetching games:', id, error);
      throw id;
    }
  };

  getNhlTeamSchedule = async (
    id: string,
    value: string,
    leagueLogos: { string },
    color: string | undefined,
    backgroundColor: string | undefined,
  ) => {
    let games: NHLGameAPI[];
    games = await this.fetchGamesData(id);

    let gamesData: GameFormatted[] = games.map((game: NHLGameAPI) => {
      const {
        awayTeam,
        homeTeam,
        venue,
        gameDate,
        venueTimezone,
        startTimeUTC,
      } = game;

      const now = new Date();
      const isActive = true;
      if (new Date(startTimeUTC) < now) return;
      const awayTeamName = `${awayTeam.placeName.default} ${awayTeam.commonName.default}`;
      const homeTeamName = `${homeTeam.placeName.default} ${homeTeam.commonName.default}`;

      return {
        arenaName: capitalize(venue?.default) || '',
        awayTeam: capitalize(awayTeamName),
        awayTeamId: `${leagueName}-${awayTeam.abbrev}`,
        awayTeamLogo: leagueLogos[awayTeam.abbrev],
        awayTeamShort: awayTeam.abbrev,
        backgroundColor: backgroundColor || undefined,
        color: color || undefined,
        gameDate: gameDate,
        homeTeam: capitalize(homeTeamName),
        homeTeamId: `${leagueName}-${homeTeam.abbrev}`,
        homeTeamLogo: leagueLogos[homeTeam.abbrev],
        homeTeamShort: homeTeam.abbrev,
        league: leagueName,
        placeName: capitalize(homeTeam.placeName.default),
        selectedTeam: homeTeam.abbrev === id,
        show: homeTeam.abbrev === id,
        startTimeUTC,
        teamSelectedId: value,
        isActive,
        uniqueId: `${value}-${gameDate}-1`,
        venueTimezone: venueTimezone,
      };
    });

    gamesData = gamesData.filter((game) => game !== undefined && game !== null);

    return gamesData;
  };
}
