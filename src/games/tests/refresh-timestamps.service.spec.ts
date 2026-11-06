import { Model } from 'mongoose';
import { RefreshTimestamp } from '../refresh-timestamp.schema';
import { RefreshTimestampService } from '../refresh-timestamps.service';

describe('RefreshTimestampService', () => {
  const query = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(),
  };
  const refreshTimestampModel = {
    find: jest.fn().mockReturnValue(query),
    deleteMany: jest.fn(),
  };
  let service: RefreshTimestampService;

  beforeEach(() => {
    jest.clearAllMocks();
    refreshTimestampModel.find.mockReturnValue(query);
    service = new RefreshTimestampService(
      refreshTimestampModel as unknown as Model<RefreshTimestamp>,
    );
  });

  it('deletes only records older than the 40 most recent timestamps', async () => {
    const oldestTimestamps = [{ _id: 'old-1' }, { _id: 'old-2' }];
    query.exec.mockResolvedValue(oldestTimestamps);
    refreshTimestampModel.deleteMany.mockResolvedValue({ deletedCount: 2 });

    await expect(service.pruneOldTimestamps()).resolves.toBe(2);

    expect(refreshTimestampModel.find).toHaveBeenCalledWith({}, { _id: 1 });
    expect(query.sort).toHaveBeenCalledWith({ timestamp: -1, _id: -1 });
    expect(query.skip).toHaveBeenCalledWith(40);
    expect(refreshTimestampModel.deleteMany).toHaveBeenCalledWith({
      _id: { $in: ['old-1', 'old-2'] },
    });
  });

  it('does not delete anything when there are at most 40 records', async () => {
    query.exec.mockResolvedValue([]);

    await expect(service.pruneOldTimestamps()).resolves.toBe(0);

    expect(refreshTimestampModel.deleteMany).not.toHaveBeenCalled();
  });
});
