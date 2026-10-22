/**
 * A self-signed certificate for `localhost` and `127.0.0.1`, made once per test process by `openssl`
 * into a directory of its own: what a relay or a GitHub with an untrusted certificate presents. Made
 * at run time rather than kept in the repository, so no private key is ever committed — even a test's.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Certificate {
  readonly cert: string;
  readonly key: string;
  /** Where the certificate is on disk: what `NODE_EXTRA_CA_CERTS` would name. */
  readonly certFile: string;
}

let made: Certificate | undefined;

export const aSelfSignedCertificate = (): Certificate => {
  if (made !== undefined) return made;
  const directory = mkdtempSync(join(tmpdir(), 'purlay-certificate-'));
  const keyFile = join(directory, 'key.pem');
  const certFile = join(directory, 'cert.pem');
  const run = Bun.spawnSync(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  if (run.exitCode !== 0) {
    throw new Error(`openssl could not make a test certificate: ${run.stderr.toString()}`);
  }
  made = { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8'), certFile };
  return made;
};
