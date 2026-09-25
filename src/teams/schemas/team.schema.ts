import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TeamDocument = HydratedDocument<Team>;

@Schema()
export class Team {
  @Prop()
  uniqueId: string;

  @Prop()
  value: string;

  @Prop()
  id: string;

  @Prop()
  label: string;

  @Prop()
  teamLogo: string;

  @Prop()
  teamLogoDark: string;

  @Prop()
  teamCommonName: string;

  @Prop()
  conferenceName: string;

  @Prop()
  color: string;

  @Prop()
  backgroundColor: string;

  @Prop()
  divisionName: string;

  @Prop()
  league: string;

  @Prop()
  abbrev: string;

  // true (default) for an active team. Historical teams/teams imported by
  // the Core API sync or defined in HistoricalTeams are marked `false`
  // and must never appear in the frontend constants.
  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: new Date() })
  updateDate: string;

  @Prop()
  wins: number;

  @Prop()
  losses: number;

  @Prop()
  ties: number;

  @Prop()
  otLosses: number;
}

export const TeamSchema = SchemaFactory.createForClass(Team);
