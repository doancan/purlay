/**
 * The header's ways to the panels beside the conversation (D-129, D-130).
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
import { FILES_PANEL_ID } from './files-panel';
import { useSidePanel } from './side-panel';

export const PanelControls = ({ direct }: { readonly direct: boolean }): React.JSX.Element => {
  const { t } = useI18n();
  const side = useSidePanel();
  const filesOpen = side.panel === 'files';
  const pinsOpen = side.panel === 'pins';
  const filesLabel = t(direct ? 'files.openConversation' : 'files.open');
  // A panel chosen from the menu opens once the menu has closed, and takes focus itself: opened
  // while the menu still held focus, the menu took it back, then handed it to its trigger — which
  // the panel covers on a narrow window — and Esc reached nothing.
  const chosen = useRef<'files' | 'pins' | null>(null);
  const choose = (panel: 'files' | 'pins'): void => {
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
            <IconButton label={t('panels.menu')} glyph="more" data-panel-toggle="files pins" />
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
        </Menu>
      </div>
    </>
  );
};
