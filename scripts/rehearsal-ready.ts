/**
 * Starts the application against the database it is pointed at and waits for its
 * own readiness (scripts/restore-rehearsal.sh).
 *
 * Ready means every migration is recorded and the identifier columns still compare
 * byte-wise (D-40) — what a restore into a differently provisioned cluster would
 * lose. Asking the real process, rather than re-stating its checks, makes the
 * rehearsal fail whenever readiness would. Runs inside the API image, where the
 * entry point is /app/apps/api/src/index.ts.
 */
const server = Bun.spawn(['/usr/local/bin/bun', '/app/apps/api/src/index.ts'], {
  stdout: 'inherit',
  stderr: 'inherit',
});

const port = process.env['PORT'] ?? '3001';
let status = 0;
for (let attempt = 0; attempt < 30 && status !== 200; attempt += 1) {
  await Bun.sleep(500);
  status = await fetch(`http://127.0.0.1:${port}/health/ready`).then(
    (response) => response.status,
    () => 0,
  );
}
server.kill();
await server.exited;

if (status !== 200) {
  console.error(
    `the application did not become ready on the restored database (last status ${String(status)})`,
  );
  process.exit(1);
}
console.log('ready: the application serves from the restored database');
