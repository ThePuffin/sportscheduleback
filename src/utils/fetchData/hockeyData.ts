import type { GameFormatted } from '../../utils/interface/game';
import type { NHLGameAPI } from '../../utils/interface/gameNHL';
import type { TeamNHL, TeamType } from '../../utils/interface/team';
import { League } from '../../utils/enum';
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
          label: teamName?.default,
          teamLogo: teamLogo,
          teamCommonName: teamCommonName.default,
          conferenceName,
          divisionName,
          league: leagueName,
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
      activeTeams.map(async ({ id, value, color, backgroundColor }) => {
        const leagueID = `${leagueName}-${id}`;
        allGames[leagueID] = await this.getNhlTeamSchedule(
          id,
          value,
          leagueLogos,
          color,
          backgroundColor,
        );
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
      return [];
    }
  };

  getNhlTeamSchedule = async (
    id: string,
    value: string,
    leagueLogos: { string },
    color: string | undefined,
    backgroundColor: string | undefined,
  ) => {
    try {
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

        return {
          arenaName: venue?.default || '',
          awayTeam: `${awayTeam.placeName.default} ${awayTeam.commonName.default}`,
          awayTeamId: `${leagueName}-${awayTeam.abbrev}`,
          awayTeamLogo: leagueLogos[awayTeam.abbrev],
          awayTeamShort: awayTeam.abbrev,
          backgroundColor: backgroundColor || undefined,
          color: color || undefined,
          gameDate: gameDate,
          homeTeam: `${homeTeam.placeName.default} ${homeTeam.commonName.default}`,
          homeTeamId: `${leagueName}-${homeTeam.abbrev}`,
          homeTeamLogo: leagueLogos[homeTeam.abbrev],
          homeTeamShort: homeTeam.abbrev,
          league: leagueName,
          placeName: homeTeam.placeName.default,
          selectedTeam: homeTeam.abbrev === id,
          show: homeTeam.abbrev === id,
          startTimeUTC,
          teamSelectedId: value,
          isActive,
          uniqueId: `${value}-${gameDate}-1`,
          venueTimezone: venueTimezone,
        };
      });

      gamesData = gamesData.filter(
        (game) => game !== undefined && game !== null,
      );

      return gamesData;
    } catch (error) {
      console.error('Error fetching data', error);
      return {};
    }
  };
}
