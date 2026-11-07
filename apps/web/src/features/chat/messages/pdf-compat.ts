/**
 * The pinned legacy renderer still calls this API in both realms. Supply the standard constructor
 * operation where the product's older browsers lack it; the measured reason is in the PDF spike.
 */
export const installPdfCompatibility = (): void => {
  const current: unknown = Reflect.get(Promise, 'withResolvers');
  if (typeof current === 'function') return;
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function <T>(this: PromiseConstructor): {
      readonly promise: Promise<T>;
      readonly resolve: (value: T | PromiseLike<T>) => void;
      readonly reject: (reason: unknown) => void;
    } {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason: unknown) => void;
      const promise = new this<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      return { promise, resolve, reject };
    },
  });
};

// Import this before the SDK: installing it later cannot repair a library that already threw.
installPdfCompatibility();
