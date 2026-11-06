/**
 * What a module's frame handler is given and what it answers (`MODULES.md` §2, D-276).
 *
 * A module owns the client operations its manifest lists under `frames`, and serves each with a handler of its slot in
 * `bundledModules` (`frameHandlers`). The router (`realtime/router.ts`) does what is the same for every operation before
 * it asks one: it counts the frame against the connection's budget, parses it against the contract, answers one that
 * belongs to a module this process does not run as an operation nobody has, holds it to its module's deadline and share of
 * the pool, and writes the answer to a failure. What is left to a handler is the operation itself.
 *
 * Types only, as `module-kit` is, so a module can import them. A handler declares the parts of the context it uses in an
 * interface of its own that extends `FrameContext`; the router passes it the whole.
 */
import type { Executor } from '@purlay/db';
import type { ClientFrame, ClientOp, ServerFrame } from '@purlay/types';
import type { Clock } from './clock';
import type { EventBus } from './events';
import type { Logger } from './logging';
import type { Atomically } from './transactions';

/** A server frame without the fields every one carries: which kind it is, and its data. */
export type FrameBody = ServerFrame extends infer Member
  ? Member extends ServerFrame
    ? Omit<Member, 'ts' | 'refId'>
    : never
  : never;

/** Who is speaking: the connection, the person, and the session the connection was opened with. */
export interface FrameIdentity {
  readonly socketId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

/**
 * What a handler is given of the connection it is answering. `database` is the application's one handle, whose every
 * connection a handler takes is the module's share of the pool (D-266), and the frame has been admitted by the
 * connection's own budget already.
 */
export interface FrameContext {
  readonly identity: FrameIdentity;
  readonly database: Executor;
  /** The write path's transaction boundary (D-35). */
  readonly atomically: Atomically;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  /** A frame of the contract as the router stamps it: the server clock, and the id it answers. */
  readonly reply: (body: FrameBody, refId?: string) => ServerFrame;
  /** The `ERROR` frame for a failure, as the router answers one: an `AppError` as it is, anything else by its kind. */
  readonly fail: (error: unknown, refId?: string) => ServerFrame;
}

/** The frame of one operation, as the contract validated it. */
type FrameOf<Op extends ClientOp> = Extract<ClientFrame, { readonly op: Op }>;

/**
 * Serves one operation and returns what to send back on this connection, `[]` for an operation with nothing to answer.
 * A failure is thrown, and the router answers it with the frame's `refId`.
 */
export type FrameHandler<Op extends ClientOp, Context extends FrameContext = FrameContext> = (
  context: Context,
  frame: FrameOf<Op>,
) => Promise<readonly ServerFrame[]>;

/** The handlers of one module, by the operation each serves. */
export type FrameHandlers<Context extends FrameContext = FrameContext> = {
  readonly [Op in ClientOp]?: FrameHandler<Op, Context>;
};

/** The handler of an operation, if there is one: typed for the frame of the operation asked for. */
export const handlerOf = <Op extends ClientOp, Context extends FrameContext>(
  handlers: FrameHandlers<Context>,
  op: Op,
): FrameHandler<Op, Context> | undefined => handlers[op];
