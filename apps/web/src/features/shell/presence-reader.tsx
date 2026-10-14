/**
 * Reads who among the workspace's members is online (#480, D-136) into the realtime state: when the
 * workspace opens, when who its members are changes (somebody joined is not told by a frame), and a grace after
 * every reconnect — so a node that restarted has its people back before it is believed. Each change
 * keeps the largest version heard, so a snapshot read before a frame cannot undo it.
 *
 * A failure draws nothing: an unknown person has no dot, never an offline one — and a failed read
 * forgets what was heard before it, since that may be stale. A gap in the connection longer than the
 * grace forgets it too (`realtime/engine.ts`).
 */
import { useQuery } from '@tanstack/react-query';
import type { PresenceChange } from '@purlay/types';
import { useEffect, useMemo, useRef } from 'react';
import { useApi } from '../../data/api-provider';
import { keys } from '../../data/keys';
import { useMembers } from '../../data/queries';
import { useEngine, usePresenceEpoch } from '../../realtime/realtime-provider';
import { useWorkspace } from './workspace';

export const PresenceReader = (): null => {
  const api = useApi();
  const engine = useEngine();
  const { workspace } = useWorkspace();
  const epoch = usePresenceEpoch();
  const members = useMembers(workspace.id);
  // Who is in it, not when that was read: a reconnect reads the members again, and the same people
  // must not read presence at once — the grace after it is what keeps a restarted node's team on.
  const who = useMemo(
    () =>
      members.data === undefined
        ? ''
        : members.data
            .map((member) => member.user.id)
            .sort()
            .join(' '),
    [members.data],
  );
  const snapshot = useQuery({
    queryKey: [...keys.presence(workspace.id, epoch), who],
    queryFn: async ({ signal }) => await api.presence(workspace.id, signal),
    // Read when asked, never from a cache: a snapshot kept from an hour ago, applied again on coming
    // back to a workspace, would bring back whoever left since. Not on focus either — only the grace
    // decides when a reconnected client asks again.
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: members.data !== undefined,
  });

  // Somebody who left the workspace is never told of again (D-136 §1): what was heard of them goes,
  // or their dot would stay in a conversation with them until a reload.
  const known = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (members.data === undefined) return;
    const now = new Set(members.data.map((member) => member.user.id));
    engine.forgetPresence([...known.current].filter((userId) => !now.has(userId)));
    known.current = now;
  }, [members.data, engine]);

  // A snapshot that failed leaves nobody known: the last thing heard may have missed who left in a
  // gap, and a dot believed then is worse than none.
  const failed = snapshot.isError;
  useEffect(() => {
    if (!failed || members.data === undefined) return;
    engine.forgetPresence(members.data.map((member) => member.user.id));
  }, [failed, members.data, engine]);

  useEffect(() => {
    if (snapshot.data === undefined || members.data === undefined) return;
    const online = new Set(snapshot.data.online.map((change) => change.userId));
    const offline: PresenceChange[] = members.data
      .filter((member) => !online.has(member.user.id))
      .map((member) => ({ userId: member.user.id, online: false, version: snapshot.data.version }));
    engine.applyPresence([...snapshot.data.online, ...offline]);
  }, [snapshot.data, members.data, engine]);

  return null;
};
