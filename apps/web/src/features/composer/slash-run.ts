/**
 * What a slash command does (D-214): each through what the product already does — the channel's
 * topic through its edit, the level and the star through the hooks the header uses, Deep Work through
 * its controls, search through its address — so a command paints, is refused and is put back exactly
 * as the button it stands for.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { Channel } from '@purlay/types';
import { useActions } from '../../data/actions-provider';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannels, useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { useChooseLevel } from '../channel/notification-level-menu';
import { useStar } from '../channel/star-toggle';
import { forgetChannel } from '../questions/last-channel';
import { useDeepWorkControls } from '../shell/deep-work';
import { useWorkspace } from '../shell/workspace';
import { deepWorkOf, inviteeOf, meMessage, shrugMessage, type SlashName } from './slash';

/** What running a command came to: words to send, done (said in a toast), or why it was not. */
export type SlashOutcome =
  | { readonly kind: 'send'; readonly content: string }
  | { readonly kind: 'done'; readonly said: string }
  | { readonly kind: 'refused'; readonly reason: string };

export const useSlashRunner = (
  channelId: string,
): ((name: SlashName, args: string) => Promise<SlashOutcome>) => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const actions = useActions();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const channel: Channel | undefined = useChannels(workspace.id).data?.find(
    (each) => each.id === channelId,
  );
  const members = useMembers(workspace.id).data;
  const chooseLevel = useChooseLevel(channel);
  const star = useStar(channel);
  const deepWork = useDeepWorkControls();
  const refused = (reason: string): SlashOutcome => ({ kind: 'refused', reason });
  const failed = (failure: unknown): SlashOutcome => refused(describe(failure));

  return async (name, args) => {
    switch (name) {
      case 'me': {
        const content = meMessage(args);
        return content === null ? refused(t('slash.me.usage')) : { kind: 'send', content };
      }
      case 'shrug':
        return { kind: 'send', content: shrugMessage(args) };
      case 'topic':
        try {
          await actions.updateChannel(channelId, { topic: args === '' ? null : args });
          return { kind: 'done', said: t(args === '' ? 'slash.topic.cleared' : 'slash.topic.set') };
        } catch (failure) {
          return failed(failure);
        }
      case 'mute':
      case 'unmute':
        if (channel?.notificationLevel === null || channel === undefined) {
          return refused(t('slash.notMember'));
        }
        chooseLevel(name === 'mute' ? 'none' : 'mentions');
        return { kind: 'done', said: t(name === 'mute' ? 'slash.muted' : 'slash.unmuted') };
      case 'star':
      case 'unstar':
        if (star === null) return refused(t('slash.notMember'));
        star(name === 'star');
        return { kind: 'done', said: t(name === 'star' ? 'slash.starred' : 'slash.unstarred') };
      case 'invite': {
        const handle = inviteeOf(args);
        if (handle === null) return refused(t('slash.invite.usage'));
        const member = members?.find((each) => each.user.username.toLowerCase() === handle);
        if (member === undefined) return refused(t('slash.invite.nobody', { handle }));
        try {
          await api.addChannelMember(channelId, member.user.id);
          void client.invalidateQueries({ queryKey: keys.channelMembers(channelId) });
          return { kind: 'done', said: t('slash.invite.added', { name: member.user.displayName }) };
        } catch (failure) {
          return failed(failure);
        }
      }
      case 'leave':
        if (channel === undefined || channel.state === null) return refused(t('slash.notMember'));
        try {
          await actions.leaveChannel(channel);
          forgetChannel(workspace.id, channel.id);
          navigate(href('workspace', { slug: workspace.slug }));
          return { kind: 'done', said: t('details.left', { name: channel.name ?? '' }) };
        } catch (failure) {
          return failed(failure);
        }
      case 'deepwork': {
        const choice = deepWorkOf(args);
        if (choice === null || deepWork === null) return refused(t('slash.deepwork.usage'));
        if (choice === 'off') deepWork.end();
        else deepWork.start(choice);
        return {
          kind: 'done',
          said: t(choice === 'off' ? 'slash.deepwork.ended' : 'slash.deepwork.started'),
        };
      }
      case 'search':
        if (args === '') return refused(t('slash.search.usage'));
        navigate(`${href('search', { slug: workspace.slug })}?q=${encodeURIComponent(args)}`);
        return { kind: 'done', said: '' };
    }
  };
};
