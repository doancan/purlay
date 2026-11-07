/** What __ID__ puts in a person's export of their own data (D-241): nothing, as its rows name nobody. */
import type { RawBuilder } from '@purlay/db';
import type { PersonalContribution } from '../../modules/export/personal-catalogue';

export const __CAMEL__PersonalExport = {
  id: '__ID__',
  tables: [],
  ownSet: ['__SNAKE__'],
  workspaces: (): RawBuilder<unknown>[] => [],
  excluded: { __SNAKE__: 'the rows name nobody; add the table when a row becomes a person’s own' },
} satisfies PersonalContribution;
