/** The move dialog outlives a row moving between sections, so failures can restore and explain it. */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Channel } from '@purlay/types';
import { useDeferred } from '../../../app/deferred-door';
import { useChannels } from '../../../data/queries';
import { useWorkspace } from '../../shell/workspace';
import { href } from '../../../router/routes';

const Placement = createContext<((channel: Channel) => void) | null>(null);

export const useOpenGroupMove = (): ((channel: Channel) => void) | null => useContext(Placement);

export const ChannelPlacementProvider = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const root = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const open = useCallback((channel: Channel): void => {
    setSelected(channel.id);
  }, []);
  const close = useCallback((next: boolean): void => {
    if (!next) setSelected(null);
  }, []);
  const channel = channels.data?.find((entry) => entry.id === selected && entry.state !== null);
  const deferred = useDeferred([selected !== null, close]);
  useEffect(() => {
    if (selected !== null && channels.data !== undefined && channel === undefined)
      setSelected(null);
  }, [selected, channels.data, channel]);
  return (
    <Placement.Provider value={open}>
      <div ref={root} className="contents">
        {children}
        {deferred !== null && channel !== undefined && (
          <deferred.MoveChannelGroupDialog
            key={channel.id}
            channel={channel}
            open={selected !== null}
            onOpenChange={close}
            returnFocus={() => {
              const path = href('channel', { slug: workspace.slug, channelId: channel.id });
              return (
                [...(root.current?.querySelectorAll<HTMLAnchorElement>('a') ?? [])].find(
                  (link) => link.getAttribute('href') === path,
                ) ??
                root.current?.querySelector<HTMLButtonElement>(
                  'button[aria-controls="sidebar-list-channels"]',
                ) ??
                null
              );
            }}
          />
        )}
      </div>
    </Placement.Provider>
  );
};
