import { expect, test } from 'bun:test';
import { renderApp } from '../../testing/render';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import { SetupProvider } from './context';
import { SetupFailure } from './client';
import { AdminStep } from './steps/admin-step';
import { ClaimStep } from './steps/claim-step';
import { aClient, aState, settle } from './testing';

installDom();

test('the completed administrator step honours a supplied Back action', async () => {
  let backs = 0;
  const view = await renderApp(
    <SetupProvider client={aClient()} onLost={() => undefined}>
      <AdminStep
        state={aState({ admin: { name: 'Ada', email: 'ada@example.test', emailVerified: false } })}
        done
        onBack={() => {
          backs += 1;
        }}
        onNext={() => undefined}
        goTo={() => undefined}
      />
    </SetupProvider>,
  );
  await person().click(view.getByRole('button', { name: 'Back' }));
  expect(backs).toBe(1);
  view.unmount();
});

for (const [code, status] of [
  ['RATE_LIMITED', 429],
  ['FORBIDDEN', 403],
  ['SETUP_UNAVAILABLE', 404],
  ['INTERNAL', 500],
] as const) {
  test(`a refused setup claim explains ${code}`, async () => {
    const view = await renderApp(
      <SetupProvider
        client={aClient({
          claim: () => Promise.reject(new SetupFailure(status, code, 'refused', 120)),
        })}
        onLost={() => undefined}
      >
        <ClaimStep appUrl="https://purlay.test" origin="https://purlay.test" lost={false} />
      </SetupProvider>,
    );
    await person().type(view.getByRole('textbox'), 'claim-code');
    await person().click(view.getByRole('button', { name: 'Continue' }));
    await settle();
    if (code === 'RATE_LIMITED')
      expect(
        view.getByText('Too many tries from this browser. Wait 2 minutes and try again.'),
      ).toBeDefined();
    if (code === 'FORBIDDEN')
      expect(view.getByText(/The server refused the code from this address/)).toBeDefined();
    if (code === 'INTERNAL') expect(view.getByRole('alert').textContent.length).toBeGreaterThan(0);
    if (code === 'SETUP_UNAVAILABLE')
      expect(view.getByText('Setup is not available')).toBeDefined();
    view.unmount();
  });
}

test('an invalid configured address is displayed as a mismatch instead of crashing', async () => {
  const view = await renderApp(
    <SetupProvider client={aClient()} onLost={() => undefined}>
      <ClaimStep appUrl="invalid-server-address" origin="https://purlay.test" lost={false} />
    </SetupProvider>,
  );
  expect(view.container.textContent).toContain('invalid-server-address');
  expect(view.queryByRole('textbox')).toBeNull();
  view.unmount();
});
