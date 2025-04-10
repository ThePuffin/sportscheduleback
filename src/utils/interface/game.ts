export interface GameFormatted {
  uniqueId: string;
  awayTeamId: string;
  awayTeam: string;
  awayTeamShort: string;
  awayTeamLogo: string;
  homeTeamId: string;
  homeTeam: string;
  homeTeamShort: string;
  homeTeamLogo: string;
  arenaName: string;
  gameDate: string;
  teamSelectedId: string;
  show: boolean;
  selectedTeam: boolean;
  league: string;
  updateDate?: Date;
  venueTimezone?: string;
  timeStart?: string;
  color?: string;
  backgroundColor?: string;
}
