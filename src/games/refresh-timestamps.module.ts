import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  RefreshTimestamp,
  RefreshTimestampSchema,
} from './refresh-timestamp.schema';
import { RefreshTimestampService } from './refresh-timestamps.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RefreshTimestamp.name, schema: RefreshTimestampSchema },
    ]),
  ],
  providers: [RefreshTimestampService],
  exports: [RefreshTimestampService],
})
export class RefreshTimestampModule {}
