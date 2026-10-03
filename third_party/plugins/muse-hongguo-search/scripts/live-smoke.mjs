import assert from 'node:assert/strict';
import { HongguoClient } from '../src/client.js';
const c = new HongguoClient();
try {
  const s = await c.search({query:'二嫁'}); assert.ok(s.items.length); assert.equal(s.complete,false);
  const d = await c.detail({seriesId:s.items[0].seriesId}); assert.equal(d.seriesId,s.items[0].seriesId);
  const r = await c.collections({limit:400}); assert.equal(r.coverage.complete,true);
  console.log(JSON.stringify({at:r.fetchedAt,search:s.items.length,pages:r.coverage.pagesFetched,unique:r.coverage.uniqueSeries,matched:r.totalMatched,uncertain:r.totalUncertain}));
} finally { c.dispose(); }
