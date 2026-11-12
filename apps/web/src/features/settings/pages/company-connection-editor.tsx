/** The edit is tied to its observed revision; secrets remain in this mounted form only. */
import { useEffect, useId, useRef, useState } from 'react';
import {
  OIDC_NAME_MAX,
  OIDC_ISSUER_MAX,
  OIDC_CLIENT_ID_MAX,
  OIDC_CLIENT_SECRET_MAX,
} from '@purlay/types';
import {
  type CompanyIdentityConnection,
  type CompanyIdentityDomain,
  type CreateCompanyConnectionRequest,
  type UpdateCompanyConnectionRequest,
} from '@purlay/types/workspace-identity';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { Select } from '../../../ui/select';
import { SettingsCard } from '../page';

export const CompanyConnectionEditor = ({
  initial,
  current,
  domains,
  busy,
  problem,
  save,
  cancel,
  reload,
}: {
  readonly initial: CompanyIdentityConnection | null;
  readonly current: CompanyIdentityConnection | undefined;
  readonly domains: readonly CompanyIdentityDomain[];
  readonly busy: boolean;
  readonly problem: string | null;
  readonly save: (
    input: CreateCompanyConnectionRequest | UpdateCompanyConnectionRequest,
  ) => Promise<boolean>;
  readonly cancel: () => void;
  readonly reload: (connection: CompanyIdentityConnection) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const domainControl = useId();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const verified = domains.filter((domain) => domain.state === 'verified');
  const [name, setName] = useState(initial?.name ?? '');
  const [issuer, setIssuer] = useState(initial?.issuer ?? '');
  const [domainId, setDomainId] = useState(initial?.domainId ?? verified[0]?.id ?? '');
  const [clientId, setClientId] = useState(initial?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const stale = initial !== null && current?.revision !== initial.revision;
  const validDomain = verified.some((domain) => domain.id === domainId);
  const changed =
    name.trim() !== initial?.name ||
    issuer.trim() !== initial.issuer ||
    domainId !== initial.domainId ||
    clientId.trim() !== initial.clientId ||
    secret !== '';
  const valid =
    name.trim() !== '' &&
    issuer.trim() !== '' &&
    clientId.trim() !== '' &&
    validDomain &&
    (initial !== null || secret !== '');
  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!valid || !changed || stale || busy) return;
    const fields = {
      name: name.trim(),
      issuer: issuer.trim(),
      domainId,
      clientId: clientId.trim(),
    };
    const input =
      initial === null
        ? { ...fields, clientSecret: secret }
        : {
            ...fields,
            revision: initial.revision,
            ...(secret === '' ? {} : { clientSecret: secret }),
          };
    if (await save(input)) setSecret('');
  };
  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <SettingsCard
        title={t(initial === null ? 'company.connection.add' : 'company.connection.edit')}
        description={t('company.connection.secretChange')}
        footer={
          <div className="flex w-full flex-col gap-3">
            {problem !== null && (
              <p role="alert" className="text-label text-danger-text">
                {problem}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button type="button" disabled={busy} onClick={cancel}>
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                busy={busy}
                disabled={busy || stale || !valid || !changed}
              >
                {t('company.save')}
              </Button>
            </div>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-4 px-6 py-5 max-narrow:px-4">
          {stale && (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-label text-danger-text">
                {t('company.connection.changed')}
              </p>
              {current !== undefined && (
                <Button
                  type="button"
                  onClick={() => {
                    reload(current);
                  }}
                >
                  {t('company.connection.reload')}
                </Button>
              )}
            </div>
          )}
          <TextField
            ref={first}
            label={t('company.connection.name')}
            value={name}
            required
            maxLength={OIDC_NAME_MAX}
            disabled={busy}
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={domainControl} className="text-label text-ink">
              {t('company.connection.verifiedDomain')}
            </label>
            <Select
              id={domainControl}
              value={validDomain ? domainId : ''}
              disabled={busy}
              required
              onChange={(event) => {
                setDomainId(event.currentTarget.value);
              }}
            >
              <option value="">{t('company.connection.chooseDomain')}</option>
              {verified.map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.domain}
                </option>
              ))}
            </Select>
          </div>
          <TextField
            label={t('company.connection.issuer')}
            hint={t('company.connection.issuerHint')}
            type="url"
            pattern="https://.*"
            value={issuer}
            required
            maxLength={OIDC_ISSUER_MAX}
            disabled={busy}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => {
              setIssuer(event.currentTarget.value);
            }}
          />
          <TextField
            label={t('company.connection.clientId')}
            value={clientId}
            required
            maxLength={OIDC_CLIENT_ID_MAX}
            disabled={busy}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => {
              setClientId(event.currentTarget.value);
            }}
          />
          <TextField
            label={t('company.connection.secret')}
            hint={t('company.connection.secretHint')}
            type="password"
            autoComplete="new-password"
            value={secret}
            required={initial === null}
            maxLength={OIDC_CLIENT_SECRET_MAX}
            disabled={busy}
            onChange={(event) => {
              setSecret(event.currentTarget.value);
            }}
          />
        </div>
      </SettingsCard>
    </form>
  );
};
