/**
 * Fichier statique de fallback pour les équipes historiques (disparues,
 * déménagées ou renommées). Même rôle que `UniversityLogos`, mais ici la clé
 * est le `uniqueId` complet `'{LIGUE}-{ABBREV}'`, identique au format utilisé
 * par `homeTeamId` / `awayTeamId` des matchs (`ESPN-...`).
 *
 * Il sert dans `GameService._enrichGameWithTeamData` : quand une équipe d'un
 * vieux match n'a plus de fiche en base, on retombe ici pour récupérer son
 * nom, son logo et ses couleurs afin que l'affichage des "oldies" soit correct.
 *
 * ⚠️ Pour RÉCUPÉRER de nouveaux matchs impliquant d'anciennes équipes, ce
 * fichier ne suffit pas : le fetch des calendriers ESPN a besoin de l'`id`
 * numérique de l'équipe (voir le sync `seasons/{year}/teams` du Core API).
 * Ce fichier ne résout que l'ENRICHISSEMENT/affichage des matchs déjà en base.
 */
export interface HistoricalTeamEntry {
  abbrev: string;
  label: string;
  teamLogo: string;
  teamLogoDark?: string;
  color?: string;
  backgroundColor?: string;
  // Optionnel : bilan affiché sur le match (ex. "57-25").
  record?: string;
  // Toujours false pour une équipe historique : ne doit jamais apparaître dans
  // les constantes front (Teams.tsx / favoris / filtre).
  isActive?: boolean;
}

const combo = (sport: string, abbrev: string) =>
  `https://a.espncdn.com/combiner/i?img=/i/teamlogos/${sport}/500/${abbrev}.png&w=256&h=256&transparent=true`;

export const HistoricalTeams: Record<string, HistoricalTeamEntry> = {
  // ---------- NBA ----------
  'NBA-SEA': {
    abbrev: 'SEA',
    label: 'Seattle SuperSonics',
    teamLogo: combo('nba', 'seattle'),
    color: '#005083',
    backgroundColor: '#C8102E',
    isActive: false,
  },
  'NBA-VAN': {
    abbrev: 'VAN',
    label: 'Vancouver Grizzlies',
    teamLogo: combo('nba', 'vancouver'),
    color: '#001E62',
    backgroundColor: '#0072CE',
    isActive: false,
  },
  'NBA-CHH': {
    abbrev: 'CHH',
    label: 'Charlotte Hornets',
    teamLogo: combo('nba', 'hornets'),
    color: '#1D1160',
    backgroundColor: '#00788C',
    isActive: false,
  },
  'NBA-NJN': {
    abbrev: 'NJN',
    label: 'New Jersey Nets',
    teamLogo: combo('nba', 'nets'),
    color: '#003C71',
    backgroundColor: '#000000',
    isActive: false,
  },
  'NBA-NOH': {
    abbrev: 'NOH',
    label: 'New Orleans Hornets',
    teamLogo: combo('nba', 'hornets'),
    color: '#C8102E',
    backgroundColor: '#00778B',
    isActive: false,
  },
  // ---------- NHL ----------
  'NHL-ATL': {
    abbrev: 'ATL',
    label: 'Atlanta Thrashers',
    teamLogo: combo('nhl', 'atl'),
    color: '#BA9653',
    backgroundColor: '#041E42',
    isActive: false,
  },
  'NHL-QUE': {
    abbrev: 'QUE',
    label: 'Quebec Nordiques',
    teamLogo: combo('nhl', 'que'),
    color: '#003DA5',
    backgroundColor: '#C8102E',
    isActive: false,
  },
  'NHL-HAR': {
    abbrev: 'HAR',
    label: 'Hartford Whalers',
    teamLogo: combo('nhl', 'har'),
    color: '#006B54',
    backgroundColor: '#000000',
    isActive: false,
  },
  'NHL-WIN': {
    abbrev: 'WIN',
    label: 'Winnipeg Jets',
    teamLogo: combo('nhl', 'win'),
    color: '#003778',
    backgroundColor: '#0047AB',
    isActive: false,
  },
  'NHL-PHX': {
    abbrev: 'PHX',
    label: 'Phoenix Coyotes',
    teamLogo: combo('nhl', 'phx'),
    color: '#8A1C1C',
    backgroundColor: '#B4975A',
    isActive: false,
  },
  // ---------- MLB ----------
  'MLB-MON': {
    abbrev: 'MON',
    label: 'Montreal Expos',
    teamLogo: combo('mlb', 'mon'),
    color: '#003087',
    backgroundColor: '#E81828',
    isActive: false,
  },
  'MLB-BRO': {
    abbrev: 'BRO',
    label: 'Brooklyn Dodgers',
    teamLogo: combo('mlb', 'bro'),
    color: '#003399',
    backgroundColor: '#FFFFFF',
    isActive: false,
  },
  'MLB-PHA': {
    abbrev: 'PHA',
    label: 'Philadelphia Athletics',
    teamLogo: combo('mlb', 'pha'),
    color: '#0A2342',
    backgroundColor: '#FFFFFF',
    isActive: false,
  },
  'MLB-SEP': {
    abbrev: 'SEP',
    label: 'Seattle Pilots',
    teamLogo: combo('mlb', 'sea'),
    color: '#004C93',
    backgroundColor: '#F5A623',
    isActive: false,
  },
  // ---------- NFL ----------
  'NFL-HOU': {
    abbrev: 'HOU',
    label: 'Houston Oilers',
    teamLogo: combo('nfl', 'hou'),
    color: '#0C2340',
    backgroundColor: '#A71930',
    isActive: false,
  },
  'NFL-STL': {
    abbrev: 'STL',
    label: 'St. Louis Rams',
    teamLogo: combo('nfl', 'stl'),
    color: '#002244',
    backgroundColor: '#C7A252',
    isActive: false,
  },
  'NFL-OAK': {
    abbrev: 'OAK',
    label: 'Oakland Raiders',
    teamLogo: combo('nfl', 'oak'),
    color: '#000000',
    backgroundColor: '#A5ACAF',
    isActive: false,
  },
  'NFL-SDG': {
    abbrev: 'SDG',
    label: 'San Diego Chargers',
    teamLogo: combo('nfl', 'sdg'),
    color: '#0072CE',
    backgroundColor: '#FFC20E',
    isActive: false,
  },
};

/**
 * Retourne la portion d'une clé `uniqueId` qui désigne la ligue
 * (partie avant le premier '-'), ex. `NBA-SEA` -> `NBA`.
 */
export const historicalTeamLeagueOf = (uniqueId: string): string =>
  (uniqueId || '').split('-')[0] || '';