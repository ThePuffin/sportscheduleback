export interface CollegeRanking {
  sports: Sport[];
  leagues: League[];
  rankings: Ranking[];
  droppedOut: DroppedOutTeam[];
  latestSeason: Season;
  latestWeek: Week;
  weekCounts: WeekCount[];
  weeks: WeekInfo[];
  requestedSeason: RequestedSeason;
  availableRankings: AvailableRanking[];
}

interface Sport {
  $ref: string;
  id: string;
  guid: string;
  uid: string;
  name: string;
  displayName: string;
  slug: string;
  logos: Logo[];
}

interface Logo {
  href: string;
  width: number;
  height: number;
  alt: string;
  rel: string[];
  lastUpdated: string;
}

interface League {
  $ref: string;
  id: string;
  uid: string;
  name: string;
  abbreviation: string;
}

interface Ranking {
  $ref: string;
  id: string;
  name: string;
  shortName: string;
  type: string;
  occurrence: Occurrence;
  date: string;
  headline: string;
  shortHeadline: string;
  season: Season;
  ranks: Rank[];
}

interface Occurrence {
  number: number;
  type: string;
  last: boolean;
  value: string;
  displayValue: string;
}

interface Season {
  year: number;
  description?: string; // Optional based on example
  startDate: string;
  endDate: string;
  displayName?: string; // Optional based on example
  type: SeasonType;
}

interface SeasonType {
  type: number;
  name: string;
  abbreviation: string;
  id?: string; // Optional based on example
}

interface Rank {
  current: number;
  previous: number;
  points: number;
  firstPlaceVotes: number;
  trend: string;
  team: Team;
  date: string;
  lastUpdated: string;
  recordSummary: string;
}

interface Team {
  id: string;
  uid: string;
  location: string;
  name: string;
  nickname: string;
  abbreviation: string;
  color: string;
  logos: Logo[];
  logo: string;
}

interface DroppedOutTeam {
  current: number;
  previous: number;
  points: number;
  firstPlaceVotes: number;
  trend: string;
  team: Team;
  date: string;
  lastUpdated: string;
  recordSummary: string;
}

interface Week {
  number: number;
  type: string;
  last: boolean;
  value: string;
  displayValue: string;
}

interface WeekCount {
  type: string;
  weekCount: number;
}

interface WeekInfo {
  display: string;
  week: string;
  type: string;
}

interface RequestedSeason {
  year: number;
  displayName: string;
  type: SeasonType;
  week: Week;
}

interface AvailableRanking {
  id: string;
  name: string;
  shortName: string;
  week: string;
  seasonType: number;
}
