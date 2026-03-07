import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class Game extends Document {
  @Prop({ required: true, unique: true, index: true })
  uniqueId: string;

  @Prop({ index: true })
  league: string;

  @Prop({ index: true })
  gameDate: string;

  @Prop({ index: true })
  startTimeUTC: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop()
  homeTeamId: string;

  @Prop()
  awayTeamId: string;

  @Prop({ index: true })
  teamSelectedId: string;

  @Prop()
  homeTeamScore: number;

  @Prop()
  awayTeamScore: number;

  @Prop()
  homeTeam: string;

  @Prop()
  homeTeamShort: string;

  @Prop()
  homeTeamLogo: string;

  @Prop()
  homeTeamLogoDark: string;

  @Prop()
  homeTeamRecord: string;

  @Prop()
  awayTeam: string;

  @Prop()
  awayTeamShort: string;

  @Prop()
  awayTeamLogo: string;

  @Prop()
  awayTeamLogoDark: string;

  @Prop()
  awayTeamRecord: string;

  @Prop()
  arenaName: string;

  @Prop()
  placeName: string;

  @Prop()
  venueTimezone: string;

  @Prop()
  updateDate: string;

  @Prop()
  divisionName: string;

  @Prop()
  urlLive: string;

  @Prop()
  show: boolean;

  @Prop()
  selectedTeam: boolean;

  @Prop()
  color: string;

  @Prop()
  backgroundColor: string;

  // ... vous pouvez ajouter d'autres propriétés de vos DTOs ici
}

export const GameSchema = SchemaFactory.createForClass(Game);

// Index composite pour optimiser les requêtes dans `findByDateHour` et autres fonctions de filtrage.
// Cet index aide MongoDB à filtrer efficacement par `isActive`, `gameDate`, et `league`,
// puis à utiliser le même index pour trier par `startTimeUTC`, évitant des tris en mémoire très lents.
GameSchema.index({
  isActive: 1,
  gameDate: 1,
  league: 1,
  startTimeUTC: 1,
});
