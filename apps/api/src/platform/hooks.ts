/**
 * A list of things to do inside the caller's transaction (`MODULES.md` §10, steps 6–8, D-250).
 *
 * The domain bus tells modules what happened after a commit and may lose it. Some things a module must do
 * cannot be lost or late: a workspace must never exist without its first channel. The core owns the moment
 * and runs the hooks inside its own transaction, in the order they were registered; a hook that throws fails the
 * caller, so its transaction rolls back whole. The module registers its hook where the application is put
 * together, so the core names no module.
 */
export interface Hooks<Args extends readonly unknown[]> {
  /** Runs each hook to the end, one after another; the first to throw stops the rest and is thrown. */
  run(...args: Args): Promise<void>;
}

export interface HookList<Args extends readonly unknown[]> extends Hooks<Args> {
  register(hook: (...args: Args) => Promise<void>): void;
}

export const hookList = <Args extends readonly unknown[]>(): HookList<Args> => {
  const hooks: ((...args: Args) => Promise<void>)[] = [];
  return {
    register: (hook): void => {
      hooks.push(hook);
    },
    run: async (...args): Promise<void> => {
      for (const hook of hooks) await hook(...args);
    },
  };
};
