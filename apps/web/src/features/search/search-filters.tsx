/**
 * Advanced filters (D-204): status, content, questions, a repository and a range of days. A day is the
 * viewer's — its start in their time zone, sent as a UTC instant — as the `on:`, `before:` and `after:`
 * operators read it (D-224), so a typed day and a picked one are the same day.
 */
import { Value } from '@sinclair/typebox/value';
import { useState } from 'react';
import { SearchFilters } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Select } from '../../ui/select';
import { Button } from '../../ui/button';
import { DateField } from '../../ui/date-field';
import { TextField } from '../../ui/text-field';

export const AdvancedFilters = ({
  value,
  onChange,
}: {
  readonly value: SearchFilters;
  readonly onChange: (value: SearchFilters) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const [repositoryError, setRepositoryError] = useState(false);
  const change = <K extends keyof SearchFilters>(key: K, next: SearchFilters[K]): void => {
    const updated: unknown = Object.fromEntries([
      ...Object.entries(value).filter(([name]) => name !== key),
      ...(next === undefined ? [] : [[key, next]]),
    ]);
    if (Value.Check(SearchFilters, updated)) onChange(updated);
  };
  return (
    <details open={Object.keys(value).length > 0 || undefined} className="text-label text-ink">
      <summary className="w-fit cursor-pointer rounded-sm py-1 text-accent-text">
        {t('search.filters')}
      </summary>
      <div className="mt-3 grid grid-cols-2 gap-3 max-narrow:grid-cols-1">
        <label className="flex flex-col gap-1">
          {t('search.status')}
          <Select
            value={value.status ?? ''}
            onChange={(event) => {
              change(
                'status',
                event.target.value === 'resolved'
                  ? 'resolved'
                  : event.target.value === 'open'
                    ? 'open'
                    : undefined,
              );
            }}
          >
            <option value="">{t('search.anyStatus')}</option>
            <option value="resolved">{t('search.resolved')}</option>
            <option value="open">{t('search.open')}</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          {t('search.kind')}
          <Select
            value={value.kind ?? ''}
            onChange={(event) => {
              change(
                'kind',
                event.target.value === 'code'
                  ? 'code'
                  : event.target.value === 'file'
                    ? 'file'
                    : undefined,
              );
            }}
          >
            <option value="">{t('search.anyKind')}</option>
            <option value="code">{t('search.code')}</option>
            <option value="file">{t('search.files')}</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          {t('search.questions')}
          <Select
            value={value.question ?? ''}
            onChange={(event) => {
              change('question', event.target.value === 'yes' ? 'yes' : undefined);
            }}
          >
            <option value="">{t('search.allMessages')}</option>
            <option value="yes">{t('search.onlyQuestions')}</option>
          </Select>
        </label>
        <TextField
          label={t('search.repository')}
          placeholder="owner/repo"
          {...(repositoryError ? { error: t('search.repositoryError') } : {})}
          defaultValue={value.repository ?? ''}
          onBlur={(event) => {
            const next = event.target.value.trim();
            const valid = next === '' || Value.Check(SearchFilters, { repository: next });
            setRepositoryError(!valid);
            if (valid && next !== (value.repository ?? '')) change('repository', next || undefined);
          }}
        />
        <DateField
          label={t('search.since')}
          value={value.since === undefined ? '' : format.isoDay(value.since)}
          onChange={(day) => {
            change('since', day === '' ? undefined : format.dayStart(day));
          }}
        />
        <DateField
          label={t('search.until')}
          value={value.until === undefined ? '' : format.isoDay(value.until)}
          hint={t('search.dateHint')}
          onChange={(day) => {
            change('until', day === '' ? undefined : format.dayStart(day));
          }}
        />
      </div>
      <Button
        variant="ghost"
        onClick={() => {
          onChange({});
        }}
      >
        {t('search.clear')}
      </Button>
    </details>
  );
};
