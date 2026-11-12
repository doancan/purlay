/** DNS proof stays separate from provider credentials and account admission. */
import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  COMPANY_DOMAINS_MAX,
  COMPANY_DOMAIN_MAX,
  type CompanyIdentityDomain,
  type CompanyIdentityDomainPage,
} from '@purlay/types/workspace-identity';
import { useApi } from '../../../data/api-provider';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { SettingsCard } from '../page';
import { CompanyCopyValue, CompanyLoading, type CompanyTask } from './company-parts';

export const CompanyDomains = ({
  workspaceId,
  query,
  busy,
  run,
  remove,
}: {
  readonly workspaceId: string;
  readonly query: UseQueryResult<CompanyIdentityDomainPage>;
  readonly busy: string | null;
  readonly run: CompanyTask;
  readonly remove: (domain: CompanyIdentityDomain) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const [domain, setDomain] = useState('');
  const disabled = busy !== null;
  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (
      await run(
        'domain:add',
        async () => await api.createCompanyDomain(workspaceId, { domain: domain.trim() }),
      )
    )
      setDomain('');
  };
  return (
    <SettingsCard title={t('company.domains.title')} description={t('company.domains.description')}>
      {query.isError || query.data === undefined ? (
        <CompanyLoading
          failed={query.isError}
          retry={() => {
            void query.refetch();
          }}
        />
      ) : (
        <>
          {query.data.data.length === 0 && (
            <p className="px-6 pt-5 text-body text-ink-muted max-narrow:px-4">
              {t('company.domains.empty')}
            </p>
          )}
          <form
            className="flex items-end gap-3 px-6 py-5 max-narrow:flex-col max-narrow:items-stretch max-narrow:px-4"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <div className="min-w-0 flex-1">
              <TextField
                label={t('company.domain')}
                value={domain}
                required
                maxLength={COMPANY_DOMAIN_MAX}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled || query.data.data.length >= COMPANY_DOMAINS_MAX}
                onChange={(event) => {
                  setDomain(event.currentTarget.value);
                }}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              busy={busy === 'domain:add'}
              disabled={
                disabled || domain.trim() === '' || query.data.data.length >= COMPANY_DOMAINS_MAX
              }
            >
              {t('company.domain.add')}
            </Button>
          </form>
          <ul className="flex flex-col">
            {query.data.data.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-4 border-t-hairline border-border-subtle px-6 py-5 max-narrow:px-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-label text-ink">{entry.domain}</h3>
                    <p className="text-caption text-ink-muted">
                      {t(`company.domain.${entry.state}`)}
                    </p>
                  </div>
                  <Button
                    variant="dangerQuiet"
                    disabled={disabled}
                    onClick={() => {
                      remove(entry);
                    }}
                  >
                    {t('company.domain.remove')}
                  </Button>
                </div>
                {entry.dnsRecord !== null && (
                  <div className="flex flex-col gap-3">
                    <CompanyCopyValue
                      label={t('company.domain.recordName')}
                      value={entry.dnsRecord.name}
                    />
                    <CompanyCopyValue
                      label={t('company.domain.recordValue')}
                      value={entry.dnsRecord.value}
                    />
                    <p className="text-caption text-ink-muted">
                      {t('company.domain.expires', {
                        when: format.absolute(entry.challengeExpiresAt),
                      })}
                    </p>
                  </div>
                )}
                {entry.state !== 'verified' && (
                  <div className="flex flex-wrap gap-3">
                    <Button
                      variant="primary"
                      disabled={disabled || entry.state === 'expired'}
                      busy={busy === `domain:verify:${entry.id}`}
                      onClick={() => {
                        void run(
                          `domain:verify:${entry.id}`,
                          async () =>
                            await api.verifyCompanyDomain(workspaceId, entry.id, entry.revision),
                        );
                      }}
                    >
                      {t('company.domain.verify')}
                    </Button>
                    <Button
                      disabled={disabled}
                      onClick={() => {
                        void run(
                          `domain:renew:${entry.id}`,
                          async () =>
                            await api.renewCompanyDomain(workspaceId, entry.id, entry.revision),
                        );
                      }}
                    >
                      {t('company.domain.renew')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </SettingsCard>
  );
};
