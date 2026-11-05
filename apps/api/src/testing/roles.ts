import type { UserRole } from '@purlay/types';

/** Every role, lowest first: what a test of who may do what walks. */
export const USER_ROLES = ['member', 'admin', 'owner'] as const satisfies readonly UserRole[];
