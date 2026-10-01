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
  // Use bytes as the lock identity even if a caller supplied a base64url alias.
  ownerId = Buffer.from(ownerId, "base64url").toString("hex");
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
