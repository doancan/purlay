/**
 * The files a person has attached and the send they asked for while those files were still
 * uploading — held per place to write (a channel, or one thread in it: the draft's key), above any
 * composer, for the life of the signed-in page.
 *
 * "The message can be sent while the upload is still in flight" and "a draft is never lost"
 * (`UX.md` §5) are both broken by a composer that keeps these itself: a channel switch remounts it
 * (`<ChannelView key=…>`), closing a thread's panel unmounts it, and its state goes with it — the
 * words survive as a draft, the files and the waiting send do not (D-169). So they live here:
 *
 * - **While a composer for the place is on the screen, it sends** — its own words, as it always did,
 *   once nothing is uploading.
 * - **While none is, this sends**, the moment the last file lands: the words the composer held when
 *   it went, to where they were written, and the draft is cleared as a send from the box clears it.
 * - **A file that failed holds the send back, and the person is told**, by name of the place; the
 *   words, the files and the reason are all there when they go back.
 *
 * Nothing here is React: the provider (`uploads.tsx`) gives it the network, the engine and the
 * words, and the composer reads it through `useSyncExternalStore`.
 */
import type { Attachment } from '@purlay/types';
import type { FailureCode } from '../../data/failure';
import { writeDraft, type DraftStorage } from './drafts';

export type Upload = {
  readonly id: string;
  readonly name: string;
  readonly file: Blob;
  /** Where it is uploaded: the workspace the person was in when they added it. */
  readonly workspaceId: string;
} &
  /** How much has been sent, as a whole percent; null until the browser has measured any (#388). */
  (
    | { readonly status: 'uploading'; readonly percent: number | null }
    | { readonly status: 'ready'; readonly attachment: Attachment }
    | {
        readonly status: 'failed';
        readonly reason: FailureCode;
        /** The room the workspace still had, when it was out of room (D-159). */
        readonly remainingBytes: number | null;
      }
    /** Over the limit: refused here, so there is nothing to retry. */
    | { readonly status: 'too-large' }
  );

/** A send asked for while files were uploading: what it is, and where it goes. */
export interface Waiting {
  readonly channelId: string;
  readonly parentId: string | undefined;
  /** The place as the person knows it, to name it if the send cannot go. */
  readonly channelName: string;
  /** The words, as the composer last held them. */
  readonly content: string;
  /** Where the place's draft lives, cleared once this is sent. */
  readonly storage: DraftStorage | null;
}

interface Place {
  readonly items: readonly Upload[];
  readonly waiting: Waiting | null;
}

export interface OutboxPorts {
  readonly upload: (
    workspaceId: string,
    item: { readonly id: string; readonly name: string; readonly file: Blob },
    onProgress: (fraction: number) => void,
  ) => Promise<Attachment>;
  /** Why an upload was refused, from what the upload rejected with. */
  readonly refusal: (failure: unknown) => {
    readonly reason: FailureCode;
    readonly remainingBytes: number | null;
  };
  readonly send: (message: {
    readonly channelId: string;
    readonly content: string;
    readonly parentId?: string;
    readonly attachments: readonly Attachment[];
  }) => void;
  /** A send that was waiting while nobody was looking cannot go: a file did not upload. */
  readonly refused: (channelName: string) => void;
}

export interface Outbox {
  readonly subscribe: (listener: () => void) => () => void;
  /** The same object until the place changes, as `useSyncExternalStore` needs. */
  readonly read: (key: string) => Place;
  /** Adds what was attached; each one still `uploading` starts at once. */
  readonly add: (key: string, added: readonly Upload[]) => void;
  readonly retry: (key: string, id: string) => void;
  /** Takes one out, and says what it was. */
  readonly remove: (key: string, id: string) => Upload | undefined;
  /** What was sent goes with it. */
  readonly clear: (key: string) => void;
  /** Asks for a send once nothing uploads, or (null) asks no longer. */
  readonly wait: (key: string, waiting: Waiting | null) => void;
  /**
   * A composer for the place is on the screen, and sends for it. The function returned is called as
   * it goes, with the words it held then: from that moment a waiting send is this module's.
   */
  readonly hold: (key: string) => (content: string) => void;
}

