/**
 * Static fallback file for historical teams (defunct, relocated, or renamed).
 * Same purpose as `UniversityLogos`, but here the key is the full `uniqueId`
 * `'{LEAGUE}-{ABBREV}'`, identical to the format used by `homeTeamId` / `awayTeamId`
 * in games (`ESPN-...`).
 *
 * It is used in `GameService._enrichGameWithTeamData`: when a team from an
 * old game no longer has an entry in the database, it falls back here to retrieve
 * its name, logo, and colors so that the display for "oldies" remains correct.
 *
 * ⚠️ To FETCH new games involving former teams, this file is not enough:
 * fetching ESPN schedules requires the team's numeric `id` (see the
 * `seasons/{year}/teams` sync in the Core API).
 * This file only resolves the ENRICHMENT/display of games already stored in the database.
 */

export interface HistoricalTeamEntry {
  abbrev: string;
  label: string;
  teamLogo: string;
  teamLogoDark?: string;
  color?: string;
  backgroundColor?: string;
  isActive?: boolean;
  record: string;
}

export const HistoricalTeams: Record<string, HistoricalTeamEntry> = {
  // ---------- NHL ----------
  'NHL-ATL': {
    abbrev: 'ATL',
    label: 'Atlanta Thrashers',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/nhl/500/atl.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/nhl/500/atl.png',
    color: '#BA9653',
    backgroundColor: '#041E42',
    isActive: false,
    record: '0-0-0',
  },
  'NHL-PHX': {
    abbrev: 'PHX',
    label: 'Phoenix Coyotes',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/nhl/500/phx.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/nhl/500/phx.png',
    color: '#8A1C1C',
    backgroundColor: '#B4975A',
    isActive: false,
    record: '0-0-0',
  },
  'NHL-ARI': {
    abbrev: 'ARI',
    label: 'Arizona Coyotes',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/nhl/500/ari.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/nhl/500/ari.png',
    color: '#8C2633',
    backgroundColor: '#E2D6B5',
    isActive: false,
    record: '0-0-0',
  },

  // ---------- NBA ----------
  'NBA-NJN': {
    abbrev: 'NJN',
    label: 'New Jersey Nets',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/nba/500-dark/nj.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/nba/500-dark/nj.png',
    color: '#003C71',
    backgroundColor: '#000000',
    isActive: false,
    record: '0-0-0',
  },
  'NBA-NOH': {
    abbrev: 'NOH',
    label: 'New Orleans Hornets',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/nba/500/noh.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/nba/500/noh.png',
    color: '#C8102E',
    backgroundColor: '#00778B',
    isActive: false,
    record: '0-0-0',
  },

  // ---------- NFL ----------
  'NFL-STL': {
    abbrev: 'STL',
    label: 'St. Louis Rams',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/nfl/500/stl.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/nfl/500/stl.png',
    color: '#002244',
    backgroundColor: '#C7A252',
    isActive: false,
    record: '0-0-0',
  },
  'NFL-SDG': {
    abbrev: 'SDG',
    label: 'San Diego Chargers',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/nfl/500/sdg.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/nfl/500/sdg.png',
    color: '#0072CE',
    backgroundColor: '#FFC20E',
    isActive: false,
    record: '0-0-0',
  },
  'NFL-OAK': {
    abbrev: 'OAK',
    label: 'Oakland Raiders',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/nfl/500/oak.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/nfl/500/oak.png',
    color: '#000000',
    backgroundColor: '#A5ACAF',
    isActive: false,
    record: '0-0-0',
  },
  'NFL-WAS': {
    abbrev: 'WAS',
    label: 'Washington Redskins',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/nfl/500/was.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/nfl/500/was.png',
    color: '#5A1414',
    backgroundColor: '#FFC20E',
    isActive: false,
    record: '0-0-0',
  },

  // ---------- MLB ----------
  'MLB-OAK': {
    abbrev: 'OAK',
    label: 'Oakland Athletics',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/mlb/500/oak.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/mlb/500/oak.png',
    color: '#003831',
    backgroundColor: '#EFB21E',
    isActive: false,
    record: '0-0-0',
  },

  // ---------- MLS ----------
  'MLS-CHV': {
    abbrev: 'CHV',
    label: 'Chivas USA',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/soccer/500/chv.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/soccer/500/chv.png',
    color: '#C8102E',
    backgroundColor: '#002D62',
    isActive: false,
    record: '0-0-0',
  },

  // ---------- WNBA ----------
  'WNBA-TUL': {
    abbrev: 'TUL',
    label: 'Tulsa Shock',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/wnba/500/tul.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/wnba/500/tul.png',
    color: '#C4D600',
    backgroundColor: '#002B5C',
    isActive: false,
    record: '0-0-0',
  },
  'WNBA-SAS': {
    abbrev: 'SAS',
    label: 'San Antonio Stars',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/wnba/500/sas.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/wnba/500/sas.png',
    color: '#000000',
    backgroundColor: '#BAC0E6',
    isActive: false,
    record: '0-0-0',
  },

  // ---------- NWSL ----------
  'NWSL-WNY': {
    abbrev: 'WNY',
    label: 'Western New York Flash',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/soccer/500/wny.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/soccer/500/wny.png',
    color: '#C8102E',
    backgroundColor: '#002D62',
    isActive: false,
    record: '0-0-0',
  },
  'NWSL-FCKC': {
    abbrev: 'KC',
    label: 'FC Kansas City',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/soccer/500/fckc.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/soccer/500/fckc.png',
    color: '#00A3E0',
    backgroundColor: '#002B49',
    isActive: false,
    record: '0-0-0',
  },
  'NWSL-BOS': {
    abbrev: 'BOS',
    label: 'Boston Breakers',
    teamLogo: 'https://a.espncdn.com/i/teamlogos/soccer/500/bos.png',
    teamLogoDark: 'https://a.espncdn.com/i/teamlogos/soccer/500/bos.png',
    color: '#002B5C',
    backgroundColor: '#C8102E',
    isActive: false,
    record: '0-0-0',
  },
};

export const historicalTeamLeagueOf = (uniqueId: string): string =>
  (uniqueId || '').split('-')[0] || '';
