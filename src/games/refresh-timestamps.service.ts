import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RefreshTimestamp, RefreshType } from './refresh-timestamp.schema';

@Injectable()
export class RefreshTimestampService {
  constructor(
    @InjectModel(RefreshTimestamp.name)
    private readonly refreshTimestampModel: Model<RefreshTimestamp>,
  ) {}

  async addTimestamp(
    league: string,
    type: RefreshType,
  ): Promise<RefreshTimestamp> {
    const newTimestamp = new this.refreshTimestampModel({ league, type });
    return newTimestamp.save();
  }

  async getTodayManualTimestamps(league: string): Promise<RefreshTimestamp[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return this.refreshTimestampModel
      .find({
        league,
        type: 'manual',
        timestamp: {
          $gte: today,
          $lt: tomorrow,
        },
      })
      .exec();
  }

  async getManualTimestampsSince(
    league: string,
    since: Date,
  ): Promise<RefreshTimestamp[]> {
    return this.refreshTimestampModel
      .find({
        league,
        type: 'manual',
        timestamp: {
          $gte: since,
        },
      })
      .exec();
  }

  async getLastRefresh(league: string): Promise<RefreshTimestamp | null> {
    return this.refreshTimestampModel
      .findOne({ league })
      .sort({ timestamp: -1 })
      .exec();
  }

  async pruneOldTimestamps(): Promise<number> {
    const oldestTimestamps = await this.refreshTimestampModel
      .find({}, { _id: 1 })
      .sort({ timestamp: -1, _id: -1 })
      .skip(40)
      .lean()
      .exec();

    if (oldestTimestamps.length === 0) return 0;

    const result = await this.refreshTimestampModel.deleteMany({
      _id: { $in: oldestTimestamps.map(({ _id }) => _id) },
    });
    return result.deletedCount ?? 0;
  }
}
