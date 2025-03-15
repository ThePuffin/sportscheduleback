export interface NHLGameAPI {
  id: number;
  season: number;
  gameType: number;
  gameDate: string;
  venue: Venue;
  neutralSite: boolean;
  startTimeUTC: string;
  easternUTCOffset: string;
  venueUTCOffset: string;
  venueTimezone: string;
  gameState: string;
  gameScheduleState: string;
  tvBroadcasts: any[];
  awayTeam: AwayTeam;
  homeTeam: HomeTeam;
  periodDescriptor: PeriodDescriptor;
  gameOutcome: GameOutcome;
  winningGoalie: WinningGoalie;
  winningGoalScorer: WinningGoalScorer;
  gameCenterLink: string;
}

export interface Venue {
  default: string;
}

export interface AwayTeam {
  id: number;
  placeName: PlaceName;
  commonName: CommonName;
  abbrev: string;
  logo: string;
  darkLogo: string;
  awaySplitSquad: boolean;
  score: number;
}

export interface CommonName {
  default: string;
}
export interface PlaceName {
  default: string;
}

export interface HomeTeam {
  id: number;
  placeName: PlaceName;
  commonName: CommonName;
  abbrev: string;
  logo: string;
  darkLogo: string;
  homeSplitSquad: boolean;
  hotelLink: string;
  hotelDesc: string;
  score: number;
}

export interface PeriodDescriptor {
  periodType: string;
  maxRegulationPeriods: number;
}

export interface GameOutcome {
  lastPeriodType: string;
}

export interface WinningGoalie {
  playerId: number;
  firstInitial: FirstInitial;
  lastName: LastName;
}

export interface FirstInitial {
  default: string;
}

export interface LastName {
  default: string;
}

export interface WinningGoalScorer {
  playerId: number;
  firstInitial: FirstInitial2;
  lastName: LastName2;
}

export interface FirstInitial2 {
  default: string;
}

export interface LastName2 {
  default: string;
}
