/**
 * Everything the palette can do, built from what the client already holds.
 *
 * No request is made to *build* the list: channels and members are the sidebar's own
 * cache, so the palette opens instantly and offline. A request is made only by what
 * an item does — opening a direct message that does not exist yet — and that is
 * the one item that waits (`run` returns a promise).
 */
import { useMemo } from 'react';
import { useActions } from '../../data/actions-provider';
import { useChannels, useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { useTheme } from '../../theme/theme-provider';
import { THEME_CHOICES } from '../../theme/theme';
import { LOCALES } from '../../i18n/types';
import { useSession } from '../session/session';
import { useWorkspaceRole } from '../settings/role';
import { sectionsFor } from '../settings/sections';
import { DEEP_WORK_CHOICES, useDeepWorkControls } from '../shell/deep-work';
import { useWorkspace } from '../shell/workspace';
import { displayName, inSidebarOrder } from './channels';
import type { PaletteItem } from './rank';

export const usePaletteItems = (): readonly PaletteItem[] => {
  const { t, setLocale } = useI18n();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const { match, navigate } = useRoute();
  const { setChoice } = useTheme();
  const { openDirectMessage } = useActions();
  const deepWork = useDeepWorkControls();
  const channels = useChannels(workspace.id).data;
  const members = useMembers(workspace.id).data;
  const role = useWorkspaceRole();

  const currentChannelId = match.name === 'channel' ? match.params.channelId : null;
  const slug = workspace.slug;

  return useMemo(() => {
    const items: PaletteItem[] = [];
    const ordered = inSidebarOrder(channels ?? []);
    const current = ordered.find((c) => c.id === currentChannelId);

    items.push({
      id: 'view:questions',
      group: 'views',
      label: t('questions.title'),
      glyph: 'open-question',
      recency: '',
      run: () => {
        navigate(href('questions', { slug }));
      },
    });
    // The rail's places, by name (`PRD.md` §4.6): the palette is the product's search over where to go.
    for (const view of [
      { id: 'inbox', label: t('inbox.title'), glyph: 'inbox', to: href('inbox', { slug }) },
      { id: 'saved', label: t('saved.title'), glyph: 'saved', to: href('saved', { slug }) },
      { id: 'search', label: t('search.title'), glyph: 'search', to: href('search', { slug }) },
    ] as const) {
      items.push({
        id: `view:${view.id}`,
        group: 'views',
        label: view.label,
        glyph: view.glyph,
        recency: '',
        run: () => {
          navigate(view.to);
        },
      });
    }
    if (current !== undefined) {
      items.push({
        id: 'view:feed',
        group: 'views',
        label: t('palette.view.feed'),
        hint: displayName(current, user.id, t('sidebar.you'), t('user.erased')),
        glyph: 'channel',
        recency: '',
        run: () => {
          navigate(href('channel', { slug, channelId: current.id }));
        },
      });
    }

    for (const channel of ordered) {
      // A group conversation is found by its people (D-127); one with a single other person is the
      // People group's.
      if (channel.type === 'direct_message') {
        if (channel.peer !== null) continue;
        items.push({
          id: `group:${channel.id}`,
          group: 'channels',
          label: displayName(channel, user.id, t('sidebar.you'), t('user.erased')),
          keywords: channel.peers.map((person) => person.username),
          glyph: 'people',
          faces: channel.peers,
          recency: channel.lastMessageAt ?? '',
          run: () => {
            navigate(href('channel', { slug, channelId: channel.id }));
          },
        });
        continue;
      }
      items.push({
        id: `channel:${channel.id}`,
        group: 'channels',
        label: channel.name ?? '',
        glyph: channel.type === 'private' ? 'private-channel' : 'channel',
        recency: channel.lastMessageAt ?? '',
        run: () => {
          navigate(href('channel', { slug, channelId: channel.id }));
        },
      });
    }

    // Public channels the person has not joined: found too, and said so — opening one reads it,
    // with the Join bar its feed already offers.
    for (const channel of channels ?? []) {
      if (channel.type !== 'public' || channel.state !== null) continue;
      items.push({
        id: `channel:${channel.id}`,
        group: 'channels',
        label: channel.name ?? '',
        hint: t('palette.notJoined'),
        glyph: 'channel',
        recency: '',
        run: () => {
          navigate(href('channel', { slug, channelId: channel.id }));
        },
      });
    }

    for (const { user: person } of members ?? []) {
      const existing = ordered.find((c) => c.type === 'direct_message' && c.peer?.id === person.id);
      const you = person.id === user.id;
      items.push({
        id: `person:${person.id}`,
        group: 'people',
        label: you ? t('sidebar.you') : person.displayName,
        keywords: you ? [person.username, person.displayName] : [person.username],
        hint: `@${person.username}`,
        glyph: 'person',
        avatar: { name: person.displayName, username: person.username },
        recency: existing?.lastMessageAt ?? '',
        run: async () => {
          const channel = existing ?? (await openDirectMessage(workspace.id, person.id));
          navigate(href('channel', { slug, channelId: channel.id }));
        },
      });
    }

    // Every settings page this person may open, by its name (D-146, `PRD.md` §4.6).
    for (const section of sectionsFor(role)) {
      items.push({
        id: `settings:${section.id}`,
        group: 'settings',
        label: t(`settings.${section.id}.nav`),
        keywords: [t('settings.label')],
        glyph: section.glyph,
        recency: '',
        run: () => {
          navigate(href('settings', { slug, section: section.id }));
        },
      });
    }

    // Deep Work as the account menu offers it (D-124): the whiles to start it for, or its end.
    if (deepWork !== null && deepWork.until === null) {
      for (const choice of DEEP_WORK_CHOICES) {
        items.push({
          id: `deep-work:${choice}`,
          group: 'settings',
          label: `${t('deepWork.label')}: ${t(`deepWork.choice.${choice}`)}`,
          glyph: 'deep-work',
          recency: '',
          run: () => {
            deepWork.start(choice);
          },
        });
      }
    } else if (deepWork !== null) {
      items.push({
        id: 'deep-work:end',
        group: 'settings',
        label: t('deepWork.stop'),
        glyph: 'deep-work',
        recency: '',
        run: deepWork.end,
      });
    }
    for (const choice of THEME_CHOICES) {
      items.push({
        id: `theme:${choice}`,
        group: 'settings',
        label: `${t('theme.label')}: ${t(`theme.${choice}`)}`,
        glyph: choice,
        recency: '',
        run: () => {
          setChoice(choice);
        },
      });
    }
    for (const locale of LOCALES) {
      items.push({
        id: `language:${locale}`,
        group: 'settings',
        label: `${t('language.label')}: ${t(`language.${locale}`)}`,
        glyph: 'language',
        recency: '',
        run: () => {
          setLocale(locale);
        },
      });
    }
    return items;
  }, [
    channels,
    members,
    currentChannelId,
    slug,
    workspace.id,
    user.id,
    t,
    navigate,
    setChoice,
    setLocale,
    openDirectMessage,
    deepWork,
    role,
  ]);
};
