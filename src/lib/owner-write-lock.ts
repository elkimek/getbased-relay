// Serializes relay writes and compaction for one Evolu owner. The upstream
// storage already serializes writes internally, but the self/admin compaction
// paths use a separate SQLite connection. Without this outer lock, a message
// can pass the replay guard immediately before compaction and then land after
// the compaction transaction has deleted the owner's history.

const ownerTails = new Map<string, Promise<void>>();

export async function withOwnerWriteLock<T>(
  ownerId: string,
  task: () => T | Promise<T>,
): Promise<T> {
  const previous = ownerTails.get(ownerId) ?? Promise.resolve();
  let release: () => void = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  ownerTails.set(ownerId, tail);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (ownerTails.get(ownerId) === tail) ownerTails.delete(ownerId);
  }
}
