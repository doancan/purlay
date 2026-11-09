type Opened = readonly [path: string, names?: readonly string[]];

export const EXTRA: Readonly<Record<string, readonly Opened[]>>;
export const EXTRA_CAP: number;
export function reachPatterns(
  id: string,
  http: boolean,
): readonly {
  readonly group: readonly string[];
  readonly allowImportNames?: readonly string[];
  readonly message: string;
}[];
