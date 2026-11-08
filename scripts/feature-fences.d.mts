interface RestrictedPattern {
  readonly group?: readonly string[];
  readonly regex?: string;
  readonly message: string;
}

interface RestrictedPath {
  readonly name: string;
  readonly importNames?: readonly string[];
  readonly message: string;
}

export interface FeatureFence {
  readonly files: readonly string[];
  readonly rules: {
    readonly 'no-restricted-imports': readonly [
      'error',
      {
        readonly patterns: readonly RestrictedPattern[];
        readonly paths: readonly RestrictedPath[];
      },
    ];
  };
}

export function featureIds(dir: string): string[];
export function featureFences(
  dir: string,
  ids: readonly string[],
  noTransportTypes: RestrictedPattern,
  pathsFor: (id: string) => readonly RestrictedPath[],
  testPathsFor?: (id: string) => readonly RestrictedPath[],
  httpTransportTypes?: RestrictedPattern,
  noComposition?: RestrictedPattern,
  everywhere?: readonly RestrictedPattern[],
): FeatureFence[];
