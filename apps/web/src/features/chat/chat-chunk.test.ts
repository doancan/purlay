/**
 * Chat's screens are a chunk of their own (D-250): nothing in the shell imports one statically, and the door asks
 * for them once. The build proves it from the other side (`bun run budget:web` reads the shell chunk's source
 * map); this is the same rule where a test run sees it before a build does.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chatScreens, chunkOf } from './load';

const SRC = join(import.meta.dirname, '..', '..');
const CHAT_ENTRY = join(SRC, 'features', 'chat', 'chat.ts');
/** The test harness mounts screens directly and is no part of the build. */
const HARNESS = join(SRC, 'testing');
/** The seven screens the entry re-exports: the only modules the shell must reach through `import()`. */
const SCREENS = [
  'channel/channel-screen',
  'drafts/drafts-screen',
  'inbox/inbox-screen',
  'questions/questions-screen',
  'saved/saved-screen',
  'search/search-screen',
  'unreads/unreads-screen',
];

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|e2e)\.tsx?$/.test(entry.name) ? [path] : [];
  });

const STATIC_IMPORT = /^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm;

/** What a file imports with `import … from` or `export … from`; `import()` is the lazy way and is not listed. */
const staticImports = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)].map((found) => found[1] ?? '');

describe("chat's chunk", () => {
  test('is reached by no static import: the screens only from the entry, the entry from nowhere', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC).filter((f) => !f.startsWith(HARNESS))) {
      for (const path of staticImports(file)) {
        const namesScreen = SCREENS.some((screen) => path.endsWith(`/${screen}`));
        const namesEntry = path.endsWith('/chat/chat');
        if ((namesScreen && file !== CHAT_ENTRY) || namesEntry) {
          offenders.push(`${relative(SRC, file)} imports ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('is asked for once, and holds the seven screens', async () => {
    expect(chatScreens()).toBe(chatScreens());
    const screens = await chatScreens();
    expect(Object.keys(screens).sort()).toEqual([
      'ChannelScreen',
      'DraftsScreen',
      'InboxScreen',
      'QuestionsScreen',
      'SavedScreen',
      'SearchScreen',
      'UnreadsScreen',
    ]);
  });

  test('a request that fails is forgotten, so the next ask tries again; one that succeeds is shared', async () => {
    let calls = 0;
    const chunk = chunkOf(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('screens');
    });
    const failure = await chunk.get().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('offline');
    expect(await chunk.get()).toBe('screens');
    expect(await chunk.get()).toBe('screens');
    expect(calls).toBe(2);
  });

  test('warming never throws, even when the request fails, and the failure is not kept', async () => {
    let calls = 0;
    const chunk = chunkOf(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('screens');
    });
    chunk.warm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await chunk.get()).toBe('screens');
  });
});
