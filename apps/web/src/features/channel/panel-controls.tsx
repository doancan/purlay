/**
 * The header's ways to the panels beside the conversation (D-129, D-130), and on a narrow window
 * the channel's star with them (D-132).
 *
 * On a wide window each is its own button, pressed while its panel is open. On a narrow one a
 * phone's width cannot give a button to each and keep the channel's name readable, so they are one
 * menu instead (`UX.md` §2). Either way the control carries `data-panel-toggle`, and closing a panel
 * puts focus back on whichever is on screen.
 */
import { useRef } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuItem } from '../../ui/menu';
import { PINS_PANEL_ID } from '../pins/pins-panel';
import { INCIDENT_PANEL_ID } from '../incidents/incident-panel';
import { FILES_PANEL_ID } from './files-panel';
import { useSidePanel } from './side-panel';
import { useStar } from './star-toggle';
import type { Channel } from '@purlay/types';

export const PanelControls = ({
  direct,
  channel,
}: {
  readonly direct: boolean;
  readonly channel: Channel;
}): React.JSX.Element => {
  const { t } = useI18n();
  const side = useSidePanel();
  // A star is a channel's, never a conversation's (D-132).
  const star = useStar(channel);
  const setStar = direct ? null : star;
  const filesOpen = side.panel === 'files';
  const pinsOpen = side.panel === 'pins';
  const incidentOpen = side.panel === 'incident';
  const filesLabel = t(direct ? 'files.openConversation' : 'files.open');
  // A panel chosen from the menu opens once the menu has closed, and takes focus itself: opened
  // while the menu still held focus, the menu took it back, then handed it to its trigger — which
  // the panel covers on a narrow window — and Esc reached nothing.
  const chosen = useRef<'files' | 'pins' | 'incident' | null>(null);
  const choose = (panel: 'files' | 'pins' | 'incident'): void => {
    chosen.current = panel;
  };
  return (
    <>
      <IconButton
        label={filesLabel}
        glyph="file"
        data-panel-toggle="files"
        className="max-narrow:hidden"
        aria-pressed={filesOpen}
        aria-controls={filesOpen ? FILES_PANEL_ID : undefined}
        onClick={() => {
          if (filesOpen) side.close();
          else side.open('files');
        }}
      />
      <IconButton
        label={t('pins.open')}
        glyph="pin"
        data-panel-toggle="pins"
        className="max-narrow:hidden"
        aria-pressed={pinsOpen}
        aria-controls={pinsOpen ? PINS_PANEL_ID : undefined}
        onClick={() => {
          if (pinsOpen) side.close();
          else side.open('pins');
        }}
      />
      {/* A conversation has no incident (D-137 §1). */}
      {!direct && (
        <IconButton
          label={t('incident.open')}
          glyph="warning"
          data-panel-toggle="incident"
          className="max-narrow:hidden"
          aria-pressed={incidentOpen}
          aria-controls={incidentOpen ? INCIDENT_PANEL_ID : undefined}
          onClick={() => {
            if (incidentOpen) side.close();
            else side.open('incident');
          }}
        />
      )}
      <div className="hidden max-narrow:flex">
        <Menu
          align="end"
          returnFocus={() => {
            const panel = chosen.current;
            chosen.current = null;
            if (panel === null) return true;
            side.open(panel);
            return false;
          }}
          trigger={
            <IconButton
              label={t('panels.menu')}
              glyph="more"
              data-panel-toggle={direct ? 'files pins' : 'files pins incident'}
            />
          }
        >
          <MenuItem
            glyph="file"
            onSelect={() => {
              choose('files');
            }}
          >
            {filesLabel}
          </MenuItem>
          <MenuItem
            glyph="pin"
            onSelect={() => {
              choose('pins');
            }}
          >
            {t('pins.open')}
          </MenuItem>
          {!direct && (
            <MenuItem
              glyph="warning"
              onSelect={() => {
                choose('incident');
              }}
            >
              {t('incident.open')}
            </MenuItem>
          )}
          {setStar !== null && (
            <MenuItem
              glyph="star"
              onSelect={() => {
                setStar(!channel.starred);
              }}
            >
              {t(channel.starred ? 'star.unstar' : 'star.label')}
            </MenuItem>
          )}
        </Menu>
      </div>
    </>
  );
};
