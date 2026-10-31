// Reconciliation acknowledgements belong to the peer that supplied the replay.
// Fresh peers must never be offered a compacted timestamp without its payload.
import {assert, NonNegativeInt} from '@evolu/common';
import {
  InfiniteUpperBound, RangeType, timestampBytesToFingerprint,
  type Fingerprint, type OwnerIdBytes, type Storage, type TimestampBytes,
} from '@evolu/common/local-first';

const index = (n: number) => NonNegativeInt.orThrow(n);
interface Acknowledged {
  timestamps: TimestampBytes[];
  prefix: Uint8Array;
  hashes: Fingerprint[];
  seen: Set<string>;
}
export function createReplaySessionStorage(base: Storage) {
  const owners = new Map<string, Acknowledged>();
  let disposed = false;
  const key = (owner: OwnerIdBytes) => Buffer.from(owner).toString('hex');
  const acknowledge = (owner: OwnerIdBytes, timestamps: readonly TimestampBytes[]) => {
    if (disposed || !timestamps.length) return;
    const ownerKey = key(owner);
    let ack = owners.get(ownerKey);
    if (!ack) {ack = {timestamps: [], hashes: [], seen: new Set(), prefix: new Uint8Array(12)}; owners.set(ownerKey, ack);}
    const fresh: {timestamp: TimestampBytes; hash: Fingerprint}[] = [];
    for (const timestamp of timestamps) {
      const hex = Buffer.from(timestamp).toString('hex');
      if (ack.seen.has(hex)) continue;
      const copy = Uint8Array.from(timestamp) as TimestampBytes;
      fresh.push({timestamp: copy, hash: timestampBytesToFingerprint(copy)}); ack.seen.add(hex);
    }
    if (!fresh.length) return;
    fresh.sort((a, b) => Buffer.compare(a.timestamp, b.timestamp));
    let first = 0, high = ack.timestamps.length;
    while (first < high) {const middle = Math.floor((first + high) / 2); if (Buffer.compare(ack.timestamps[middle]!, fresh[0]!.timestamp) < 0) first = middle + 1; else high = middle;}
    if (first === ack.timestamps.length) {
      for (const entry of fresh) {ack.timestamps.push(entry.timestamp); ack.hashes.push(entry.hash);}
    } else {
      const merged = ack.timestamps.slice(0, first), hashes = ack.hashes.slice(0, first);
      let oldIndex = first, newIndex = 0;
      while (oldIndex < ack.timestamps.length || newIndex < fresh.length) {
        if (newIndex < fresh.length && (oldIndex === ack.timestamps.length || Buffer.compare(fresh[newIndex]!.timestamp, ack.timestamps[oldIndex]!) < 0)) {
          merged.push(fresh[newIndex]!.timestamp); hashes.push(fresh[newIndex++]!.hash);
        } else {merged.push(ack.timestamps[oldIndex]!); hashes.push(ack.hashes[oldIndex++]!);}
      }
      ack.timestamps = merged; ack.hashes = hashes;
    }
    const needed = (ack.timestamps.length + 1) * 12;
    if (ack.prefix.length < needed) {
      let capacity = ack.prefix.length; while (capacity < needed) capacity *= 2;
      const prefix = new Uint8Array(capacity); prefix.set(ack.prefix); ack.prefix = prefix;
    }
    // Append-only batches touch only their new suffix. Out-of-order arrivals
    // merge sorted new timestamps and reuse every already-computed hash.
    for (let n = first; n < ack.timestamps.length; n++) {
      for (let b = 0; b < 12; b++) ack.prefix[(n + 1) * 12 + b] = ack.prefix[n * 12 + b]! ^ ack.hashes[n]![b]!;
    }
  };
  // Ack timestamps and live timestamps are disjoint: the guard only adds
  // timestamps proven compacted, which it never stores as live messages.
  const view = (owner: OwnerIdBytes) => {
    const ack = owners.get(key(owner));
    if (!ack?.timestamps.length) return null;
    const liveSize = base.getSize(owner);
    const size = liveSize + ack.timestamps.length;
    const ackBeforeIndex = (position: number) => {
      let low = 0, high = ack.timestamps.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const liveBefore = base.findLowerBound(owner, index(0), liveSize, ack.timestamps[middle]!);
        if (middle + liveBefore < position) low = middle + 1; else high = middle;
      }
      return low;
    };
    return {ack, liveSize, size, ackBeforeIndex};
  };
  const storage: Storage = {
    ...base,
    getSize(owner) {return index(base.getSize(owner) + (owners.get(key(owner))?.timestamps.length || 0));},
    fingerprint(owner, begin, end) {
      const v = view(owner); if (!v) return base.fingerprint(owner, begin, end);
      assert(begin <= end && end <= v.size, 'invalid replay-view range');
      const first = v.ackBeforeIndex(begin), last = v.ackBeforeIndex(end);
      const live = base.fingerprint(owner, index(begin - first), index(end - last));
      return Uint8Array.from(live, (byte, b) => byte ^ v.ack.prefix[first * 12 + b]! ^ v.ack.prefix[last * 12 + b]!) as Fingerprint;
    },
    findLowerBound(owner, begin, end, bound) {
      const v = view(owner); if (!v) return base.findLowerBound(owner, begin, end, bound);
      if (begin === end || bound === InfiniteUpperBound) return end;
      let low = 0, high = v.ack.timestamps.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Buffer.compare(v.ack.timestamps[middle]!, bound) < 0) low = middle + 1; else high = middle;
      }
      return index(Math.min(end, Math.max(begin, base.findLowerBound(owner, index(0), v.liveSize, bound) + low)));
    },
    iterate(owner, begin, end, callback) {
      const v = view(owner); if (!v) return base.iterate(owner, begin, end, callback);
      assert(begin <= end && end <= v.size, 'invalid replay-view iteration');
      let ackIndex = v.ackBeforeIndex(begin), globalIndex = begin, stopped = false;
      const ackEnd = v.ackBeforeIndex(end);
      base.iterate(owner, index(begin - ackIndex), index(end - ackEnd), (timestamp) => {
        while (ackIndex < ackEnd && Buffer.compare(v.ack.timestamps[ackIndex]!, timestamp) < 0) {
          if (!callback(v.ack.timestamps[ackIndex++]!, index(globalIndex++))) {stopped = true; return false;}
        }
        if (!callback(timestamp, index(globalIndex++))) {stopped = true; return false;}
        return true;
      });
      while (!stopped && ackIndex < ackEnd) {
        if (!callback(v.ack.timestamps[ackIndex++]!, index(globalIndex++))) break;
      }
    },
    fingerprintRanges(owner, buckets, upperBound = InfiniteUpperBound) {
      if (!view(owner)) return base.fingerprintRanges(owner, buckets, upperBound);
      const size = storage.getSize(owner); let begin = index(0);
      return buckets.map((end, bucketIndex) => {
        let bound = upperBound;
        if (bucketIndex < buckets.length - 1 && end < size) storage.iterate(owner, end, index(end + 1), timestamp => {bound = timestamp; return false;});
        const fingerprint = storage.fingerprint(owner, begin, end); begin = end;
        return {type: RangeType.Fingerprint, upperBound: bound, fingerprint};
      });
    },
    deleteOwner(owner) {owners.delete(key(owner)); base.deleteOwner(owner);},
  };
  return {storage, acknowledge, forgetOwner: (owner: OwnerIdBytes) => owners.delete(key(owner)),
    dispose() {disposed = true; owners.clear();}};
}
