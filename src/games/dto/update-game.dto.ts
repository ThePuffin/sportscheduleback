import { ApiProperty } from '@nestjs/swagger';

export class UpdateGameDto {
  @ApiProperty()
  uniqueId: string;

  @ApiProperty()
  awayTeamId: string;

  @ApiProperty()
  awayTeamShort: string;

  @ApiProperty()
  awayTeam: string;

  @ApiProperty()
  awayTeamLogo: string;

  @ApiProperty()
  homeTeamId: string;

  @ApiProperty()
  homeTeamShort: string;

  @ApiProperty()
  homeTeam: string;

  @ApiProperty()
  homeTeamLogo: string;

  @ApiProperty({ required: false, nullable: true })
  homeTeamScore: number | null;

  @ApiProperty({ required: false, nullable: true })
  awayTeamScore: number | null;

  @ApiProperty()
  divisionName: string;

  @ApiProperty()
  arenaName: string;

  @ApiProperty()
  gameDate: string;

  @ApiProperty()
  teamSelectedId: string;

  @ApiProperty()
  show: boolean;

  @ApiProperty()
  selectedTeam: boolean;

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
