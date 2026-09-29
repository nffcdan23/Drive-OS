/**
 * Wraps an async request so that callers arriving while it is in flight share
 * the same promise instead of starting a second request. Once it settles
 * (either way), the next call starts a fresh request.
 */
export function shareInFlight<T>(request: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = request().finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
