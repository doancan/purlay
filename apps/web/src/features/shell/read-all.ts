/**
 * "Mark all channels read" (D-238), one command behind three doors: `Shift+Esc` (`global-keys.tsx`),
 * the palette and the workspace menu. The badges clear at once (`actions.markAllRead`); a toast says it
 * was done — a key pressed with nothing else on screen changing would otherwise say nothing to a
 * screen reader — or, refused, why, with the badges put back.
 */
import { useCallback } from 'react';
import { useActions } from '../../data/actions-provider';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { useToast } from '../../ui/toast';
import { useWorkspace } from './workspace';

export const useMarkAllRead = (): (() => void) => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { markAllRead } = useActions();
  const { show } = useToast();
  const describe = useDescribeFailure();
  return useCallback(() => {
    markAllRead(workspace.id).then(
      () => {
        show({ message: t('readAll.done') });
      },
      (failure: unknown) => {
        show({ message: `${t('readAll.failed')} ${describe(failure)}` });
      },
    );
  }, [describe, markAllRead, show, t, workspace.id]);
};
