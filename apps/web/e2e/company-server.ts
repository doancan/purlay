/** A company journey's own API process and successful-allocation-only database cleanup. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CompanyServer {
  readonly manifest: {
    readonly origin: string;
    readonly external: string;
    readonly capability: string;
    readonly workspaceId: string;
    readonly slug: string;
    readonly elsewhereId: string;
    readonly userId: string;
    readonly cookie: { readonly name: string; readonly value: string };
    readonly oidc: {
      readonly issuer: string;
      readonly clientId: string;
      readonly clientSecret: string;
    };
  };
  readonly stop: () => Promise<void>;
}

export const startCompanyServer = async (port: number): Promise<CompanyServer> => {
  const directory = mkdtempSync(join(tmpdir(), 'purlay-company-browser-'));
  const file = join(directory, 'company.json');
  const child = spawn(
    'bun',
    [
      '--no-env-file',
      '--env-file=.env.test',
      'run',
      'apps/api/src/testing/company-browser-server.ts',
      '--port',
      String(port),
      '--manifest',
      file,
    ],
    { cwd: '../..', stdio: 'ignore' },
  );
  const state: { exited: boolean; failed: boolean } = { exited: false, failed: false };
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      state.exited = true;
      resolve();
    });
    child.once('error', () => {
      state.exited = true;
      state.failed = true;
      resolve();
    });
  });
  let stopped: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    stopped ??= (async (): Promise<void> => {
      const shutdown = { forced: false };
      const timer = setTimeout(() => {
        shutdown.forced = true;
        child.kill('SIGKILL');
      }, 60_000);
      try {
        if (!state.exited) child.kill('SIGTERM');
        await exited;
      } finally {
        clearTimeout(timer);
      }
      // Keep private allocation evidence when graceful cleanup failed, instead of claiming the database was dropped.
      if (shutdown.forced)
        throw new Error(`Company server cleanup timed out; inspect ${directory}`);
      rmSync(directory, { recursive: true, force: true });
    })();
    await stopped;
  };
  // Leave one minute of the startup hook for the child's owned-database cleanup.
  for (let attempt = 0; attempt < 850 && !state.exited && !existsSync(file); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 200));
  if (!existsSync(file)) {
    await stop();
    throw new Error(
      state.failed
        ? 'Company browser server could not be spawned'
        : 'Company browser server did not become ready; run its fixture to inspect startup',
    );
  }
  return { manifest: JSON.parse(readFileSync(file, 'utf8')) as CompanyServer['manifest'], stop };
};
