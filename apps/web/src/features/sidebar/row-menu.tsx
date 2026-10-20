/**
 * The door to a sidebar row's context menu (D-165): what every row holds, so the menu itself stays in
 * the deferred chunk (`app/deferred.ts`), fetched the first time a pointer comes near a row or the
 * keyboard reaches one, and costing the first page only this.
 *
 * Three ways in, each the platform's own: a right click (and the `contextmenu` a browser makes of
 * Shift+F10 or the ContextMenu key); those two keys on a focused row, caught first so the menu opens
 * under the row rather than wherever the browser puts a keyboard's point; and on a touch screen a
 * finger held still on the row, after which the tap that ends the press goes nowhere.
 *
 * A menu that does not arrive says so in a toast and nothing opens; the next try asks again.
 */
import type { Channel } from '@purlay/types';
import { useCallback, useRef, useState } from 'react';
import type * as Deferred from '../../app/deferred';
import { useI18n } from '../../i18n/i18n-provider';
import { useChannelTitle } from '../channel/channel-header';
import { LEVELS, useChooseLevel } from '../channel/notification-level-menu';
import { useStar } from '../channel/star-toggle';
import { useContentPorts } from '../content/content-ports';
import type { MenuAnchor } from '../../ui/menu';
import { useToast } from '../../ui/toast';

/** How long a finger holds a row before its menu opens: a phone's own long press. */
export const LONG_PRESS_MS = 500;

/** How far a held finger may drift, in CSS pixels, before it is a scroll and not a press. */
const DRIFT = 10;

let loading: Promise<typeof Deferred> | null = null;

const load = (): Promise<typeof Deferred> => {
  loading ??= import('../../app/deferred').catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
};

/** Shift+F10 and the ContextMenu key: what a keyboard says for "the menu of what I am on". */
export const isMenuKey = (event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean =>
  event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');

/** What a row spreads on itself to be the menu's door. */
export interface RowMenuHandlers {
  readonly onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  readonly onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  readonly onPointerEnter: () => void;
  readonly onFocus: () => void;
  /** Before the link's own: a click it prevented goes nowhere. */
  readonly onClick: (event: React.MouseEvent<HTMLElement>) => void;
}

interface Opened {
  readonly anchor: MenuAnchor | null;
  readonly Menu: typeof Deferred.RowMenu;
}

export const useRowMenu = (
  channel: Channel,
  current: boolean,
): { readonly handlers: RowMenuHandlers; readonly menu: React.ReactNode } => {
  const { t } = useI18n();
  const { show } = useToast();
  const { copy } = useContentPorts();
  const title = useChannelTitle(channel);
  const star = useStar(channel);
  const choose = useChooseLevel(channel);
  const row = useRef<HTMLElement | null>(null);
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  // The click that ends a long press is the press's, not the link's.
  const pressed = useRef(false);
  const [opened, setOpened] = useState<Opened | null>(null);

  const open = useCallback(
    (anchor: MenuAnchor): void => {
      load().then(
        (module) => {
          setOpened({ anchor, Menu: module.RowMenu });
        },
        () => {
          show({ message: t('rowMenu.unavailable') });
        },
      );
    },
    [show, t],
  );

  const preload = useCallback((): void => {
    // A preload that fails is told by the opening that follows it, not twice.
    load().catch(() => undefined);
  }, []);

  const letGo = (): void => {
    if (press.current !== null) window.clearTimeout(press.current.timer);
    press.current = null;
  };

  const handlers: RowMenuHandlers = {
    onContextMenu: (event) => {
      event.preventDefault();
      row.current = event.currentTarget;
      letGo();
      // A keyboard's `contextmenu` has no point of its own (0, 0, or the element's corner): under the row.
      if (event.clientX === 0 && event.clientY === 0) {
        const box = event.currentTarget.getBoundingClientRect();
        open({ x: box.left, y: box.top, width: box.width, height: box.height });
      } else {
        open({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
      }
    },
    onKeyDown: (event) => {
      if (!isMenuKey(event)) return;
      event.preventDefault();
      row.current = event.currentTarget;
      const box = event.currentTarget.getBoundingClientRect();
      open({ x: box.left, y: box.top, width: box.width, height: box.height });
    },
    onPointerDown: (event) => {
      pressed.current = false;
      if (event.pointerType !== 'touch') return;
      preload();
      const target = event.currentTarget;
      const { clientX: x, clientY: y } = event;
      letGo();
      press.current = {
        x,
        y,
        timer: window.setTimeout(() => {
          press.current = null;
          pressed.current = true;
          row.current = target;
          open({ x, y, width: 0, height: 0 });
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (event) => {
      const at = press.current;
      if (at !== null && Math.hypot(event.clientX - at.x, event.clientY - at.y) > DRIFT) letGo();
    },
    onPointerUp: letGo,
    onPointerCancel: letGo,
    onPointerEnter: preload,
    onFocus: preload,
    onClick: (event) => {
      if (!pressed.current) return;
      pressed.current = false;
      event.preventDefault();
    },
  };

  const menu =
    opened === null ? null : (
      <opened.Menu
        channel={channel}
        current={current}
        title={title}
        copy={copy}
        star={star}
        choose={choose}
        levels={LEVELS}
        anchor={opened.anchor}
        onClose={() => {
          setOpened((was) => (was === null ? null : { ...was, anchor: null }));
        }}
        returnFocus={() => {
          row.current?.focus();
        }}
      />
    );

  return { handlers, menu };
};
