import {
  type DurableHttpSession,
  type DurableHttpSessionAcquireOptions,
  type DurableHttpSessionHandle,
  type DurableHttpSessionInit,
} from '@floway-dev/platform';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface Entry {
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Buffered chunks not yet consumed by the current handle. */
  buffer: Uint8Array[];
  /** Resolves the next dequeue when a chunk arrives or the stream ends. */
  waiter: { resolve: (v: { done: boolean; value?: Uint8Array }) => void } | null;
  done: boolean;
  error: unknown;
  inFlight: Promise<unknown> | null;
  idleTimer: NodeJS.Timeout | null;
  lastActivityAt: number;
}

export class InProcessDurableHttpSession implements DurableHttpSession {
  private readonly entries = new Map<string, Entry>();

  async acquire(
    sessionKey: string,
    init: DurableHttpSessionInit | null,
    opts?: DurableHttpSessionAcquireOptions,
  ): Promise<DurableHttpSessionHandle | null> {
    const idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    const existingInFlight = this.entries.get(sessionKey)?.inFlight;
    if (existingInFlight) await existingInFlight.catch(() => {});

    let entry = this.entries.get(sessionKey);

    if (!entry) {
      if (init === null) return null;
      const lock = (async (): Promise<Entry> => {
        const response = await globalThis.fetch(init.url, {
          method: init.method,
          headers: init.headers,
          body: init.body ? (init.body as BodyInit) : null,
        });
        if (!response.body) {
          throw new Error(`InProcessDurableHttpSession: ${init.method} ${init.url} returned no body`);
        }
        const reader = response.body.getReader();
        const e: Entry = {
          response,
          reader,
          buffer: [],
          waiter: null,
          done: false,
          error: null,
          inFlight: null,
          idleTimer: null,
          lastActivityAt: Date.now(),
        };
        this.startPump(e);
        return e;
      })();
      const placeholder: Entry = {
        response: undefined as unknown as Response,
        reader: undefined as unknown as ReadableStreamDefaultReader<Uint8Array>,
        buffer: [],
        waiter: null,
        done: false,
        error: null,
        inFlight: lock,
        idleTimer: null,
        lastActivityAt: Date.now(),
      };
      this.entries.set(sessionKey, placeholder);
      try {
        entry = await lock;
        this.entries.set(sessionKey, entry);
      } catch (err) {
        this.entries.delete(sessionKey);
        throw err;
      }
    }

    entry.lastActivityAt = Date.now();
    this.armIdleTimer(sessionKey, entry, idleTimeoutMs);
    return this.makeHandle(sessionKey, entry, opts?.signal);
  }

  private startPump(entry: Entry): void {
    const pump = async (): Promise<void> => {
      try {
        while (true) {
          const { done, value } = await entry.reader.read();
          if (done) {
            entry.done = true;
            if (entry.waiter) {
              entry.waiter.resolve({ done: true });
              entry.waiter = null;
            }
            return;
          }
          if (value) {
            if (entry.waiter) {
              entry.waiter.resolve({ done: false, value });
              entry.waiter = null;
            } else {
              entry.buffer.push(value);
            }
          }
        }
      } catch (err) {
        entry.error = err;
        entry.done = true;
        if (entry.waiter) {
          entry.waiter.resolve({ done: true });
          entry.waiter = null;
        }
      }
    };
    void pump();
  }

  private dequeue(entry: Entry): Promise<{ done: boolean; value?: Uint8Array }> {
    if (entry.buffer.length > 0) {
      return Promise.resolve({ done: false, value: entry.buffer.shift()! });
    }
    if (entry.done) {
      return Promise.resolve({ done: true });
    }
    return new Promise(resolve => { entry.waiter = { resolve }; });
  }

  private armIdleTimer(sessionKey: string, entry: Entry, idleTimeoutMs: number): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this.evict(sessionKey, 'idle timeout'), idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private evict(sessionKey: string, _reason: string): void {
    const entry = this.entries.get(sessionKey);
    if (!entry) return;
    this.entries.delete(sessionKey);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { entry.reader.releaseLock(); } catch { /* already released */ }
    void entry.response.body?.cancel(_reason).catch(() => {});
  }

  private makeHandle(
    sessionKey: string,
    entry: Entry,
    signal: AbortSignal | undefined,
  ): DurableHttpSessionHandle {
    const self = this;
    let released = false;
    const onAbort = (): void => { released = true; };
    if (signal) {
      if (signal.aborted) released = true;
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const body = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        if (released) { controller.close(); return; }
        const result = await self.dequeue(entry);
        if (released || result.done) { controller.close(); return; }
        if (result.value) controller.enqueue(result.value);
      },
      cancel(): void {
        released = true;
        if (signal) signal.removeEventListener('abort', onAbort);
      },
    });

    return {
      status: entry.response.status,
      headers: entry.response.headers,
      body,
      async release(): Promise<void> {
        released = true;
        if (signal) signal.removeEventListener('abort', onAbort);
      },
      async discard(reason: string): Promise<void> {
        released = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        self.evict(sessionKey, reason);
      },
    };
  }

  evictAllForTesting(): void {
    for (const key of [...this.entries.keys()]) this.evict(key, 'test reset');
  }

  sizeForTesting(): number {
    return this.entries.size;
  }
}
