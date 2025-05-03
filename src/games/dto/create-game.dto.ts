import { ApiProperty } from '@nestjs/swagger';

export class CreateGameDto {
  @ApiProperty()
  uniqueId: string;

  @ApiProperty()
  awayTeamId: string;

  @ApiProperty()
  awayTeamShort: string;

  @ApiProperty()
  awayTeamLogo: string;

  @ApiProperty()
  awayTeam: string;

  @ApiProperty()
  homeTeamId: string;

  @ApiProperty()
  homeTeamShort: string;

  @ApiProperty()
  homeTeam: string;

  @ApiProperty()
  homeTeamLogo: string;

  @ApiProperty()
  divisionName: string;

  @ApiProperty()
  arenaName: string;

  @ApiProperty()
  gameDate: string;

  @ApiProperty()
  teamSelectedId: string;

  @ApiProperty()
  show: string;

  @ApiProperty()
  selectedTeam: string;

  @ApiProperty()
  league: string;

  @ApiProperty()
  venueTimezone: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  startTimeUTC: string;

  @ApiProperty()
  placeName: string;

  @ApiProperty()
  color: string;

  @ApiProperty()
  backgroundColor: string;

  @ApiProperty({ default: new Date() })
  updateDate: string;
}
