import { League } from '../../utils/enum';
let gameDates = [];
const venueTimezone = 'America/Los_Angeles';

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

export const filterGamesByTeam = (
  team,
  value,
  leagueLogos,
  color,
  backgroundColor,
) => {
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
        const { arenaName, gameDateEst, homeTeam, awayTeam, gameDateTimeUTC } =
          filterGame[0];
        const awayAbbrev =
          inverseTeamTricodeMap[awayTeam.teamTricode] || awayTeam.teamTricode;
        const homeAbbrev =
          inverseTeamTricodeMap[homeTeam.teamTricode] || homeTeam.teamTricode;

        const date = new Date(gameDateTimeUTC);
        const gameDateRead = gameDateEst.split('T')[0];
        const hourStart = String(date.getHours()).padStart(2, '0');
        const minStart = String(date.getMinutes()).padStart(2, '0');
        if (new Date(gameDateTimeUTC) < new Date()) return;

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
          color: color || undefined,
          backgroundColor: backgroundColor || undefined,
        };
      }
    })
    .filter((game) => game?.uniqueId);
};
