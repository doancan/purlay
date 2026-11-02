/**
 * What can be typed in the search field (D-224): a disclosure under it, closed until asked for — a
 * native `<details>`, so the keyboard and a screen reader open it as they open Advanced filters. The
 * operators are written as typed, in the machine font; what each does is in the reader's language.
 */
import { useI18n } from '../../i18n/i18n-provider';

const ROWS = [
  { typed: ['in:#channel', 'in:@name'], says: 'search.operators.in' },
  { typed: ['from:@name', 'from:me'], says: 'search.operators.from' },
  { typed: ['has:code', 'has:file'], says: 'search.operators.has' },
  { typed: ['is:open', 'is:resolved', 'is:question'], says: 'search.operators.is' },
  { typed: ['repo:owner/name'], says: 'search.operators.repo' },
  { typed: ['on:2026-10-31', 'before:…', 'after:…'], says: 'search.operators.dates' },
  { typed: ['"exact words"'], says: 'search.operators.quote' },
] as const;

export const OperatorHelp = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <details className="text-label text-ink">
      <summary className="w-fit cursor-pointer rounded-sm py-1 text-ink-muted hover:text-ink">
        {t('search.operators.title')}
      </summary>
      <p className="mt-2 text-caption text-ink-muted">{t('search.operators.intro')}</p>
      <dl className="mt-2 flex flex-col gap-2">
        {ROWS.map((row) => (
          <div key={row.says} className="flex flex-wrap items-baseline gap-x-3">
            <dt className="flex flex-wrap gap-x-2 font-mono text-caption text-ink">
              {row.typed.map((typed) => (
                <code key={typed}>{typed}</code>
              ))}
            </dt>
            <dd className="text-caption text-ink-muted">{t(row.says)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
};
