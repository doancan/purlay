import { useState } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Select } from '../../ui/select';
import { TextField } from '../../ui/text-field';
import { MailServerField } from '../setup/parts';

/** Form state, not a second wire contract: the existing SMTP request still carries one URL. */
interface RelayFields {
  readonly host: string;
  readonly port: string;
  readonly tls: boolean;
  readonly username: string;
  readonly password: string;
}
export const relayAddress = (fields: RelayFields): string | null => {
  const host = fields.host.trim();
  const port = Number(fields.port);
  if (
    host === '' ||
    /[\s/?#@\\]/.test(host) ||
    !/^\d{1,5}$/.test(fields.port) ||
    port < 1 ||
    port > 65535
  )
    return null;
  try {
    const address = new URL(`${fields.tls ? 'smtps' : 'smtp'}://${host}`);
    if (
      address.hostname === '' ||
      address.port !== '' ||
      address.username !== '' ||
      address.password !== ''
    )
      return null;
    address.port = String(port);
    address.username = fields.username;
    address.password = fields.password;
    return address.toString();
  } catch {
    return null;
  }
};
const split = (value: string): RelayFields => {
  try {
    const address = new URL(value);
    return {
      host: address.hostname,
      port: address.port || (address.protocol === 'smtps:' ? '465' : '587'),
      tls: address.protocol === 'smtps:',
      username: decodeURIComponent(address.username),
      password: decodeURIComponent(address.password),
    };
  } catch {
    return { host: '', port: '587', tls: false, username: '', password: '' };
  }
};

export const SmtpFields = ({
  value,
  onChange,
  readOnly,
  invalid,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly readOnly: boolean;
  readonly invalid: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [advanced, setAdvanced] = useState(false);
  const [fields, setFields] = useState(() => split(value));
  const change = (patch: Partial<RelayFields>): void => {
    const next = { ...fields, ...patch };
    setFields(next);
    onChange(relayAddress(next) ?? '');
  };
  return (
    <div className="flex flex-col gap-4">
      {advanced ? (
        <MailServerField value={value} onChange={onChange} readOnly={readOnly} invalid={invalid} />
      ) : (
        <>
          <TextField
            label={t('admin.smtp.host')}
            hint={t('admin.smtp.hostHint')}
            autoComplete="off"
            spellCheck={false}
            value={fields.host}
            readOnly={readOnly}
            invalid={invalid}
            onChange={(event) => {
              change({ host: event.target.value });
            }}
          />
          <TextField
            label={t('admin.smtp.port')}
            inputMode="numeric"
            value={fields.port}
            readOnly={readOnly}
            onChange={(event) => {
              change({ port: event.target.value });
            }}
          />
          <label className="flex flex-col gap-1 text-label text-ink">
            {t('admin.smtp.security')}
            <Select
              value={fields.tls ? 'tls' : 'starttls'}
              disabled={readOnly}
              onChange={(event) => {
                const tls = event.target.value === 'tls';
                change({ tls, port: tls ? '465' : '587' });
              }}
            >
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
            </Select>
          </label>
          <TextField
            label={t('admin.smtp.username')}
            hint={t('admin.smtp.optional')}
            autoComplete="off"
            value={fields.username}
            readOnly={readOnly}
            onChange={(event) => {
              change({ username: event.target.value });
            }}
          />
          <TextField
            label={t('admin.smtp.password')}
            type="password"
            autoComplete="new-password"
            value={fields.password}
            readOnly={readOnly}
            onChange={(event) => {
              change({ password: event.target.value });
            }}
          />
        </>
      )}
      <Button
        variant="ghost"
        disabled={readOnly}
        onClick={() => {
          if (advanced) setFields(split(value));
          setAdvanced((current) => !current);
        }}
      >
        {t(advanced ? 'admin.smtp.fields' : 'admin.smtp.url')}
      </Button>
    </div>
  );
};
