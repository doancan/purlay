/**
 * `bun run admin:reset-password <email>` — the server administrator's password, set again from the server
 * (D-179 §4, `docs/CONFIG.md` "Recovery"): the break-glass for the account whose password is lost.
 * For the server's administrator only; any other address is refused.
 *
 * The new password is read from the terminal, typed with nothing shown and asked twice, or — when
 * standard input is not a terminal — from its first line. **Never from an argument or from the
 * environment**: both are kept by the shell, the process table and the logs. A second argument is
 * refused without being repeated. Prints `Password changed for <email>` and nothing else of it — and, where
 * two-step verification was on, that it is off now (D-236); where password sign-in was off, that it is on again
 * and the server needs a restart for it (D-239). Works on
 * the database `DATABASE_URL` names, the real one included — it is what the command is for.
 */
import { createDatabase } from '@purlay/db';
import { normalisedMailbox } from '@purlay/types';
import { NEW_LINE, typed } from './hidden-input';
import { systemClock } from '../platform/clock';
import { resetAdministratorPassword } from '../modules/setup/reset-password';

const USAGE =
  'usage: bun run admin:reset-password <email>\nThe new password is read from the terminal, or from standard input — never from an argument.';

const fail: (message: string, code?: number) => never = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

/**
 * A line typed with nothing shown (`hidden-input.ts` decides each key). Resolves with it, or `undefined`
 * once cancelled. The terminal is put back however this ends: a key, SIGINT, SIGTERM, or the process's exit.
 */
const typedHidden = async (prompt: string): Promise<string | undefined> =>
  await new Promise((resolve) => {
    const input = process.stdin;
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let line = NEW_LINE;
    const restore = (): void => {
      try {
        input.setRawMode(false);
      } catch {
        // The terminal is gone; there is nothing to put back.
      }
    };
    const onTerm = (): void => {
      restore();
      process.exit(143);
    };
    const onInt = (): void => {
      restore();
      process.exit(130);
    };
    process.once('exit', restore);
    process.once('SIGTERM', onTerm);
    process.once('SIGINT', onInt);
    const finish = (result: string | undefined): void => {
      restore();
      input.pause();
      input.off('data', onData);
      process.off('exit', restore);
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      process.stderr.write('\n');
      resolve(result);
    };
    const onData = (chunk: string): void => {
      line = typed(line, chunk);
      if (line.done === 'submit') finish(line.value);
      else if (line.done === 'cancel') finish(undefined);
    };
    input.on('data', onData);
  });

const readPassword = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    const first = await typedHidden('New password: ');
    const again = first === undefined ? undefined : await typedHidden('Again: ');
    if (first === undefined || again === undefined) return fail('Cancelled.');
    if (first !== again) return fail('The two did not match. Nothing was changed.');
    return first;
  }
  const line = (await Bun.stdin.text()).split('\n')[0] ?? '';
  return line.replace(/\r$/, '');
};

const args = process.argv.slice(2);
if (args.length !== 1) fail(USAGE, 2);
const email = args[0] ?? '';
// Not repeated: what was typed as the address may be a password typed in the wrong place.
if (normalisedMailbox(email) === undefined) fail(`That is not an email address.\n${USAGE}`, 2);

const connectionString = process.env['DATABASE_URL'];
if (connectionString === undefined || connectionString === '') {
  fail('DATABASE_URL is not set: there is no database to change.', 2);
}

const password = await readPassword();
if (password === '') fail('No password was given. Nothing was changed.', 2);

const database = createDatabase({ connectionString, poolSize: 1 });
try {
  const outcome = await resetAdministratorPassword(
    database,
    { email, password },
    systemClock,
  ).catch(() => undefined);
  if (outcome === undefined) {
    fail(
      'Could not change the password: the database did not answer as needed. Nothing was changed.',
    );
  } else if (outcome.ok) {
    process.stdout.write(`Password changed for ${outcome.email}\n`);
    if (outcome.twoFactorOff) process.stdout.write('Two-step verification is off for it now.\n');
    if (outcome.passwordsOn) {
      process.stdout.write(
        'Password sign-in is on again. Restart the server for it to take effect.\n',
      );
    }
  } else if (outcome.reason === 'weak-password') {
    fail(`That password is not accepted (${outcome.problem}). Nothing was changed.`);
  } else {
    fail('No server administrator has that address. Nothing was changed.');
  }
} finally {
  await database.destroy();
}
