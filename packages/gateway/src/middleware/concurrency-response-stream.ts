export const concurrencyAbortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('Client disconnected while waiting for a concurrency slot.', 'AbortError');

export const holdConcurrencyResponseStream = (
  response: Response,
  release: () => void,
  signal?: AbortSignal,
): Response => {
  const body = response.body;
  if (body === null || response.status === 101) {
    release();
    return response;
  }

  const reader = body.getReader();
  let settled = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    release();
  };
  const onAbort = (): void => {
    if (!signal) return;
    void reader.cancel(concurrencyAbortReason(signal)).catch(error => {
      try {
        controllerRef?.error(error);
      } catch {
        // A disconnected client may already have cancelled the wrapped stream.
      }
    }).finally(finish);
  };

  const wrapped = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        try {
          controller.error(error);
        } finally {
          finish();
        }
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });

  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }
  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
};
