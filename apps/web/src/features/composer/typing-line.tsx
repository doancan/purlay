/**
 * Who else is typing in the channel (D-114), in the composer's footer beside the hints: the row is
 * always there, so nothing moves when somebody starts or stops. The region is always there too, so
 * a screen reader hears the change politely rather than missing a region that appeared with it.
 *
 * Names come from the workspace's members, read only once somebody is typing; a person not among
 * them yet is "someone" rather than an id.
 */
import { useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useTyping } from '../../realtime/realtime-provider';
import { useWorkspace } from '../shell/workspace';

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
    <span aria-live="polite" className="min-w-0 truncate text-caption text-ink-muted">
      {typists.length > 0 && <Names typists={typists} />}
    </span>
  );
};
