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
  awayTeamLogoDark: string;

  @ApiProperty()
  homeTeamId: string;

  @ApiProperty()
  homeTeamShort: string;

  @ApiProperty()
  homeTeam: string;

  @ApiProperty()
  homeTeamLogo: string;

  @ApiProperty()
  homeTeamLogoDark: string;

  @ApiProperty({ required: false, nullable: true })
  homeTeamScore: number | null;

  @ApiProperty({ required: false, nullable: true })
  awayTeamScore: number | null;

  @ApiProperty()
  arenaName: string;

  @ApiProperty()
  gameDate: string;

  @ApiProperty()
  teamSelectedId: string;

  @ApiProperty()
  urlLive: string;

  @ApiProperty()
  selectedTeam: boolean;

  @ApiProperty()
  league: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  startTimeUTC: string;

  @ApiProperty()
  placeName: string;

  @ApiProperty({ default: new Date() })
  updateDate: string;

  @ApiProperty({ required: false })
  dataChangedAt?: string;

  @ApiProperty()
  gameStatus: string | null;
}
