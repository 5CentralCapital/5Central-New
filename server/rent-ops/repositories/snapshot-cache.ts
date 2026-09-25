/** One immutable decoded read shared by concurrent requests. Never used in a write transaction. */
export class SnapshotReadCache<T extends object> {
  private entry?: { key: string; version: number; expires: number; value?: T; pending?: Promise<T> };
  constructor(private readonly version: () => number | undefined, private readonly now = Date.now, private readonly ttlMs = 2000) {}

  async read(key: string, load: () => Promise<T>): Promise<T> {
    const version = this.version();
    if (version === undefined) { this.entry = undefined; return load(); }
    const previous = this.entry;
    if (previous?.key === key && previous.version === version) {
      if (previous.pending) return previous.pending;
      if (previous.value && previous.expires > this.now()) return previous.value;
    }
    const entry: NonNullable<SnapshotReadCache<T>['entry']> = { key, version, expires: 0 };
    this.entry = entry;
    entry.pending = load().then(value => {
      // A write committed while the read was in flight: return its coherent result
      // to its original caller but never let subsequent requests reuse it.
      if (this.entry === entry && this.version() === version) {
        entry.value = deepFreeze(value);
        entry.expires = this.now() + this.ttlMs;
      } else if (this.entry === entry) this.entry = undefined;
      return value;
    }).catch(error => { if (this.entry === entry) this.entry = undefined; throw error; })
      .finally(() => { entry.pending = undefined; });
    return entry.pending;
  }
}

function deepFreeze<T extends object>(value: T): T {
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return value;
}
