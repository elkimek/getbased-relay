import assert from 'node:assert/strict';
import {ok} from '@evolu/common';
import {InfiniteUpperBound,RangeType,testFingerprintTimestamps,timestampToTimestampBytes} from '@evolu/common/local-first';
export const owner = Buffer.alloc(16, 1);
const encoded = t => Buffer.from(t).toString('hex');
export function memoryStorage(messages = []) {
 const values = new Map(messages.map(m => [encoded(timestampToTimestampBytes(m.timestamp)), m]));
 const times = o => Buffer.compare(o,owner) === 0 ? [...values.keys()].sort().map(h=>Uint8Array.from(Buffer.from(h,'hex'))) : [];
 const base = {
  getSize: o=>times(o).length,
  fingerprint: (o,b,e)=>testFingerprintTimestamps(times(o).slice(b,e)),
  fingerprintRanges: (o,buckets,upper=InfiniteUpperBound)=>{let b=0;return buckets.map((e,i)=>{const out={type:RangeType.Fingerprint,upperBound:i===buckets.length-1?upper:times(o)[e]??upper,fingerprint:base.fingerprint(o,b,e)};b=e;return out;});},
  findLowerBound: (o,b,e,t)=>t===InfiniteUpperBound?e:Math.min(e,Math.max(b,times(o).findIndex(x=>Buffer.compare(x,t)>=0)===-1?times(o).length:times(o).findIndex(x=>Buffer.compare(x,t)>=0))),
  iterate:(o,b,e,cb)=>{const ts=times(o);for(let i=b;i<e;i++)if(!cb(ts[i],i))break;},
  validateWriteKey:()=>true,
  writeMessages:(_o,ms)=>async()=>{for(const m of ms)values.set(encoded(timestampToTimestampBytes(m.timestamp)),m);return ok();},
  readDbChange:(_o,t)=>{const m=values.get(encoded(t));assert(m,'No compacted payload may be read');return m.change;},
  deleteOwner:()=>values.clear(),
 };
 return {storage:base,values};
}
