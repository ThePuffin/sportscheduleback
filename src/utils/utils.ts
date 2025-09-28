import { League } from './enum';

export const randomNumber = (max) => {
  return Math.floor(Math.random() * (max - 0 + 1) + 0);
};

export const capitalize = (str = '') => {
  if (str?.length === 0) return str;
  return str.replace(
    /(^\w|\s\w)(\S*)/g,
    (_, m1, m2) => m1.toUpperCase() + m2.toLowerCase(),
  );
};

const leagueConfigs = {
  [League.NHL]: {
    sport: 'hockey',
    league: 'nhl',
    startSeason: '10',
    endSeason: '04',
    endPlayoffs: '06',
  },
  [League.MLB]: {
    sport: 'baseball',
    league: 'mlb',
    startSeason: '03',
    endSeason: '09',
    endPlayoffs: '11',
  },
  [League.NBA]: {
    sport: 'basketball',
    league: 'nba',
    startSeason: '10',
    endSeason: '04',
    endPlayoffs: '06',
  },
  [League.WNBA]: {
    sport: 'basketball',
    league: 'wnba',
    startSeason: '05',
    endSeason: '09',
    endPlayoffs: '10',
  },
  [League.NFL]: {
    sport: 'football',
    league: 'nfl',
    startSeason: '09',
    endSeason: '01',
    endPlayoffs: '02',
  },
};

const isInThePeriod = (start: string, end: string) => {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  const startMonth = parseInt(start, 10) - 1;
  const endMonth = parseInt(end, 10) - 1;

  if (startMonth <= endMonth) {
    // Season is within the same calendar year (e.g., March to September)
    const startSeason = new Date(year, startMonth, 1);
    const endSeason = new Date(year, endMonth + 1, 0); // Last day of end month
    return today >= startSeason && today <= endSeason;
  } else {
    // Season spans across two calendar years (e.g., October to April)
    const seasonStartYear = month >= startMonth ? year : year - 1;
    const startSeason = new Date(seasonStartYear, startMonth, 1);
    const endSeason = new Date(seasonStartYear + 1, endMonth + 1, 0); // Last day of end month in next year
    return today >= startSeason && today <= endSeason;
  }
};

const isCurrentSeason = (leagueName: string) => {
  const { startSeason, endSeason } = leagueConfigs[leagueName];
  return isInThePeriod(startSeason, endSeason);
};

const isendPlayoffs = (leagueName: string) => {
  const { endPlayoffs, endSeason } = leagueConfigs[leagueName];
  return isInThePeriod(endSeason, endPlayoffs);
};

const numberOfDaysToRefresh = (leagueName: string) => {
  if (isendPlayoffs(leagueName)) return 1;
  if (isCurrentSeason(leagueName)) return 3;
  return 7;
};

export const needRefresh = (leagueName: string, games) => {
  const daysToRefresh = numberOfDaysToRefresh(leagueName);
  const keys = Object.keys(games);
  if (keys.length === 0) return true;
  let teamRefreshNeeded = [];

  const firstkey = keys[0];
  const firstGame = games[firstkey][0];
  const lastRefresh = new Date(firstGame.updateDate || '2025-01-01');
  const now = new Date();
  const diffDays = Math.round(
    (now.getTime() - lastRefresh.getTime()) / (1000 * 60 * 60 * 24),
  );
  teamRefreshNeeded.push(diffDays >= daysToRefresh);
  return !teamRefreshNeeded.some((need) => need === false);
};
