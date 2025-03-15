export interface MLBGameAPI {
  timestamp: Date;
  status: string;
  season: RequestedSeasonClass;
  team: WelcomeTeam;
  events: Event[];
  requestedSeason: RequestedSeasonClass;
  byeWeek: number;
}

export interface Event {
  id: string;
  date: string;
  name: string;
  shortName: string;
  season: EventSeason;
  seasonType: SeasonType;
  week: Week;
  timeValid: boolean;
  competitions: Competition[];
  links: EventLink[];
}

export interface Competition {
  id: string;
  date: string;
  attendance: number;
  type: CompetitionType;
  timeValid: boolean;
  neutralSite: boolean;
  boxscoreAvailable: boolean;
  ticketsAvailable: boolean;
  venue: Venue;
  competitors: Competitor[];
  notes: Note[];
  broadcasts: Broadcast[];
  tickets: Ticket[];
  status: Status;
}

export interface Broadcast {
  type: BroadcastType;
  market: Market;
  media: Media;
  lang: Lang;
  region: Region;
}

export enum Lang {
  En = 'en',
}

export interface Market {
  id: string;
  type: MarketType;
}

export enum MarketType {
  National = 'National',
}

export interface Media {
  shortName: string;
}

export enum Region {
  Us = 'us',
}

export interface BroadcastType {
  id: string;
  shortName: ShortName;
}

export enum ShortName {
  Streaming = 'Streaming',
  Tv = 'TV',
}

export interface Competitor {
  id: string;
  type: CompetitorType;
  order: number;
  homeAway: HomeAway;
  team: CompetitorTeam;
}

export enum HomeAway {
  Away = 'away',
  Home = 'home',
}

export interface CompetitorTeam {
  id: string;
  location: string;
  nickname: string;
  abbreviation: string;
  displayName: string;
  shortDisplayName: string;
  logos: Logo[];
  links: TeamLink[];
}

export interface TeamLink {
  rel: CompetitorType[];
  href: string;
  text: PurpleText;
}

export enum CompetitorType {
  Clubhouse = 'clubhouse',
  Depthchart = 'depthchart',
  Desktop = 'desktop',
  Draftpicks = 'draftpicks',
  Injuries = 'injuries',
  Photos = 'photos',
  Roster = 'roster',
  Schedule = 'schedule',
  Stats = 'stats',
  Team = 'team',
  Tickets = 'tickets',
  Transactions = 'transactions',
}

export enum PurpleText {
  Clubhouse = 'Clubhouse',
  DepthChart = 'Depth Chart',
  DraftPicks = 'Draft Picks',
  Injuries = 'Injuries',
  Photos = 'photos',
  Roster = 'Roster',
  Schedule = 'Schedule',
  Statistics = 'Statistics',
  Tickets = 'Tickets',
  Transactions = 'Transactions',
}

export interface Logo {
  href: string;
  width: number;
  height: number;
  alt: string;
  rel: LogoRel[];
  lastUpdated: string;
}

export enum LogoRel {
  Dark = 'dark',
  Default = 'default',
  Full = 'full',
  Scoreboard = 'scoreboard',
}

export interface Note {
  type: NoteType;
  headline: string;
}

export enum NoteType {
  Desktop = 'desktop',
  Event = 'event',
  Tickets = 'tickets',
  Venue = 'venue',
}

export interface Status {
  clock: number;
  displayClock: DisplayClock;
  period: number;
  type: StatusType;
  isTBDFlex: boolean;
}

export enum DisplayClock {
  The000 = '0:00',
}

export interface StatusType {
  id: string;
  name: TypeName;
  state: State;
  completed: boolean;
  description: Description;
  detail: string;
  shortDetail: string;
}

export enum Description {
  Scheduled = 'Scheduled',
}

export enum TypeName {
  StatusScheduled = 'STATUS_SCHEDULED',
}

export enum State {
  Pre = 'pre',
}

export interface Ticket {
  id: string;
  summary: string;
  description: string;
  maxPrice: number;
  startingPrice: number;
  numberAvailable: number;
  totalPostings: number;
  links: TicketLink[];
}

export interface TicketLink {
  rel: NoteType[];
  href: string;
}

export interface CompetitionType {
  id: string;
  text: TypeText;
  abbreviation: TypeAbbreviation;
  slug: Slug;
  type: Slug;
}

export enum TypeAbbreviation {
  Std = 'STD',
}

export enum Slug {
  Standard = 'standard',
}

export enum TypeText {
  Standard = 'Standard',
}

export interface Venue {
  fullName: string;
  address: Address;
}

export interface Address {
  city: string;
  state: string;
  zipCode: string;
}

export interface EventLink {
  language: Language;
  rel: LinkRel[];
  href: string;
  text: FluffyText;
  shortText: ShortText;
  isExternal: boolean;
  isPremium: boolean;
}

export enum Language {
  EnUS = 'en-US',
}

export enum LinkRel {
  App = 'app',
  Desktop = 'desktop',
  Event = 'event',
  Now = 'now',
  Sportscenter = 'sportscenter',
  Summary = 'summary',
  Watchespn = 'watchespn',
}

export enum ShortText {
  Now = 'Now',
  Summary = 'Summary',
  WatchESPN = 'WatchESPN',
}

export enum FluffyText {
  Gamecast = 'Gamecast',
  Now = 'Now',
  WatchESPN = 'WatchESPN',
}

export interface EventSeason {
  year: number;
  displayName: string;
}

export interface SeasonType {
  id: string;
  type: number;
  name: SeasonTypeName;
  abbreviation: SeasonTypeAbbreviation;
}

export enum SeasonTypeAbbreviation {
  Reg = 'reg',
}

export enum SeasonTypeName {
  RegularSeason = 'Regular Season',
}

export interface Week {
  number: number;
  text: string;
}

export interface RequestedSeasonClass {
  year: number;
  type: number;
  name: string;
  displayName: string;
  half?: number;
}

export interface WelcomeTeam {
  id: string;
  abbreviation: string;
  location: string;
  name: string;
  displayName: string;
  clubhouse: string;
  color: string;
  logo: string;
  recordSummary: string;
  seasonSummary: string;
  standingSummary: string;
  groups: Groups;
}

export interface Groups {
  id: string;
  parent: Parent;
  isConference: boolean;
}

export interface Parent {
  id: string;
}
