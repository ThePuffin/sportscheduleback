import { ApiProperty } from '@nestjs/swagger';

export class UpdateTeamDto {
  @ApiProperty()
  uniqueId: string;

  @ApiProperty()
  value: string;

  @ApiProperty()
  id: string;

  @ApiProperty()
  label: string;

  @ApiProperty()
  teamLogo: string;

  @ApiProperty()
  teamCommonName: string;

  @ApiProperty()
  conferenceName: string;

  @ApiProperty()
  color: string;

  @ApiProperty()
  backgroundColor: string;

  @ApiProperty()
  divisionName: string;

  @ApiProperty()
  league: string;

  @ApiProperty()
  abbrev: string;

  @ApiProperty()
  updateDate: string;

  @ApiProperty({ required: false })
  wins?: number;

  @ApiProperty({ required: false })
  losses?: number;

  @ApiProperty({ required: false })
  ties?: number;

  @ApiProperty({ required: false })
  otLosses?: number;

  @ApiProperty({ required: false })
  teamLogoDark?: string;

  @ApiProperty({ required: false })
  record?: string;
}
