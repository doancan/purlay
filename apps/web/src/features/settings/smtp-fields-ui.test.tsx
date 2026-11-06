import { describe, expect, test } from 'bun:test';
import { useState } from 'react';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { SmtpFields } from './smtp-fields';
installDom();
const Relay = ({ initial = '' }: { readonly initial?: string }): React.JSX.Element => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <SmtpFields value={value} onChange={setValue} invalid={false} readOnly={false} />
      <output aria-label="Address">{value}</output>
    </>
  );
};
describe('SMTP editing', () => {
  test('structured credentials encode punctuation and switching formats preserves edits', async () => {
    const view = await renderApp(<Relay />);
    await person().type(view.getByLabelText('Mail host'), 'mail.example.test');
    await person().selectOptions(view.getByLabelText('Connection security'), 'tls');
    await person().type(view.getByLabelText('SMTP username'), 'me@example.test');
    await person().type(view.getByLabelText('SMTP password'), 'x:@/?#&');
    const url = new URL(view.getByLabelText('Address').textContent);
    expect(url.port).toBe('465');
    expect(url.protocol).toBe('smtps:');
    expect(decodeURIComponent(url.password)).toBe('x:@/?#&');
    await person().click(view.getByRole('button', { name: 'Use an SMTP URL' }));
    await person().clear(view.getByLabelText('Mail server'));
    await person().type(view.getByLabelText('Mail server'), 'smtp://other.test:2525');
    await person().click(view.getByRole('button', { name: 'Use separate fields' }));
    expect((view.getByLabelText('Mail host') as HTMLInputElement).value).toBe('other.test');
    await person().clear(view.getByLabelText('Port'));
    await person().type(view.getByLabelText('Port'), '587');
    expect(view.getByLabelText('Address').textContent).toBe('smtp://other.test:587');
    await person().selectOptions(view.getByLabelText('Connection security'), 'starttls');
    view.unmount();
  });
  test.each(['smtps://mail.test', 'smtp://mail.test', 'not a url'])(
    'opening %s has safe defaults',
    async (initial) => {
      const view = await renderApp(<Relay initial={initial} />);
      expect((view.getByLabelText('Port') as HTMLInputElement).value).toBe(
        initial.startsWith('smtps:') ? '465' : '587',
      );
      view.unmount();
    },
  );
});
