import { League } from '../../utils/enum';
const venueTimezone = 'America/New_York';
import { readableDate } from '../../utils/date';
let gameDates = [];

export const getNBASchedule = async () => {
  try {
    const scheduleEndpoint =
      'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json';
    const fetchSchedule = await fetch(scheduleEndpoint);
    const { leagueSchedule } = await fetchSchedule.json();
    if (leagueSchedule.gameDates.length) {
      gameDates = leagueSchedule.gameDates;
    }
  } catch (error) {
    console.error('no NBA schedule : ', error);
    let gamesDates = [];
  }
};
export const clearNbaSchedule = () => {
  gameDates = [];
};

export const filterGamesByTeam = (team, value, leagueLogos) => {
  const teamTricodeMap = {
    GS: 'GSW',
    NO: 'NOP',
    NY: 'NYK',
    SA: 'SAS',
    UTAH: 'UTA',
    WSH: 'WAS',
  };
  const inverseTeamTricodeMap = {
    GSW: 'GS',
    NOP: 'NO',
    NYK: 'NY',
    SAS: 'SA',
    UTA: 'UTAH',
    WAS: 'WSH',
  };

  const teamTricode = teamTricodeMap[team] || team;

  return gameDates
    .map(({ gameDate, games }) => {
      const filterGame = games.filter(
        (game) =>
          game.homeTeam.teamTricode === teamTricode ||
          game.awayTeam.teamTricode === teamTricode,
      );
      if (filterGame.length) {
        const gameDateRead = readableDate(new Date(gameDate));
        const { arenaName, homeTeam, awayTeam, gameDateTimeUTC } =
          filterGame[0];
        const awayAbbrev =
          inverseTeamTricodeMap[awayTeam.teamTricode] || awayTeam.teamTricode;
        const homeAbbrev =
          inverseTeamTricodeMap[homeTeam.teamTricode] || homeTeam.teamTricode;

        const date = new Date(gameDateTimeUTC);
        const hourStart = String(date.getHours()).padStart(2, '0');
        const minStart = String(date.getMinutes()).padStart(2, '0');

        return {
          uniqueId: `${value}-${gameDateRead}-1`,
          arenaName: arenaName || '',
          awayTeamId: `${League.NBA}-${awayAbbrev}`,
          awayTeam: `${awayTeam.teamCity} ${awayTeam.teamName}`,
          awayTeamShort: awayAbbrev,
          awayTeamLogo: leagueLogos[awayAbbrev],
          homeTeam: `${homeTeam.teamCity} ${homeTeam.teamName}`,
          homeTeamId: `${League.NBA}-${homeAbbrev}`,
          homeTeamShort: homeAbbrev,
          homeTeamLogo: leagueLogos[homeAbbrev],
          gameDate: gameDateRead,
          teamSelectedId: value,
          show: homeAbbrev === team,
          selectedTeam: homeAbbrev === team,
          league: League.NBA,
          venueTimezone,
          timeStart: `${hourStart}:${minStart}`,
          startTimeUTC: gameDateTimeUTC,
        };
      }
    })
    .filter((game) => game?.uniqueId);
};
