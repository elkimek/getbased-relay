import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ok} from '@evolu/common';
import {InfiniteUpperBound, RangeType, testFingerprintTimestamps, timestampToTimestampBytes} from '@evolu/common/local-first';
import {createReplaySessionStorage} from '../dist/lib/replay-session-storage.js';
import {owner,memoryStorage} from './helpers/replay-memory-storage.mjs';
const encoded=t=>Buffer.from(t).toString('hex');
const message = n=>({timestamp:{millis:n*100,counter:0,nodeId:'0011223344556677'},change:Buffer.alloc(64,n)});
for (const liveNumbers of [[],[2,4,6,8],[1,3,5,7],[1,2,7,8]]) test('virtual acknowledgement index matches an independent timestamp-set oracle: '+liveNumbers,()=>{
 const base=memoryStorage(liveNumbers.map(message));const session=createReplaySessionStorage(base.storage);
 const ack=[1,2,3,4,5,6,7,8].filter(n=>!liveNumbers.includes(n)).map(n=>timestampToTimestampBytes(message(n).timestamp));
 session.acknowledge(owner,[...ack].reverse());session.acknowledge(owner,ack);
 const all=[1,2,3,4,5,6,7,8].map(n=>timestampToTimestampBytes(message(n).timestamp));const s=session.storage;
 assert.equal(s.getSize(owner),8);
 for(let b=0;b<=8;b++)for(let e=b;e<=8;e++){
  assert.deepEqual(s.fingerprint(owner,b,e),testFingerprintTimestamps(all.slice(b,e)));
  const got=[];s.iterate(owner,b,e,(t,i)=>{got.push([encoded(t),i]);return true;});
  assert.deepEqual(got,all.slice(b,e).map((t,i)=>[encoded(t),b+i]));
  let count=0;s.iterate(owner,b,e,()=>{count++;return false;});assert.equal(count,e>b?1:0);
 }
 for(let n=0;n<=10;n++)assert.equal(s.findLowerBound(owner,0,8,timestampToTimestampBytes(message(n).timestamp)),Math.max(0,Math.min(8,n-1)));
 assert.equal(s.findLowerBound(owner,0,8,InfiniteUpperBound),8);
 assert.deepEqual(s.fingerprintRanges(owner,[0,2,2,6,8]),[0,2,2,6,8].map((e,i,a)=>({type:RangeType.Fingerprint,upperBound:all[e]??InfiniteUpperBound,fingerprint:testFingerprintTimestamps(all.slice(a[i-1]??0,e))})));
 assert.equal(s.getSize(Buffer.alloc(16,2)),0);
 assert.equal(createReplaySessionStorage(base.storage).storage.getSize(owner),liveNumbers.length,'fresh peers must not inherit acknowledgements');
 assert.equal(base.values.size,liveNumbers.length,'no discarded payloads restored');
});
