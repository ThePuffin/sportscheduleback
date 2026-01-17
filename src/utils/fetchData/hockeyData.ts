import { League } from '../../utils/enum';
import type { GameFormatted } from '../../utils/interface/game';
import type { NHLGameAPI } from '../../utils/interface/gameNHL';
import type {
  PWHLResponse,
  TeamNHL,
  TeamPWHL,
  TeamType,
} from '../../utils/interface/team';
import { PWHLGameAPI } from '../interface/gamePWHL';
import { capitalize } from '../utils';
const leagueName = League.NHL;

export class HockeyData {
  async getNHLTeams(): Promise<TeamType[]> {
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

  async getPWHLTeams(): Promise<TeamType[]> {
    try {
      const leagueName = League.PWHL;

      const fetchedTeams = await fetch(
        'https://lscluster.hockeytech.com/feed/index.php?feed=modulekit&view=teamsbyseason&key=446521baf8c38984&client_code=pwhl',
      );
      const fetchTeams: PWHLResponse = await fetchedTeams.json();
      const allTeams: TeamPWHL[] = await fetchTeams?.SiteKit?.Teamsbyseason;
      const activeTeams = allTeams.map((team: TeamPWHL) => {
        const { code, name, team_logo_url, division_long_name } = team;
        const teamID = code;
        const uniqueId = `${leagueName}-${teamID}`;

        return {
          uniqueId,
          value: uniqueId,
          id: teamID,
          abbrev: teamID,
          label: capitalize(name),
          teamLogo: team_logo_url,
          teamCommonName: capitalize(name),
          conferenceName: '',
          divisionName: division_long_name,
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

  getHockeySchedule = async (activeTeams, leagueLogos, league) => {
    const allGames = {};
    await Promise.all(
      activeTeams.map(async (team) => {
        try {
          if (league === League.NHL) {
            const { id, value, color, backgroundColor } = team;
            const leagueID = `${leagueName}-${id}`;
            allGames[leagueID] = await this.getNHLTeamschedule(
              id,
              value,
              leagueLogos,
              color,
              backgroundColor,
            );
          }
          if (league === League.PWHL) {
            const { id, value, color, backgroundColor } = team;
            const leagueID = `${leagueName}-${id}`;
            allGames[leagueID] = await this.getPWHLTeamschedule(
              id,
              value,
              leagueLogos,
              color,
              backgroundColor,
            );
          }
        } catch (error) {
          console.error(
            `Error fetching schedule for hockey team ${error.id}:`,
            error,
          );
          throw team;
        }
      }),
    );

    for (const team of Object.keys(allGames)) {
      if (allGames[team].length === 0) {
        delete allGames[team];
      }
    }

    console.info('updated ', league);
    return allGames;
  };

  fetchGamesData = async (id: string, league: string) => {
    try {
      let fetchGames;
      if (league === League.NHL) {
        const fetchedGames = await fetch(
          `https://api-web.nhle.com/v1/club-schedule-season/${id}/now`,
        );
        const tempGames = await fetchedGames.json();

        fetchGames = await tempGames.games;
      }
      if (league === League.PWHL) {
        const fetchedGames = await fetch(
          `https://lscluster.hockeytech.com/feed/?feed=modulekit&view=schedule&key=446521baf8c38984&client_code=pwhl`,
        );
        const allFetchGames = (await fetchedGames.json()).SiteKit.Schedule;
        fetchGames = allFetchGames.filter(
          (game) =>
            game.home_team_code === id || game.visiting_team_code === id,
        );
        console.info('yes', id);
        return (await fetchGames.games) || fetchGames;
      }
      console.info('yes', id);
      return (await fetchGames.games) || fetchGames;
    } catch (error) {
      console.error('Error fetching games:', id, error);
      throw id;
    }
  };

  getPWHLTeamschedule = async (
    id: string,
    value: string,
    leagueLogos: { string },
    color: string | undefined,
    backgroundColor: string | undefined,
  ) => {
    const leagueName = League.PWHL;

    const games: PWHLGameAPI[] = await this.fetchGamesData(id, League.PWHL);
    if (!games || games.length === 0) {
      return [];
    }
    const gamesData: GameFormatted[] = games
      .map((game: PWHLGameAPI) => {
        const {
          home_team_code,
          visiting_team_code,
          home_team_name,
          visiting_team_name,
          home_team_city,
          visiting_team_city,
          venue_name,
          date_played,
          GameDateISO8601,
          timezone,
          venue_location,
        } = game;

        const now = new Date();
        const isActive = true;
        if (new Date(GameDateISO8601) < now) return;

        const awayTeamName = visiting_team_name.includes(visiting_team_city)
          ? visiting_team_name
          : `${visiting_team_city} ${visiting_team_name}`;
        const homeTeamName = home_team_name.includes(home_team_city)
          ? home_team_name
          : `${home_team_city} ${home_team_name}`;
        const arena = venue_name.split('|')[0];

        return {
          arenaName: capitalize(arena) || '',
          awayTeam: capitalize(awayTeamName),
          awayTeamId: `${leagueName}-${visiting_team_code}`,
          awayTeamLogo: leagueLogos[visiting_team_code],
          awayTeamShort: visiting_team_code,
          backgroundColor: backgroundColor || undefined,
          color: color || undefined,
          gameDate: date_played,
          homeTeam: capitalize(homeTeamName),
          homeTeamId: `${leagueName}-${home_team_code}`,
          homeTeamLogo: leagueLogos[home_team_code],
          homeTeamShort: home_team_code,
          homeTeamScore: null,
          awayTeamScore: null,
          league: leagueName,
          placeName: capitalize(venue_location),
          selectedTeam: home_team_code === id,
          show: home_team_code === id,
          startTimeUTC: new Date(GameDateISO8601).toISOString(),
          teamSelectedId: value,
          isActive,
          uniqueId: `${value}-${date_played}-${game.id}`,
          venueTimezone: timezone,
        };
      })
      .filter((game) => game !== undefined && game !== null);
    return gamesData;
  };

  getNHLTeamschedule = async (
    id: string,
    value: string,
    leagueLogos: { string },
    color: string | undefined,
    backgroundColor: string | undefined,
  ) => {
    const games: NHLGameAPI[] = await this.fetchGamesData(id, League.NHL);

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
        homeTeamScore: null,
        awayTeamScore: null,
        league: leagueName,
        placeName: capitalize(homeTeam.placeName.default),
        selectedTeam: homeTeam.abbrev === id,
        show: homeTeam.abbrev === id,
        startTimeUTC: new Date(startTimeUTC).toISOString(),
        teamSelectedId: value,
        isActive,
        uniqueId: `${value}-${gameDate}-1`,
        venueTimezone: venueTimezone,
      };
    });

    gamesData = gamesData.filter((game) => game !== undefined && game !== null);

    return gamesData;
  };

  getPWHLScores = async (date: string) => {
    try {
      const fetchedGames = await fetch(
        `https://lscluster.hockeytech.com/feed/?feed=modulekit&view=schedule&key=446521baf8c38984&client_code=pwhl`,
      );
      const response = await fetchedGames.json();
      const allGames: PWHLGameAPI[] = response.SiteKit.Schedule;

      return allGames
        .filter((game) => game.date_played === date)
        .map((game) => ({
          homeTeamScore: Number(game.home_goal_count),
          awayTeamScore: Number(game.visiting_goal_count),
          homeTeamShort: game.home_team_code,
          awayTeamShort: game.visiting_team_code,
          isFinal: game.final === '1',
          status: game.game_status,
          startTimeUTC: new Date(game.GameDateISO8601).toISOString(),
          uniqueId: game.id,
          gameDate: date,
          league: League.PWHL,
        }));
    } catch (error) {
      console.error('Error fetching PWHL scores:', error);
      return [];
    }
  };
}
