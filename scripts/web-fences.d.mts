interface RestrictedPattern {
  readonly group?: readonly string[];
  readonly regex?: string;
  readonly message: string;
}

export interface CoreImport {
  /** The core file that imports, relative to `apps/web/src`. */
  readonly from: string;
  /** The module file it imports, in the same form. */
  readonly to: string;
  readonly reason: string;
}

export interface WebFence {
  readonly files: readonly string[];
  readonly ignores?: readonly string[];
  readonly rules: {
    readonly 'no-restricted-imports': readonly [
      'error',
      { readonly patterns: readonly RestrictedPattern[] },
    ];
  };
}

export const CORE_IMPORTS_OF_MODULES: readonly CoreImport[];
export function webModuleIds(features: string): string[];
export function webFences(
  src: string,
  ids: readonly string[],
  webPatterns: readonly RestrictedPattern[],
  allowedImporters: readonly string[],
): WebFence[];
