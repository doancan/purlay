/**
 * Scheduling what is in a message box ("Send later"): one request, its answer said in words.
 *
 * A schedule is a `PUT` under an id the client chooses, so asking again is the same draft and never a
 * second one. The id is kept while the same words, files and time are asked again after a failure that
 * did not say whether it landed (a dropped connection), and a new one is chosen for anything else.
 *
 * It returns what to say under the box when it failed — the words and files stay — and `null` when it
 * went through, after telling the person when and where to see it.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useRef } from 'react';
import { messageId, SCHEDULED_MESSAGES_MAX } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { codeOf, useDescribeFailure } from '../../../data/failure';
import { isApiError } from '../../../data/errors';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { RealtimePortsContext } from '../../../realtime/realtime-provider';
import { useRoute } from '../../../router/router-provider';
import { scheduledHref } from '../../../router/routes';
import { systemClock } from '../../../system-clock';
import { useToast } from '../../../ui/toast';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';
import { describeWhen } from './presets';

export interface ScheduleInput {
  readonly channelId: string;
  readonly parentId?: string;
  readonly content: string;
  readonly attachmentIds: readonly string[];
  readonly sendAt: Date;
}

export const useScheduleMessage = (): ((input: ScheduleInput) => Promise<string | null>) => {
  const api = useApi();
  const client = useQueryClient();
  const { t, format } = useI18n();
  const { show } = useToast();
  const { navigate } = useRoute();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const describe = useDescribeFailure();
  const clock = useContext(RealtimePortsContext).clock ?? systemClock;
  const attempt = useRef<{ readonly asked: string; readonly id: string } | null>(null);
  const inFlight = useRef(false);

  const reasonOf = (failure: unknown): string => {
    const code = codeOf(failure);
    if (code === 'NETWORK' || code === 'TIMEOUT') return t('scheduled.error.network');
    if (code === 'SCHEDULED_MESSAGE_LIMIT')
      return t('scheduled.error.limit', { count: SCHEDULED_MESSAGES_MAX });
    if (isApiError(failure) && code === 'VALIDATION_FAILED' && 'sendAt' in failure.fields)
      return t('scheduled.time.refused');
    return describe(failure);
  };

  return async (input) => {
    // A second press while the first is on its way is the same wish.
    if (inFlight.current) return null;
    const sendAt = input.sendAt.toISOString();
    const body = {
      content: input.content,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.attachmentIds.length === 0 ? {} : { attachmentIds: [...input.attachmentIds] }),
      sendAt,
    };
    const asked = JSON.stringify([input.channelId, body]);
    const id = attempt.current?.asked === asked ? attempt.current.id : messageId(clock.now());
    attempt.current = { asked, id };
    inFlight.current = true;
    try {
      await api.scheduleMessage(input.channelId, id, body);
    } catch (failure) {
      return t('scheduled.error', { reason: reasonOf(failure) });
    } finally {
      inFlight.current = false;
    }
    attempt.current = null;
    void client.invalidateQueries({ queryKey: keys.scheduled(workspace.id, user.id) });
    show({
      message: t('scheduled.done', {
        when: describeWhen(input.sendAt, clock.now(), format, t),
      }),
      actionLabel: t('scheduled.view'),
      onAction: () => {
        navigate(scheduledHref(workspace.slug));
      },
    });
    return null;
  };
};
