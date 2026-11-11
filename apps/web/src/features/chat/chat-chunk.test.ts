/**
 * Chat's screens are a chunk of their own (D-250): nothing in the shell imports one statically, and the door asks
 * for them once. The build proves it from the other side (`bun run budget:web` reads the shell chunk's source
 * map); this is the same rule where a test run sees it before a build does.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { moduleChunk } from '../../app/module-route';

const SRC = join(import.meta.dirname, '..', '..');
const CHAT_ENTRY = join(SRC, 'features', 'chat', 'chat.ts');
/** The test harness mounts screens directly and is no part of the build. */
const HARNESS = join(SRC, 'testing');
/** The screens behind the entry, including its nested lazy screen: none may enter the shell statically. */
const SCREENS = [
  'channel/channel-screen',
  'drafts/drafts-screen',
  'followed/followed-screen',
  'inbox/inbox-screen',
  'questions/questions-screen',
  'saved/saved-screen',
  'search/search-screen',
  'shared/shared-screen',
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

  test('is asked for once, and holds every registered screen', async () => {
    const chat = moduleChunk('chat');
    expect(chat.get()).toBe(chat.get());
    const { screens } = await chat.get();
    expect(Object.keys(screens).sort()).toEqual([
      'channel',
      'drafts',
      'followed',
      'inbox',
      'questions',
      'saved',
      'search',
      'shared',
      'unreads',
    ]);
  });
});
