// A part of the cross-tenant suite; which cases it runs, and why it is split: `testing/cross-tenant-suite.ts`.
import { describe } from 'bun:test';
import { crossTenantPart } from '../../testing/cross-tenant-suite';

const part = crossTenantPart(import.meta.path);

describe('integration: cross-tenant isolation', part.crossings);

describe('integration: one member, two workspaces', part.lists);
