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

  @Prop({ default: new Date() })
  updateDate: string;
}

export const TeamSchema = SchemaFactory.createForClass(Team);
