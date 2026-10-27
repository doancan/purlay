/**
 * Sidebar options (D-195): what the person leaves out of their own sidebar, and in what order the channels
 * come — one menu at the head of the column, beside the workspace's name, where Slack and Linear keep it, instead
 * of a settings page for a thing that is changed in passing.
 *
 * Every choice is about **what is shown**, not how tightly (D-118 §6): everything or only what is unread;
 * channels by name, which keeps a place where it was (D-160), or by what was written in them last; the
 * conversations and the people, each of which can be switched off; muted channels left out. Each says what is
 * chosen with a check, and the switches leave the menu open. **Reset sidebar** puts all of it back and is
 * offered only while something is changed. Nothing here touches anybody else's sidebar, or the channels
 * themselves: a channel left out of view is still joined, still counted for its mentions and still found by
 * the palette.
 *
 * The button says when anything is changed — filled, and *changed* in its name — in the button and not only in the
 * menu behind it: a sidebar that shows less than the workspace has must not look the same as one that shows all.
 */
import { useI18n } from '../../i18n/i18n-provider';
import { IconButton } from '../../ui/icon-button';
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from '../../ui/menu';
import { isDefault, withToggled, type ChannelOrder } from './preferences';
import { useSidebarPreferences } from './preferences-context';

export const SidebarOptions = (): React.JSX.Element => {
  const { t } = useI18n();
  const { preferences, change, reset } = useSidebarPreferences();
  const changed = !isDefault(preferences);
  return (
    <Menu
      align="end"
      trigger={
        <IconButton
          label={
            changed
              ? `${t('sidebar.options')}, ${t('sidebar.options.changed')}`
              : t('sidebar.options')
          }
          glyph="preferences"
          size="nav"
          {...(changed ? { className: 'bg-nav-hover text-nav-ink' } : {})}
        />
      }
    >
      <MenuLabel>{t('sidebar.options.show')}</MenuLabel>
      <MenuRadioGroup
        value={preferences.unreadOnly ? 'unread' : 'all'}
        onValueChange={(value) => {
          change({ unreadOnly: value === 'unread' });
        }}
      >
        <MenuRadioItem value="all">{t('sidebar.options.showAll')}</MenuRadioItem>
        <MenuRadioItem value="unread">{t('sidebar.options.showUnread')}</MenuRadioItem>
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuLabel>{t('sidebar.options.sort')}</MenuLabel>
      <MenuRadioGroup
        value={preferences.channelOrder}
        onValueChange={(value) => {
          const channelOrder: ChannelOrder = value === 'activity' ? 'activity' : 'name';
          change({ channelOrder });
        }}
      >
        <MenuRadioItem value="name">{t('sidebar.options.sortName')}</MenuRadioItem>
        <MenuRadioItem value="activity">{t('sidebar.options.sortActivity')}</MenuRadioItem>
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuLabel>{t('sidebar.options.sections')}</MenuLabel>
      <MenuCheckboxItem
        checked={!preferences.hidden.includes('conversations')}
        onCheckedChange={() => {
          change({ hidden: withToggled(preferences.hidden, 'conversations') });
        }}
      >
        {t('conversations.title')}
      </MenuCheckboxItem>
      <MenuCheckboxItem
        checked={!preferences.hidden.includes('people')}
        onCheckedChange={() => {
          change({ hidden: withToggled(preferences.hidden, 'people') });
        }}
      >
        {t('sidebar.people')}
      </MenuCheckboxItem>
      <MenuSeparator />
      <MenuCheckboxItem
        checked={preferences.hideMuted}
        onCheckedChange={(checked) => {
          change({ hideMuted: checked });
        }}
      >
        {t('sidebar.options.hideMuted')}
      </MenuCheckboxItem>
      <MenuSeparator />
      <MenuItem disabled={!changed} onSelect={reset}>
        {t('sidebar.options.reset')}
      </MenuItem>
    </Menu>
  );
};
