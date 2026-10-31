/**
 * The Audit log page's filter, as its address carries it and as the server is asked it (D-222).
 *
 * **In the address, days; to the server, instants.** A person picks *From* and *To* as calendar days in
 * their own zone, and the address keeps those days (`?from=2026-10-01&to=2026-10-31`) — so a reload,
 * Back and a shared link come back to the same days, read in whoever opens it's zone. The server is
 * asked from the instant *From* begins to the instant the day after *To* begins (`to` exclusive), both
 * in UTC, so *To* is included whole.
 *
 * Only the filter's own vocabulary is read back from an address: a person by id, an action the client
 * knows, a day that is one. Anything else is left out rather than sent to be refused.
 */
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditExportFormat,
  type AuditFilter,
} from '@purlay/types';

/** What the page narrows by, as the person chose it: days, not instants. */
export interface AuditView {
  readonly actorId: string | null;
  readonly action: AuditAction | null;
  /** `YYYY-MM-DD`, in the reader's zone. */
  readonly from: string | null;
  readonly to: string | null;
}

export const NO_FILTER: AuditView = { actorId: null, action: null, from: null, to: null };

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day that exists: `2026-02-31` has the shape and is not one. */
const isDay = (value: string): boolean => {
  if (!DAY_SHAPE.test(value)) return false;
  const [y = 0, m = 1, d = 1] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

const knownAction = (value: string | null): AuditAction | null =>
  AUDIT_ACTIONS.find((action) => action === value) ?? null;

/** The filter an address names (`location.search`). */
export const auditViewIn = (search: string): AuditView => {
  const params = new URLSearchParams(search);
  const actor = params.get('actor');
  const from = params.get('from');
  const to = params.get('to');
  return {
    actorId: actor !== null && ID_SHAPE.test(actor) ? actor : null,
    action: knownAction(params.get('action')),
    from: from !== null && isDay(from) ? from : null,
    to: to !== null && isDay(to) ? to : null,
  };
};

/** The address's query for a filter, without the `?`; empty when nothing narrows. */
export const auditSearchOf = (view: AuditView): string => {
  const params = new URLSearchParams();
  if (view.actorId !== null) params.set('actor', view.actorId);
  if (view.action !== null) params.set('action', view.action);
  if (view.from !== null) params.set('from', view.from);
  if (view.to !== null) params.set('to', view.to);
  return params.toString();
};

export const isNarrowed = (view: AuditView): boolean => auditSearchOf(view) !== '';

/** A window whose last day comes before its first: the page says so and asks nothing. */
export const isBackwards = (view: AuditView): boolean =>
  view.from !== null && view.to !== null && view.to < view.from;

const dayAfter = (isoDay: string): string => {
  const [y = 0, m = 1, d = 1] = isoDay.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** The filter as the server takes it: days become the instants they begin in the reader's zone. */
export const auditFilterOf = (
  view: AuditView,
  dayStart: (isoDay: string) => Date,
): AuditFilter => ({
  ...(view.actorId === null ? {} : { actorId: view.actorId }),
  ...(view.action === null ? {} : { action: view.action }),
  ...(view.from === null ? {} : { from: dayStart(view.from).toISOString() }),
  ...(view.to === null ? {} : { to: dayStart(dayAfter(view.to)).toISOString() }),
});

/** Where the filtered trail downloads from: a link the browser follows with the session's cookie. */
export const auditExportHref = (
  workspaceId: string,
  filter: AuditFilter,
  format: AuditExportFormat,
): string => {
  const params = new URLSearchParams({ ...filter, format });
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/audit/export?${params.toString()}`;
};
