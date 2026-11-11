// Area web-features-shared: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const WEB_FEATURES_SHARED: readonly Mutation[] = [
  {
    id: 'shared-viewer-retains-removed-source',
    why: 'An open media snapshot keeps showing a withdrawn source.',
    file: 'apps/web/src/features/chat/shared/shared-screen.tsx',
    find: "        key={items\n          .map(\n            (item) => `${item.messageId}:${item.kind === 'file' ? item.attachment.id : item.key}`,\n          )\n          .join(',')}",
    replace: '',
    tests: ['apps/web/src/features/chat/shared/shared-screen.test.tsx'],
  },
];
