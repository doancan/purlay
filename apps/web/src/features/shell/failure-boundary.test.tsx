/**
 * A component that throws while drawing (`failure-boundary.tsx`): inside the shell the screen is
 * replaced and the rail and sidebar stay; anywhere else the page says so; both in the person's
 * language, both with Reload and Go home, and the error reported rather than swallowed.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { within } from '@testing-library/react';
import { settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Shell } from './shell';

installDom();

const BROKEN = new Error('a screen that cannot draw');

const Throws = (): React.JSX.Element => {
  throw BROKEN;
};

/** What React reported to the console, the client's one report: the error itself, among the arguments. */
const reports = (): { readonly reported: () => boolean; readonly restore: () => void } => {
  const said = spyOn(console, 'error').mockImplementation(() => undefined);
  return {
    reported: () => said.mock.calls.some((call) => call.includes(BROKEN)),
    restore: (): void => {
      said.mockRestore();
    },
  };
};

let restore = (): void => undefined;
afterEach(() => {
  restore();
});

describe('a screen that throws', () => {
  test('is replaced by a short explanation, the shell stays, and the error is reported', async () => {
    const report = reports();
    restore = report.restore;
    const view = await renderApp(
      <Shell slug="acme">
        <Throws />
      </Shell>,
      { path: '/w/acme/search', api: aSignedInApi() },
    );
    await settle();
    const alert = within(view.getByRole('alert'));
    expect(
      alert.getByRole('heading', { level: 1, name: 'This screen stopped working' }),
    ).toBeDefined();
    expect(alert.getByRole('button', { name: 'Reload' })).toBeDefined();
    expect(alert.getByRole('link', { name: 'Go home' }).getAttribute('href')).toBe('/');
    expect(view.getByRole('complementary', { name: 'Workspace' })).toBeDefined();
    expect(view.getByRole('main').contains(view.getByRole('alert'))).toBe(true);
    expect(report.reported()).toBe(true);
  });

  test('going somewhere else draws afresh', async () => {
    restore = reports().restore;
    let broken = true;
    const Sometimes = (): React.JSX.Element => {
      if (broken) throw BROKEN;
      return <p>drawn</p>;
    };
    const view = await renderApp(
      <Shell slug="acme">
        <Sometimes />
      </Shell>,
      { path: '/w/acme/search', api: aSignedInApi() },
    );
    await settle();
    expect(view.getByRole('alert')).toBeDefined();
    broken = false;
    await person().click(view.getByRole('link', { name: 'Saved' }));
    await settle();
    expect(view.getByText('drawn')).toBeDefined();
  });
});

describe('anything else that throws', () => {
  test('says so in its own main, in the language of the page, with Reload and Go home', async () => {
    const report = reports();
    restore = report.restore;
    const view = await renderApp(<Throws />, { locale: 'tr' });
    const main = within(view.getByRole('main'));
    expect(main.getByRole('alert')).toBeDefined();
    expect(
      main.getByRole('heading', { level: 1, name: 'Purlay çalışmayı durdurdu' }),
    ).toBeDefined();
    expect(main.getByRole('link', { name: 'Ana sayfaya dön' }).getAttribute('href')).toBe('/');
    expect(report.reported()).toBe(true);
  });

  test('Reload loads the page again', async () => {
    restore = reports().restore;
    const reload = mock(() => undefined);
    const original = window.location.reload.bind(window.location);
    Object.defineProperty(window.location, 'reload', { value: reload, configurable: true });
    try {
      const view = await renderApp(<Throws />);
      await person().click(view.getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window.location, 'reload', { value: original, configurable: true });
    }
  });
});
