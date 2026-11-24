const chains = new Map<string, Promise<void>>()

/** Runs `fn` after earlier work for the same key. Different keys run together. The map drops a key once it is idle. */
export function withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  chains.set(key, settled)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return run
}

export function activeLockCount(): number {
  return chains.size
}
