import { ApiProperty } from '@nestjs/swagger';

export class CreateTeamDto {
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
  divisionName: string;

  @ApiProperty()
  league: string;

  @ApiProperty()
  abbrev: string;

  @ApiProperty()
  updateDate: string;
}
