/**
 * Says, once, that unsent messages went with a channel the person lost (#521): archived, left on
 * another device, or a membership ended. Nothing could have sent them; kept, they would have waited
 * in storage with no screen to show them. A toast, because the person may be anywhere when it happens.
 */
import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { useLost } from '../../realtime/realtime-provider';
import { useToast } from '../../ui/toast';

export const LostSends = (): null => {
  const { t } = useI18n();
  const { show } = useToast();
  const lost = useLost();
  // By identity, not by number: each loss is a new object, and an engine made afresh under this
  // component starts its numbers again.
  const said = useRef(lost);
  useEffect(() => {
    if (lost === null || lost === said.current) return;
    said.current = lost;
    show({ message: t('delivery.lostWithChannel', { count: lost.count }) });
  }, [lost, show, t]);
  return null;
};
