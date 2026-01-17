export interface GameFormatted {
  uniqueId: string;
  awayTeamId: string;
  awayTeam: string;
  awayTeamShort: string;
  awayTeamLogo: string;
  awayTeamLogoDark: string;
  awayTeamScore: number | null;
  homeTeamScore: number | null;
  homeTeamId: string;
  homeTeam: string;
  homeTeamShort: string;
  homeTeamLogo: string;
  homeTeamLogoDark: string;
  homeTeamRecord?: string;
  awayTeamRecord?: string;
  arenaName: string;
  placeName: string;
  gameDate: string;
  teamSelectedId: string;
  show: boolean;
  selectedTeam: boolean;
  league: string;
  updateDate?: Date;
  venueTimezone?: string;
  isActive?: boolean;
  color?: string;
  backgroundColor?: string;
}

export interface GameESPN {
  id: string;
  uid: string;
  date: string;
  name: string;
  shortName: string;
  season: Season;
  competitions: Competition[];
  links: Link[];
  status: Status;
}

export interface Competition {
  id: string;
  uid: string;
  date: string;
  attendance: number;
  timeValid: boolean;
  neutralSite: boolean;
  conferenceCompetition: boolean;
  playByPlayAvailable: boolean;
  recent: boolean;
  competitors: Competitor[];
  notes: any[];
  situation: Situation;
  status: Status;
  type: CompetitionType;
  venue: Venue;
  leaders?: Leader[];
}

export interface Competitor {
  id: string;
  uid: string;
  type: string;
  order: number;
  homeAway: string;
  winner: boolean;
  team: Team;
  score: string;
  linescores: Linescore[];
  statistics: any[];
  records: Record[];
  leaders?: Leader[];
}

export interface Leader {
  name: string;
  displayName: string;
  shortDisplayName: string;
  abbreviation: string;
  leaders: LeaderElement[];
}

export interface LeaderElement {
  displayValue: string;
  value: number;
  athlete: Athlete;
  team: Team;
}

export interface Athlete {
  id: string;
  fullName: string;
  displayName: string;
  shortName: string;
  links: Link[];
  headshot: string;
  jersey: string;
  position: Position;
  team: Team;
  active: boolean;
}

export interface Link {
  rel: string[];
  href: string;
  text?: string;
}

export interface Position {
  abbreviation: string;
}

export interface Team {
  id: string;
  uid?: string;
  location?: string;
  name?: string;
  abbreviation?: string;
  displayName?: string;
  shortDisplayName?: string;
  color?: string;
  alternateColor?: string;
  logo?: string;
  links?: Link[];
  conferenceId?: string;
}

export interface Linescore {
  value: number;
}

export interface Record {
  name: string;
  abbreviation?: string;
  type: string;
  summary: string;
}

export interface Situation {
  lastPlay: LastPlay;
  downDistanceText?: string;
  possessionText?: string;
  down?: number;
  distance?: number;
  possession?: string;
  yardLine?: number;
  team?: Team;
}

export interface LastPlay {
  id: string;
  type: LastPlayType;
  text: string;
  scoreValue: number;
  team: Team;
  probability: Probability;
  drive: Drive;
  start: End;
  end: End;
  statYardage: number;
}

export interface Drive {
  description: string;
  start: End;
  timeElapsed: TimeElapsed;
}

export interface End {
  yardLine: number;
  team: Team;
}

export interface TimeElapsed {
  displayValue: string;
}

export interface Probability {
  tiePercentage: number;
  homeWinPercentage: number;
  awayWinPercentage: number;
  secondsLeft: number;
}

export interface LastPlayType {
  id: string;
  text: string;
  abbreviation: string;
}

export interface Status {
  clock: number;
  displayClock: string;
  period: number;
  type: StatusType;
}

export interface StatusType {
  id: string;
  name: string;
  state: string;
  completed: boolean;
  description: string;
  detail: string;
  shortDetail: string;
}

export interface CompetitionType {
  id: string;
  abbreviation: string;
}

export interface Venue {
  id: string;
  fullName: string;
  address: Address;
  capacity: number;
  indoor: boolean;
}

export interface Address {
  city: string;
  state: string;
}

export interface Season {
  year: number;
  type: number;
  slug: string;
}
