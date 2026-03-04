import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RefreshType = 'manual' | 'auto';

@Schema()
export class RefreshTimestamp extends Document {
  @Prop({ required: true, index: true })
  league: string;

  @Prop({ required: true, default: () => new Date() })
  timestamp: Date;

  @Prop({ required: true })
  type: RefreshType;
}

export const RefreshTimestampSchema =
  SchemaFactory.createForClass(RefreshTimestamp);
