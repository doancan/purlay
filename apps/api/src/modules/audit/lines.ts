/**
 * Every entry of either trail, also as one line of the process's structured log (D-222): so a log
 * shipper sees administrative acts as they happen, beside the request that made them. The row is the
 * record (D-26 rejected a trail that lives only in logs, which a retention setting can erase); the line
 * is a copy for watching, never for answering "who did it".
 *
 * **Ids only, never a name.** The line carries the action, who acted, what it was done to, the workspace
 * and when — each an id or a fixed word. A row's metadata is not copied: it holds names (a workspace's,
 * a channel's, a repository's) beside ids, and the log is the place `ARCHITECTURE.md` §10 keeps free of
 * personal data. Of the metadata, only the values that are ids are carried, under their own keys.
 *
 * **Written when the row is**, inside the transaction that writes it: a line whose request then failed
 * is a row that was rolled back, and the request id every line carries joins the two.
 *
 * **Which logger** is the process's, handed over once as it starts (`sendAuditLinesTo`): the API's and
 * each command's that opens the database — `lines.test.ts` holds that every such entry point does.
 * Until then the lines go nowhere, which is what a test that never asks for them wants.
 */
import { NO_LOG } from '../../platform/events';
import type { Logger } from '../../platform/logging';

let sink: Logger = NO_LOG;

/** Where this process's audit lines go, from now on. */
export const sendAuditLinesTo = (log: Logger): void => {
  sink = log;
};

/** One entry, as the log says it. */
export interface AuditLine {
  /** Which trail: a workspace's (`audit_log`) or the server's own (`server_audit_log`). */
  readonly trail: 'workspace' | 'server';
  readonly entryId: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly workspaceId: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly at: Date;
  /** The row's metadata; only the values that are ids reach the line. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A UUID of any version, as the `uuid` format spells one: lower case. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The metadata's ids, by their keys (`channelId`, `authorId`); a name or a number never. */
const idsIn = (metadata: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(metadata).filter(([, value]) => UUID.test(value)));

export const writeAuditLine = (line: AuditLine): void => {
  sink.info('audit entry recorded', {
    audit: {
      trail: line.trail,
      entryId: line.entryId,
      action: line.action,
      actorId: line.actorId,
      workspaceId: line.workspaceId,
      targetType: line.targetType,
      targetId: line.targetId,
      relatedIds: idsIn(line.metadata ?? {}),
      at: line.at.toISOString(),
    },
  });
};
