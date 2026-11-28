/**
 * Who else is typing in the channel (D-114), in the composer's footer, beside its buttons: the row is
 * always there, so nothing moves when somebody starts or stops. It is not a live region: in a busy channel it
 * changes whenever anyone starts or stops, and a person writing with a screen reader would be interrupted at every
 * keystroke of somebody else's. It is read where it is, beside the box.
 *
 * Names come from the workspace's members, read only once somebody is typing; a person not among
 * them yet is "someone" rather than an id.
 */
import { useMembers } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { useTyping } from '../../../realtime/realtime-provider';
import { useWorkspace } from '../../shell/workspace';

const Names = ({ typists }: { readonly typists: readonly string[] }): string => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const members = useMembers(workspace.id).data;
  const nameOf = (userId: string | undefined): string =>
    members?.find((member) => member.user.id === userId)?.user.displayName ?? t('typing.someone');
  const [first, second] = typists;
  if (typists.length > 2) return t('typing.several');
  if (typists.length === 2)
    return t('typing.two', { first: nameOf(first), second: nameOf(second) });
  return t('typing.one', { name: nameOf(first) });
};

export const TypingLine = ({ channelId }: { readonly channelId: string }): React.JSX.Element => {
  const typists = useTyping(channelId);
  return (
    <span data-typing="" className="min-w-0 truncate text-caption text-ink-muted">
      {typists.length > 0 && <Names typists={typists} />}
    </span>
  );
};
