import { PAGE_LIMIT } from '@purlay/types';

/**
 * How many rows a page holds for a request's `limit`: the contract's default when it names none, and always
 * within the contract's bounds. The core's, not chat's — every list a module serves is paged the same way.
 */
export const limitOf = (query: { readonly limit?: number | undefined }): number =>
  Math.min(Math.max(query.limit ?? PAGE_LIMIT.default, 1), PAGE_LIMIT.max);
