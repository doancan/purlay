/**
 * The composer. A stand-in the composer slice replaces; its props are the contract the
 * channel screen and the thread's reply box are written against, so they do not change.
 */
export interface ComposerProps {
  readonly channelId: string;
  /** The channel's name as the person knows it ("api", a person's name for a DM). */
  readonly channelName: string;
  /** Makes what is sent a reply to this root; the thread's own composer passes it. */
  readonly parentId?: string;
  /** Takes focus when it mounts: a channel opens ready to write, a thread's box does not. */
  readonly autoFocus?: boolean;
  /** Called with the id of every message the person sends, as it is sent. */
  readonly onSent?: (id: string) => void;
}

export const Composer = ({ channelName }: ComposerProps): React.JSX.Element => (
  <div className="border-t-hairline border-border-subtle px-4 py-3 text-body text-ink-muted">
    {channelName}
  </div>
);
