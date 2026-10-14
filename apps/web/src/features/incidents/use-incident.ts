/**
 * A channel's incident (#487, D-137): read, declared, moved. Kept current by `INCIDENT_UPDATED` and a
 * reconnect's resync, so it is not read again merely for being old.
 *
 * - **A change paints at once** (CONTRIBUTING §1.9): the incident in the cache takes the new status or
 *   severity before the server answers; a refusal puts it back as it was and says why.
 * - **A declaration keeps its id until it lands**: a retry after a failure — the answer lost, perhaps —
 *   sends the same id, which the server answers with the incident it made (D-137 §5).
 */
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  messageId,
  type ChangeIncidentRequest,
  type Incident,
  type IncidentResponse,
  type IncidentSeverity,
} from '@purlay/types';
import { useCallback, useContext, useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { readAgain } from '../../data/cache';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { RealtimePortsContext } from '../../realtime/realtime-provider';
import { systemClock } from '../../system-clock';
import { useToast } from '../../ui/toast';

/** The channel's open incident, or its latest; null when it never had one. */
export const useIncident = (channelId: string): UseQueryResult<Incident | null> => {
  const api = useApi();
  return useQuery({
    queryKey: keys.incident(channelId),
    queryFn: ({ signal }) => api.incident(channelId, signal),
    staleTime: Number.POSITIVE_INFINITY,
    select: (response: IncidentResponse) => response.incident,
  });
};

/** The incident as a change asks it to be: what the screen draws until the server answers. */
const asked = (incident: Incident, input: ChangeIncidentRequest, now: Date): Incident => {
  const severity = input.severity ?? incident.severity;
  if (incident.status === 'resolved') return { ...incident, severity };
  const status = input.status ?? incident.status;
  return status === 'resolved'
    ? { ...incident, severity, status, resolvedAt: now.toISOString() }
    : { ...incident, severity, status, resolvedAt: null };
};

export interface IncidentActions {
  /** Declares one at this severity; true once it is declared. */
  readonly declare: (severity: IncidentSeverity) => Promise<boolean>;
  readonly declaring: boolean;
  /** Changes it, painted at once and put back if refused; true once the server has it. */
  readonly change: (incident: Incident, input: ChangeIncidentRequest) => Promise<boolean>;
}

export const useIncidentActions = (channelId: string): IncidentActions => {
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const clock = useContext(RealtimePortsContext).clock ?? systemClock;
  /** The declaration on its way, until it lands: retried, it is the same one (D-137 §5). */
  const pending = useRef<{ readonly id: string; readonly severity: IncidentSeverity } | null>(null);
  const [declaring, setDeclaring] = useState(false);
  const key = keys.incident(channelId);

  /** The incident as the server last said it, while changes are on their way: what a refusal restores. */
  const confirmed = useRef<Incident | null>(null);
  const inFlight = useRef(0);
  const latest = useRef(0);

  const declare = useCallback(
    async (severity: IncidentSeverity): Promise<boolean> => {
      // An attempt whose answer was lost but which landed is the incident read back now: done.
      const known = client.getQueryData<IncidentResponse>(key)?.incident;
      if (pending.current !== null && known?.id === pending.current.id) pending.current = null;
      // The same attempt keeps its id: retried, it is the same declaration (D-137 §5). Another
      // severity is another declaration — the same id at it would be refused as a conflict.
      if (pending.current?.severity !== severity) {
        pending.current = { id: messageId(clock.now()), severity };
      }
      const { id } = pending.current;
      setDeclaring(true);
      try {
        const incident = await api.declareIncident(channelId, { id, severity });
        pending.current = null;
        client.setQueryData<IncidentResponse>(key, { incident });
        readAgain(client, [...key, 'updates']);
        return true;
      } catch (failure) {
        show({ message: describe(failure) });
        readAgain(client, key);
        return false;
      } finally {
        setDeclaring(false);
      }
    },
    [api, channelId, client, clock, describe, key, show],
  );

  const change = useCallback(
    async (incident: Incident, input: ChangeIncidentRequest): Promise<boolean> => {
      // What the server last said is what a refusal goes back to — never another change's paint.
      if (inFlight.current === 0) confirmed.current = incident;
      inFlight.current += 1;
      latest.current += 1;
      const mine = latest.current;
      // A read on its way began before this change: it must not paint over it.
      await client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData<IncidentResponse>(key, {
        incident: asked(incident, input, clock.now()),
      });
      try {
        const answered = await api.changeIncident(channelId, incident.id, input);
        confirmed.current = answered;
        // A later change is painted already: its own answer, or the read after, says the rest.
        if (mine === latest.current)
          client.setQueryData<IncidentResponse>(key, { incident: answered });
        readAgain(client, [...key, 'updates']);
        return true;
      } catch (failure) {
        if (mine === latest.current && confirmed.current !== null) {
          client.setQueryData<IncidentResponse>(key, { incident: confirmed.current });
        }
        show({ message: describe(failure) });
        readAgain(client, key);
        return false;
      } finally {
        inFlight.current -= 1;
      }
    },
    [api, channelId, client, clock, describe, key, show],
  );

  return { declare, declaring, change };
};
