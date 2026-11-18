/**
 * The emoji names, fetched when the first colon is typed (`emoji-shortcodes.ts`): `null` until the chunk
 * has arrived, then the module itself for the rest of the page's life. A failed fetch is not remembered,
 * so the next colon asks again; until then nothing is offered and a colon stays a colon.
 */
import { useEffect, useState } from 'react';
import type * as EmojiList from './emoji-list';

type EmojiNames = typeof EmojiList;

let loaded: EmojiNames | null = null;

export const useEmojiNames = (wanted: boolean): EmojiNames | null => {
  const [names, setNames] = useState<EmojiNames | null>(loaded);
  useEffect(() => {
    if (!wanted || names !== null) return;
    void import('./emoji-list').then(
      (module) => {
        loaded = module;
        setNames(module);
      },
      () => undefined,
    );
  }, [wanted, names]);
  return names;
};
