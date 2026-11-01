/**
 * Writing an export to disk (D-140): into `<directory>.partial`, owner-only, then renamed — so a run that
 * stops halfway leaves something nobody would mistake for an export, and one that finishes appears
 * whole. The directory must not exist: an export never writes over anything.
 *
 * Owner-only (0700 / 0600): the files hold a workspace's every conversation, direct ones included.
 */
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Database } from '@purlay/db';
import type { ExportManifest, PersonalExportManifest } from '@purlay/types';
import { AppError } from '../../platform/errors';

const exists = async (path: string): Promise<boolean> =>
  await stat(path).then(
    () => true,
    () => false,
  );

/**
 * A directory being written — a workspace's export or a person's (D-241) — its files opened as their
 * first line comes.
 */
export interface ExportDirectory {
  readonly write: (table: keyof Database, lines: readonly string[]) => Promise<void>;
  /** Every table's file, empty ones too, then the manifest: the export is whole, still `.partial`. */
  readonly seal: (
    manifest: ExportManifest | PersonalExportManifest,
    tables: readonly (keyof Database)[],
  ) => Promise<void>;
  /** A file the export names, streamed to `blobs/<name>`; its bytes, or a throw with nothing left. */
  readonly writeBlob: (name: string, body: ReadableStream<Uint8Array>) => Promise<number>;
  /** The directory takes its name: only once the trail has said it exists. */
  readonly publish: () => Promise<string>;
  /** Closes what is open, leaving the `.partial` directory for the operator to look at or remove. */
  readonly abandon: () => Promise<void>;
}

const refuse = (field: string, says: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'That is not a place to write an export.',
    details: { fields: { [field]: says } },
  });

export const exportDirectory = async (target: string): Promise<ExportDirectory> => {
  const partial = `${target}.partial`;
  // A parent other people may write into, without the sticky bit, lets one of them swap the directory
  // for their own while the export writes (D-140 §5).
  const parent = await stat(dirname(target)).catch(() => null);
  if (parent === null) throw refuse('directory', `${dirname(target)} does not exist`);
  if ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0) {
    throw refuse('directory', `${dirname(target)} is writable by others`);
  }
  for (const path of [target, partial]) {
    if (await exists(path)) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'An export never writes over anything.',
        details: { fields: { directory: `${path} exists already` } },
      });
    }
  }
  await mkdir(partial, { recursive: false, mode: 0o700 });
  const files = new Map<keyof Database, FileHandle>();
  const fileOf = async (table: keyof Database): Promise<FileHandle> => {
    const open_ = files.get(table);
    if (open_ !== undefined) return open_;
    const handle = await open(join(partial, `${table}.ndjson`), 'wx', 0o600);
    files.set(table, handle);
    return handle;
  };
  const closeAll = async (): Promise<void> => {
    for (const handle of files.values()) await handle.close();
    files.clear();
  };
  return {
    write: async (table, lines): Promise<void> => {
      if (lines.length === 0) return;
      await (await fileOf(table)).write(`${lines.join('\n')}\n`);
    },
    writeBlob: async (name, body): Promise<number> => {
      if (!/^[0-9a-f-]+(\.thumbnail)?$/.test(name))
        throw new Error('a blob is named by its id alone');
      await mkdir(join(partial, 'blobs'), { recursive: true, mode: 0o700 });
      const path = join(partial, 'blobs', name);
      const handle = await open(path, 'wx', 0o600);
      let bytes = 0;
      try {
        for await (const chunk of body) {
          bytes += chunk.byteLength;
          await handle.write(chunk);
        }
      } catch (error) {
        // A read cut off halfway leaves no file that looks whole.
        await handle.close();
        await rm(path, { force: true });
        throw error;
      }
      await handle.close();
      return bytes;
    },
    seal: async (manifest, tables): Promise<void> => {
      for (const table of tables) await fileOf(table);
      await closeAll();
      const handle = await open(join(partial, 'manifest.json'), 'wx', 0o600);
      await handle.write(`${JSON.stringify(manifest, null, 2)}\n`);
      await handle.close();
    },
    publish: async (): Promise<string> => {
      // Nothing may have taken the name meanwhile: an export never writes over anything.
      if (await exists(target)) throw refuse('directory', `${target} exists already`);
      await rename(partial, target);
      return target;
    },
    abandon: closeAll,
  };
};
