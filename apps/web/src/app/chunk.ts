/**
 * The door to a module's chunk (D-250): one request shared by everybody who asks, so a chunk is fetched once however many
 * screens want it. Chat's screens and issues' use it, each with an `import()` of its own.
 */
/**
 * One request for a chunk, shared by everybody who asks and forgotten when it fails, so the next ask tries again.
 * `warm` asks without anybody waiting: a failure there is the doors' to meet when a screen is drawn.
 */
export const chunkOf = <T>(
  load: () => Promise<T>,
): { readonly get: () => Promise<T>; readonly warm: () => void } => {
  let loading: Promise<T> | null = null;
  const get = (): Promise<T> => {
    loading ??= load().catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };
  return {
    get,
    warm: (): void => {
      get().catch(() => undefined);
    },
  };
};
