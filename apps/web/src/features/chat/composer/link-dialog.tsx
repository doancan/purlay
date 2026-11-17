/** Link details stay local to this composer; cancelling never changes the draft. */
import { useRef, useState } from 'react';
import { SafeHref } from '@purlay/markdown';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { TextField } from '../../../ui/text-field';

export const LinkDialog = ({
  selection,
  onInsert,
  onClose,
  returnFocus,
  existing,
  onRemove,
}: {
  readonly selection: string;
  readonly onInsert: (label: string, address: string) => void;
  readonly onClose: () => void;
  readonly returnFocus: () => HTMLElement | null;
  readonly existing: { readonly label: string; readonly address: string } | null;
  readonly onRemove: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const selectedAddress = SafeHref.of(selection.trim());
  const [label, setLabel] = useState(
    existing?.label ?? (selectedAddress === null ? selection : ''),
  );
  const [address, setAddress] = useState(existing?.address ?? selectedAddress?.href ?? '');
  const [invalid, setInvalid] = useState(false);
  const addressField = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(existing === null ? 'composer.link.title' : 'composer.link.editTitle')}
      description={t('composer.link.description')}
      closeLabel={t('common.close')}
      returnFocus={returnFocus}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (SafeHref.of(address.trim()) === null) {
            setInvalid(true);
            addressField.current?.focus();
            return;
          }
          onInsert(label, address);
        }}
      >
        <TextField
          ref={addressField}
          label={t('composer.link.address')}
          placeholder="https://"
          type="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setInvalid(false);
          }}
          {...(invalid ? { error: t('composer.link.invalid') } : {})}
        />
        <TextField
          label={t('composer.link.text')}
          hint={t('composer.link.textHint')}
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
        <div className="flex flex-wrap justify-end gap-2">
          {existing !== null && (
            <Button type="button" variant="ghost" className="mr-auto" onClick={onRemove}>
              {t('composer.link.remove')}
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary">
            {t(existing === null ? 'composer.link.insert' : 'composer.link.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
