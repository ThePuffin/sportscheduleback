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
  if (isNaN(rgb)) return NaN;
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
    endPlayoffs: '10',
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
    startSeason: '02',
    endSeason: '10',
    endPlayoffs: '12',
  },
  [League.PWHL]: {
    sport: 'hockey',
    league: 'pwhl',
    startSeason: '11',
    endSeason: '04',
    endPlayoffs: '06',
  },
  [League.NCAAF]: {
    sport: 'football',
    league: 'college-football',
    startSeason: '08',
    endSeason: '12',
    endPlayoffs: '01',
  },
  [League.NCAAB]: {
    sport: 'basketball',
    league: 'mens-college-basketball',
    startSeason: '11',
    endSeason: '03',
    endPlayoffs: '04',
  },
  [League.WNCAAB]: {
    sport: 'basketball',
    league: 'womens-college-basketball',
    startSeason: '11',
    endSeason: '03',
    endPlayoffs: '04',
  },
  [League.NCCABB]: {
    sport: 'baseball',
    league: 'college-baseball',
    startSeason: '02',
    endSeason: '05',
    endPlayoffs: '06',
  },
  [League.NCAAMH]: {
    sport: 'hockey',
    league: 'mens-college-hockey',
    startSeason: '10',
    endSeason: '03',
    endPlayoffs: '04',
  },
  [League.NCAAWH]: {
    sport: 'hockey',
    league: 'womens-college-hockey',
    startSeason: '09',
    endSeason: '02',
    endPlayoffs: '03',
  },
  [League.NCAAS]: {
    sport: 'softball',
    league: 'college-softball',
    startSeason: '02',
    endSeason: '05',
    endPlayoffs: '06',
  },
  [League.NWSL]: {
    sport: 'soccer',
    league: 'usa.nwsl',
    startSeason: '03',
    endSeason: '10',
    endPlayoffs: '11',
  },
};

export const getLeagueConfig = (leagueName: string) => {
  if (
    leagueName === League['OLYMPICS-MEN'] ||
    leagueName === League['OLYMPICS-WOMEN']
  ) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed: 0 = Jan, 1 = Feb...

    const isWomen = leagueName === League['OLYMPICS-WOMEN'];
    const leagueId = isWomen ? 'olympics.women' : 'olympics.men';

    // --- Winter Olympics (Hockey) : 2026, 2030, 2034 ---
    // Calculation: 2026 % 4 = 2
    if (year % 4 === 2) {
      // The Winter Olympics last approximately 3 weeks in February (Month index 1)
      if (month <= 2) {
        // Actif de Janvier à Mars pour couvrir prépa + tournoi
        return {
          sport: 'hockey',
          league: leagueId,
          startSeason: '01',
          endSeason: '02',
          endPlayoffs: '03',
        };
      }
    }

    // --- Summer Olympics (Basket) : 2024, 2028, 2032 ---
    // Calculation: 2028 % 4 = 0
    if (year % 4 === 0) {
      // The Summer Olympics take place in July/August (Month index 6 and 7)
      if (month >= 4 && month <= 8) {
        // Active from May to September
        return {
          sport: 'basket',
          league: leagueId,
          startSeason: '05',
          endSeason: '07',
          endPlayoffs: '09',
        };
      }
    }

    // Off-season or year without Olympics
    return {
      sport: 'none',
      league: 'olympics',
      startSeason: '99',
      endSeason: '99',
      endPlayoffs: '99',
    };
  }

  return leagueConfigs[leagueName];
};
export const isInThePeriod = (start: string, end: string) => {
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
  const firstkey = keys[0];
  const firstGame = games[firstkey][0];
  if (!firstGame.updateDate) return true;
  const now = new Date();
  const lastRefresh = new Date(firstGame.updateDate || '2025-01-01');

  const diffDays = Math.round(
    (now.getTime() - lastRefresh.getTime()) / (1000 * 60 * 60 * 24),
  );

  return diffDays >= daysToRefresh;
};
