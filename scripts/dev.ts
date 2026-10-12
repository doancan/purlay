/**
 * `bun run dev`: one command that always comes up.
 *
 * With GitHub sign-in configured (`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env`), it is
 * the development pair — the API with `--watch` and Vite — signing in through GitHub. Without them
 * the API refuses to start (rightly: it cannot sign anybody in), so instead of a stack that half
 * starts, it runs the demo on the same port: the real API and database, seeded, with four people
 * to sign in as. It says which one it started, and why.
 */
const githubReady =
  (process.env['GITHUB_CLIENT_ID'] ?? '') !== '' &&
  (process.env['GITHUB_CLIENT_SECRET'] ?? '') !== '';
const port = process.env['WEB_PORT'] ?? '5173';

const command = githubReady
  ? ['bun', '--filter', '@purlay/api', '--filter', '@purlay/web', 'dev']
  : ['bun', 'run', 'scripts/demo.ts', '--port', port, '--db', 'purlay_demo_dev'];

if (!githubReady) {
  console.log(
    [
      '',
      '  GitHub sign-in is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set in .env),',
      '  so this starts the demo instead: the real API and database, seeded, with people to sign in as.',
      `  When it says READY, open http://localhost:${port}/__demo/login?as=dogancan`,
      '  (or as=alice, as=bob, as=carol — one per browser to chat between them).',
      '  To sign in with GitHub instead, see docs/CONFIG.md and set both variables in .env.',
      '',
    ].join('\n'),
  );
}

const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
process.exit(await child.exited);
