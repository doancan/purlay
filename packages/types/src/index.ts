/**
 * `@purlay/types` — the contract.
 *
 * Models, WebSocket frames and HTTP shapes are defined here and nowhere else. A
 * shape defined in two places will diverge, so an app never declares its own
 * (`ARCHITECTURE.md` §1, `CONTRIBUTING.md` §1.4).
 *
 * Everything is authored once as a TypeBox schema and the TypeScript type is
 * derived from it, so one definition both validates at runtime and types at
 * compile time (`ARCHITECTURE.md` §2).
 */
export * from './formats';
export * from './contract-version';
export * from './errors';
export * from './models';
export * from './events';
export * from './realtime';
export * from './api';
export * from './endpoints';
export * from './message-id';
export * from './sign-in';
export * from './export';
export * from './mailbox';
export * from './setup';
export * from './password';
export * from './quiet-hours';
export * from './two-factor';
export * from './missed-mail';
