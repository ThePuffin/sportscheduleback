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

export const getLuminance = (hex: string) => {
  const c = hex.replace(/#/g, '');
  const rgb = Number.parseInt(c, 16);
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = (rgb >> 0) & 0xff;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
  [League.MLS]: {
    sport: 'soccer',
    league: 'usa.1',
    startSeason: '05',
    endSeason: '10',
    endPlayoffs: '11',
  },
  [League.PWHL]: {
    sport: 'hockey',
    league: 'pwhl',
    startSeason: '11',
    endSeason: '04',
    endPlayoffs: '06',
  },
};

const getLeagueConfig = (leagueName: string) => {
  if (
    leagueName === League.OLYMPICS_MEN ||
    leagueName === League.OLYMPICS_WOMEN
  ) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();

    // Winter Olympics (Hockey): 2026, 2030... (Year % 4 === 2)
    // Active roughly Dec (year-1) to March (year)
    if (
      ((year + 1) % 4 === 2 && month === 11) ||
      (year % 4 === 2 && month <= 3)
    ) {
      return {
        sport: 'hockey',
        league:
          leagueName === League.OLYMPICS_WOMEN
            ? 'olympics.women'
            : 'olympics.men',
        startSeason: '12',
        endSeason: '02',
        endPlayoffs: '03',
      };
    }

    // Summer Olympics (Basketball): 2028, 2032... (Year % 4 === 0)
    // Active roughly May to Aug
    if (year % 4 === 0 && month >= 4 && month <= 7) {
      return {
        sport: 'basket',
        league:
          leagueName === League.OLYMPICS_WOMEN
            ? 'olympics.women'
            : 'olympics.men',
        startSeason: '05',
        endSeason: '06',
        endPlayoffs: '07',
      };
    }

    // Off-season / No Olympics this year
    return {
      sport: 'hockey',
      league: 'olympics',
      startSeason: '99',
      endSeason: '99',
      endPlayoffs: '99',
    };
  }
  return leagueConfigs[leagueName];
};

const isInThePeriod = (start: string, end: string) => {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  const startMonth = Number.parseInt(start, 10) - 1;
  const endMonth = Number.parseInt(end, 10) - 1;

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
  const config = getLeagueConfig(leagueName);
  if (!config) {
    return true;
  }
  const { startSeason, endSeason } = config;
  return isInThePeriod(startSeason, endSeason);
};

const isendPlayoffs = (leagueName: string) => {
  const config = getLeagueConfig(leagueName);
  if (!config) {
    return false;
  }
  const { endPlayoffs, endSeason } = config;
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
  const teamRefreshNeeded = [];

  const firstkey = keys[0];
  const firstGame = games[firstkey][0];
  const lastRefresh = new Date(firstGame.updateDate || '2025-01-01');
  const now = new Date();
  const diffDays = Math.round(
    (now.getTime() - lastRefresh.getTime()) / (1000 * 60 * 60 * 24),
  );
  teamRefreshNeeded.push(diffDays >= daysToRefresh);
  return !teamRefreshNeeded.includes((need) => need === false);
};
