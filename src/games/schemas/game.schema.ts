import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type GameDocument = HydratedDocument<Game>;

@Schema({ _id: false })
class GameDetails {
  @Prop({ required: false })
  period?: number;

  @Prop({ required: false })
  clock?: string;

  @Prop({ required: false })
  situation?: string;
}

export enum GameState {
  SCHEDULED = 'SCHEDULED',
  IN_PROGRESS = 'IN_PROGRESS',
  FINAL = 'FINAL',
  POSTPONED = 'POSTPONED',
  CANCELLED = 'CANCELLED',
  TBD = 'TBD',
}

@Schema({ timestamps: { createdAt: 'createdAt', updatedAt: 'updateDate' } })
export class Game {
  @Prop({ unique: true, index: true })
  uniqueId: string;

  @Prop({ index: true })
  awayTeamId: string;

  @Prop()
  awayTeamShort: string;

  @Prop()
  awayTeam: string;

  @Prop()
  awayTeamLogo: string;

  @Prop()
  awayTeamLogoDark: string;

  @Prop({ index: true })
  homeTeamId: string;

  @Prop()
  homeTeamShort: string;

  @Prop()
  homeTeam: string;

  @Prop()
  homeTeamLogo: string;

  @Prop()
  homeTeamLogoDark: string;

  @Prop({ required: false, default: null })
  homeTeamScore: number | null;

  @Prop({ required: false, default: null })
  awayTeamScore: number | null;

  @Prop()
  divisionName: string;

  @Prop()
  arenaName: string;

  @Prop({ index: true })
  gameDate: string;

  @Prop({ index: true })
  teamSelectedId: string;

  @Prop()
  urlLive: string;

  @Prop()
  show: boolean;

  @Prop()
  selectedTeam: boolean;

  @Prop({ index: true })
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

  @Prop()
  awayTeamColor: string;

  @Prop()
  homeTeamRecord?: string;

  @Prop()
  awayTeamBackgroundColor: string;

  @Prop()
  homeTeamColor: string;

  @Prop()
  homeTeamBackgroundColor: string;

  @Prop()
  awayTeamRecord?: string;

  @Prop({
    type: String,
    enum: GameState,
    default: GameState.SCHEDULED,
    index: true,
  })
  status: GameState;

  @Prop({ type: [String], default: [] })
  broadcasts: string[];

  @Prop({ type: GameDetails, required: false })
  gameDetails?: GameDetails;

  // These are handled by the timestamps option in @Schema
  createdAt?: Date;
  updateDate: string;
}

export const GameSchema = SchemaFactory.createForClass(Game);
