/**
 * A server nobody has set up, for the specs that walk the wizard (`setup*.e2e.ts`): its own process,
 * scratch database, GitHub stand-in and mail relay (`apps/api/src/testing/fresh-server.ts`), started once
 * for a spec and stopped after it. One place for it, since two specs that each started their own would
 * each be the one that forgot a change to the other (`CONTRIBUTING.md` §6.1).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Manifest {
  readonly origin: string;
  readonly code: string;
  readonly github: { readonly clientId: string; readonly clientSecret: string };
  readonly relay: { readonly port: number };
  /** The file the relay writes every letter it takes to, as JSON. */
  readonly mailbox: string;
}

export interface FreshServer {
  readonly manifest: Manifest;
  readonly stop: () => void;
}

/** Clear of the four worlds (`BASE_PORT + 100 × index`) and of a person's own demo. */
export const portFor = (offset: number): number =>
  Number(process.env['PURLAY_E2E_PORT'] ?? 4173) + offset;

export const startFresh = async (port: number): Promise<FreshServer> => {
  const directory = mkdtempSync(join(tmpdir(), 'purlay-setup-e2e-'));
  const file = join(directory, 'fresh.json');
  const child: ChildProcess = spawn(
    'bun',
    [
      '--no-env-file',
      'run',
      'apps/api/src/testing/fresh-server.ts',
      '--no-build',
      '--db',
      `purlay_e2e_fresh_${String(port)}`,
      '--port',
      String(port),
      '--manifest',
      file,
    ],
    { cwd: '../..', stdio: 'ignore' },
  );
  // Read in a loop below and set by the event, which a plain `let` would be narrowed past.
  const process_ = { exited: false };
  child.once('exit', () => {
    process_.exited = true;
  });
  const stop = (): void => {
    child.kill();
    rmSync(directory, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 1200 && !process_.exited && !existsSync(file); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!existsSync(file)) {
    stop();
    throw new Error(
      process_.exited
        ? 'the fresh server exited before it was ready (its output is not kept here: run apps/api/src/testing/fresh-server.ts by hand)'
        : 'the fresh server did not become ready',
    );
  }
  return { manifest: JSON.parse(readFileSync(file, 'utf8')) as Manifest, stop };
};

/** A letter as the relay took it: who it went to and its text, the encoding of the transport undone. */
export interface Letter {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
}

/** Quoted-printable undone, bytes and all, so a name with an accent reads as it was written. */
const decoded = (data: string): string => {
  const joined = data.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let at = 0; at < joined.length; at++) {
    const hex = joined.slice(at + 1, at + 3);
    if (joined[at] === '=' && /^[0-9A-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      at += 2;
    } else {
      bytes.push(...Buffer.from(joined.charAt(at), 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
};

const lettersIn = (mailbox: string): Letter[] => {
  const taken = JSON.parse(readFileSync(mailbox, 'utf8')) as {
    to: string[];
    data: string;
  }[];
  return taken.map(({ to, data }) => {
    const text = decoded(data);
    return { to, subject: /^Subject: (.*)$/m.exec(text)?.[1] ?? '', text };
  });
};

/** The `n`th letter (from 0) with this subject, waited for: the relay's file is written after the send. */
export const letterWith = async (mailbox: string, subject: RegExp, nth = 0): Promise<Letter> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = lettersIn(mailbox).filter((letter) => subject.test(letter.subject));
    const letter = found[nth];
    if (letter !== undefined) return letter;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no letter ${String(nth)} with a subject like ${String(subject)} came`);
};

/** The one link in a letter that matches. */
export const linkIn = (letter: Letter, pattern: RegExp): string => {
  const link = pattern.exec(letter.text)?.[0];
  if (link === undefined) throw new Error(`the letter "${letter.subject}" carries no such link`);
  return link;
};
