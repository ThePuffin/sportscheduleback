import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type GameDocument = HydratedDocument<Game>;

@Schema()
export class Game {
  @Prop()
  uniqueId: string;

  @Prop()
  awayTeamId: string;

  @Prop()
  awayTeamShort: string;

  @Prop()
  awayTeam: string;

  @Prop()
  awayTeamLogo: string;

  @Prop()
  homeTeamId: string;

  @Prop()
  homeTeamShort: string;

  @Prop()
  homeTeam: string;

  @Prop()
  homeTeamLogo: string;

  @Prop()
  divisionName: string;

  @Prop()
  arenaName: string;

  @Prop()
  gameDate: string;

  @Prop()
  teamSelectedId: string;

  @Prop()
  show: string;

  @Prop()
  selectedTeam: string;

  @Prop()
  league: string;

  @Prop()
  venueTimezone: string;

  @Prop()
  isActive: boolean;

  @Prop()
  startTimeUTC: string;

  @Prop()
  placeName: string;

  @Prop()
  color: string;

  @Prop()
  backgroundColor: string;

  @Prop({ default: new Date() })
  updateDate: string;
}

export const GameSchema = SchemaFactory.createForClass(Game);
