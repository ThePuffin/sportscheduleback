export interface ScoreboardESPN {
  leagues: League[];
  season: Season;
  day: Day;
  events: Event[];
}

export interface Day {
  date: string;
}

export interface Event {
  id: string;
  uid: string;
  date: string;
  name: string;
  shortName: string;
  season: Season;
  competitions: Competition[];
  status: Status;
  venue: EventVenue;
  links: Link[];
}

export interface Competition {
  id: string;
  uid: string;
  date: string;
  startDate: string;
  attendance: number;
  timeValid: boolean;
  recent: boolean;
  status: Status;
  venue: CompetitionVenue;
  tickets: Ticket[];
  format: Format;
  notes: any[];
  geoBroadcasts: GeoBroadcast[];
  broadcasts: Broadcast[];
  broadcast: string;
  competitors: Competitor[];
  details: any[];
  odds: Odd[];
  wasSuspended: boolean;
  playByPlayAvailable: boolean;
  playByPlayAthletes: boolean;
}

export interface Broadcast {
  market: string;
  names: string[];
}

export interface Competitor {
  id: string;
  uid: string;
  type: string;
  order: number;
  homeAway: string;
  winner: boolean;
  form: string;
  score: string;
  team: Team;
  statistics: any[];
  leaders: Leader[];
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
  displayName: string;
  shortName: string;
  fullName: string;
  jersey: string;
  active: boolean;
  team: Team;
  headshot: string;
  links: Link[];
  position: Position;
}

export interface Link {
  language?: string;
  rel: string[];
  href: string;
  text?: string;
  shortText?: string;
  isExternal: boolean;
  isPremium: boolean;
  isHidden: boolean;
  tracking?: Tracking;
}

export interface Tracking {
  campaign: string;
  tags: Tags;
}

export interface Tags {
  league: string;
  sport: string;
  gameId: number;
  betSide: string;
  betType: string;
  betDetails?: string;
}

export interface Position {
  abbreviation: string;
}

export interface Team {
  id: string;
}

export interface Format {
  regulation: Regulation;
}

export interface Regulation {
  periods: number;
}

export interface GeoBroadcast {
  type: GeoBroadcastType;
  market: Market;
  media: Media;
  lang: string;
  region: string;
}

export interface Market {
  id: string;
  type: string;
}

export interface Media {
  shortName: string;
}

export interface GeoBroadcastType {
  id: string;
  shortName: string;
}

export interface Odd {
  provider: Provider;
  awayTeamOdds?: TeamOdds;
  homeTeamOdds?: TeamOdds;
  drawOdds?: DrawOdds;
  overUnder?: number;
  link?: Link;
  total?: Total;
  pointSpread?: PointSpread;
  moneyline?: Moneyline;
  details?: string;
}

export interface TeamOdds {
  summary?: string;
  value?: number;
  handicap?: number;
  team: Team;
  link: Link;
  favorite?: boolean;
  underdog?: boolean;
  moneyLine?: number;
  spreadOdds?: number;
}

export interface DrawOdds {
  summary?: string;
  value?: number;
  handicap?: number;
  link: Link;
  moneyLine?: number;
}

export interface Moneyline {
  displayName: string;
  shortDisplayName: string;
  home: Away;
  away: Away;
  draw: Away;
}

export interface Away {
  open: Close;
  close: Close;
}

export interface Close {
  odds: string;
  link?: Link;
  line?: string;
}

export interface PointSpread {
  displayName: string;
  shortDisplayName: string;
  home: Away;
  away: Away;
}

export interface Provider {
  id: string;
  name: string;
  priority: number;
}

export interface Total {
  displayName: string;
  shortDisplayName: string;
  over: Under;
  under: Under;
}

export interface Under {
  open: Close;
  close: Close;
}

export interface Status {
  clock: number;
  displayClock: string;
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

export interface Ticket {
  summary: string;
  numberAvailable: number;
  links: Link[];
}

export interface CompetitionVenue {
  id: string;
  fullName: string;
  address: Address;
}

export interface Address {
  city: string;
  country: string;
}

export interface EventVenue {
  displayName: string;
}

export interface League {
  id: string;
  uid: string;
  name: string;
  abbreviation: string;
  midsizeName: string;
  slug: string;
  season: Season;
  logos: Logo[];
  calendarType: string;
  calendarIsWhitelist: boolean;
  calendarStartDate: string;
  calendarEndDate: string;
  calendar: string[];
}

export interface Logo {
  href: string;
  width: number;
  height: number;
  alt: string;
  rel: string[];
  lastUpdated: string;
}

export interface Season {
  year: number;
  startDate?: string;
  endDate?: string;
  displayName?: string;
  type?: SeasonType;
}

export interface SeasonType {
  id: string;
  type: number;
  name: string;
  abbreviation: string;
}