const EMPTY: Place = { items: [], waiting: null };

export const createOutbox = (ports: OutboxPorts): Outbox => {
  const places = new Map<string, Place>();
  const listeners = new Set<() => void>();
  const held = new Map<string, number>();

  const read = (key: string): Place => places.get(key) ?? EMPTY;
  const write = (key: string, next: Place): void => {
    if (next.items.length === 0 && next.waiting === null) places.delete(key);
    else places.set(key, next);
    for (const listener of listeners) listener();
  };
  const update = (key: string, change: (items: readonly Upload[]) => readonly Upload[]): void => {
    const place = read(key);
    write(key, { ...place, items: change(place.items) });
  };

  /** Sends what is waiting, if nothing uploads and no composer is there to do it. */
  const deliver = (key: string): void => {
    const { items, waiting } = read(key);
    if (waiting === null || (held.get(key) ?? 0) > 0) return;
    if (items.some((item) => item.status === 'uploading')) return;
    if (items.some((item) => item.status === 'failed' || item.status === 'too-large')) {
      // Kept, words and files, for the person to retry or remove when they go back — and said now.
      write(key, { items, waiting: null });
      ports.refused(waiting.channelName);
      return;
    }
    ports.send({
      channelId: waiting.channelId,
      content: waiting.content,
      ...(waiting.parentId === undefined ? {} : { parentId: waiting.parentId }),
      attachments: items.flatMap((item) => (item.status === 'ready' ? [item.attachment] : [])),
    });
    writeDraft(waiting.storage, key, '');
    write(key, EMPTY);
  };

  const settle = (key: string, id: string, next: Upload): void => {
    // A file removed while it was uploading is not put back by its answer.
    if (!read(key).items.some((item) => item.id === id)) return;
    update(key, (items) => items.map((item) => (item.id === id ? next : item)));
    deliver(key);
  };

  const start = (key: string, item: Upload): void => {
    const base = { id: item.id, name: item.name, file: item.file, workspaceId: item.workspaceId };
    // Told on every chunk; kept only when the whole percent moves, so a fast link is not a re-render a chunk.
    const progress = (fraction: number): void => {
      const percent = Math.floor(fraction * 100);
      const current = read(key).items.find((candidate) => candidate.id === item.id);
      if (current?.status !== 'uploading' || current.percent === percent) return;
      update(key, (items) =>
        items.map((candidate) =>
          candidate.id === item.id ? { ...base, status: 'uploading', percent } : candidate,
        ),
      );
    };
    ports.upload(item.workspaceId, base, progress).then(
      (attachment) => {
        settle(key, item.id, { ...base, status: 'ready', attachment });
      },
      (failure: unknown) => {
        settle(key, item.id, { ...base, status: 'failed', ...ports.refusal(failure) });
      },
    );
  };

  return {
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    read,
    add: (key, added): void => {
      update(key, (items) => [...items, ...added]);
      for (const item of added) if (item.status === 'uploading') start(key, item);
    },
    retry: (key, id): void => {
      const item = read(key).items.find((candidate) => candidate.id === id);
      if (item?.status !== 'failed') return;
      const again: Upload = {
        id: item.id,
        name: item.name,
        file: item.file,
        workspaceId: item.workspaceId,
        status: 'uploading',
        percent: null,
      };
      update(key, (items) => items.map((candidate) => (candidate.id === id ? again : candidate)));
      start(key, again);
    },
    remove: (key, id): Upload | undefined => {
      const item = read(key).items.find((candidate) => candidate.id === id);
      update(key, (items) => items.filter((candidate) => candidate.id !== id));
      return item;
    },
    clear: (key): void => {
      write(key, { ...read(key), items: [] });
    },
    wait: (key, waiting): void => {
      write(key, { ...read(key), waiting });
    },
    hold: (key): ((content: string) => void) => {
      held.set(key, (held.get(key) ?? 0) + 1);
      return (content): void => {
        const left = (held.get(key) ?? 1) - 1;
        if (left > 0) held.set(key, left);
        else held.delete(key);
        const { waiting } = read(key);
        if (waiting !== null) write(key, { ...read(key), waiting: { ...waiting, content } });
        deliver(key);
      };
    },
  };
};
