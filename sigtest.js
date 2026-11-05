const mongoose = require('mongoose');
(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27017/sigtest', { serverSelectionTimeoutMS: 3000 });
  const S = mongoose.model('T', new mongoose.Schema({ n: Number }));
  await S.deleteMany({});
  await S.insertMany([{ n: 1 }, { n: 2 }]);

  // 1) aborted signal -> find should reject
  const ac = new AbortController();
  ac.abort(new Error('cancelled-by-test'));
  try {
    await S.find({}).setOptions({ signal: ac.signal }).lean().exec();
    console.log('FIND aborted: NO ERROR (signal ignored?)');
  } catch (e) {
    console.log('FIND aborted ->', e.name, '|', e.message);
  }

  // 2) findOne with signal
  const ac2 = new AbortController();
  ac2.abort(new Error('cancelled-one'));
  try {
    await S.findOne({}).setOptions({ signal: ac2.signal }).exec();
    console.log('FINDONE aborted: NO ERROR');
  } catch (e) {
    console.log('FINDONE aborted ->', e.name, '|', e.message);
  }

  // 3) non-aborted signal -> should work
  const ac3 = new AbortController();
  const docs = await S.find({}).setOptions({ signal: ac3.signal }).lean().exec();
  console.log('FIND ok ->', docs.length, 'docs');

  // 4) aggregate with signal
  const ac4 = new AbortController();
  ac4.abort(new Error('cancelled-agg'));
  try {
    await S.aggregate([{ $match: {} }]).option({ signal: ac4.signal });
    console.log('AGG aborted: NO ERROR');
  } catch (e) {
    console.log('AGG aborted ->', e.name, '|', e.message);
  }
  await mongoose.disconnect();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
