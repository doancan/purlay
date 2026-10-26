/**
 * The route table, the store behind it and the `Link` — against a history the
 * test drives by hand, so Back and Forward are one function call.
 */
import { installDom } from '../testing/dom';
import { fakeHistory } from '../testing/fakes';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { act, fireEvent, render } from '@testing-library/react';
import { browserHistory, createRouter } from './router';
import { Link, RouterProvider, useRoute } from './router-provider';
import { href, matchRoute } from './routes';

installDom();

describe('matching an address', () => {
  test.each<readonly [string, string, Record<string, string>]>([
    ['/sign-in', 'signIn', {}],
    ['/sign-in/native', 'signInNative', {}],
    ['/', 'home', {}],
    ['/w/acme', 'workspace', { slug: 'acme' }],
    ['/w/acme/c/0199-aa', 'channel', { slug: 'acme', channelId: '0199-aa' }],
    ['/w/acme/questions', 'questions', { slug: 'acme' }],
    ['/__gallery', 'gallery', {}],
  ])('%s is %s', (path, name, params) => {
    // Widened: `name` here is any string, and a `Match` only holds the right ones.
    const matched: unknown = matchRoute(path);
    expect(matched).toEqual({ name, params });
  });

  test('a trailing slash and a doubled one do not matter', () => {
    expect(matchRoute('/w/acme/')).toEqual({ name: 'workspace', params: { slug: 'acme' } });
    expect(matchRoute('//sign-in//')).toEqual({ name: 'signIn', params: {} });
  });

  test('params are decoded', () => {
    expect(matchRoute('/w/a%20b')).toEqual({ name: 'workspace', params: { slug: 'a b' } });
  });

  test.each(['/nowhere', '/w', '/w/acme/c', '/w/acme/c/1/extra', '/sign-in/x', '/w/%E0%A4%A'])(
    '%s is not a route',
    (path) => {
      expect(matchRoute(path)).toEqual({ name: 'notFound', params: {} });
    },
  );

  test('a param is never empty', () => {
    expect(matchRoute('/w/%20').name).toBe('workspace');
    expect(matchRoute('/w//questions')).toEqual({ name: 'notFound', params: {} });
  });
});

describe('spelling an address', () => {
  test('fills and encodes params', () => {
    expect(href('home')).toBe('/');
    expect(href('channel', { slug: 'a b', channelId: 'x/y' })).toBe('/w/a%20b/c/x%2Fy');
  });

  test('round-trips through the matcher', () => {
    const address = href('questions', { slug: 'café' });
    expect(matchRoute(address)).toEqual({ name: 'questions', params: { slug: 'café' } });
  });

  test('the types refuse a route that does not exist, a missing param and a wrong one', () => {
    const refused = (): void => {
      // @ts-expect-error -- there is no such route (#138)
      href('nowhere');
      // @ts-expect-error -- a route with params needs them (#138)
      href('channel');
      // @ts-expect-error -- and by their right names (#138)
      href('channel', { slug: 'a', channel: 'b' });
      // @ts-expect-error -- a route without params takes none (#138)
      href('home', { slug: 'a' });
    };
    expect(typeof refused).toBe('function');
  });
});

describe('the store', () => {
  test('reads the location, and gives the same snapshot until it changes', () => {
    const router = createRouter(fakeHistory('/w/acme?x=1'));
    const first = router.getSnapshot();
    expect(first.pathname).toBe('/w/acme');
    expect(first.search).toBe('?x=1');
    expect(first.match).toEqual({ name: 'workspace', params: { slug: 'acme' } });
    expect(router.getSnapshot()).toBe(first);
  });

  test('navigating pushes, tells subscribers, and Back returns', () => {
    const history = fakeHistory('/');
    const router = createRouter(history);
    let told = 0;
    router.subscribe(() => {
      told += 1;
    });
    router.navigate('/sign-in');
    expect(history.stack).toEqual(['/', '/sign-in']);
    expect(router.getSnapshot().match.name).toBe('signIn');
    expect(told).toBe(1);
    history.back();
    expect(router.getSnapshot().match.name).toBe('home');
    expect(told).toBe(2);
  });

  test('replacing leaves no entry to go Back to', () => {
    const history = fakeHistory('/');
    const router = createRouter(history);
    router.navigate('/sign-in', { replace: true });
    expect(history.stack).toEqual(['/sign-in']);
  });

  test('going to where it already is tells nobody', () => {
    const router = createRouter(fakeHistory('/sign-in'));
    let told = 0;
    router.subscribe(() => {
      told += 1;
    });
    router.navigate('/sign-in');
    expect(told).toBe(0);
  });

  test('a query change is a change', () => {
    const router = createRouter(fakeHistory('/sign-in'));
    router.navigate('/sign-in?error=1');
    expect(router.getSnapshot().search).toBe('?error=1');
  });

  test('listens to the browser only while somebody is reading', () => {
    const history = fakeHistory('/');
    const router = createRouter(history);
    expect(history.listeners()).toBe(0);
    const stopA = router.subscribe(() => undefined);
    const stopB = router.subscribe(() => undefined);
    expect(history.listeners()).toBe(1);
    stopA();
    expect(history.listeners()).toBe(1);
    stopB();
    expect(history.listeners()).toBe(0);
  });

  test('catches up on Back pressed while nobody was subscribed', () => {
    const history = fakeHistory('/');
    const router = createRouter(history);
    router.navigate('/sign-in');
    history.stack.pop();
    expect(router.getSnapshot().match.name).toBe('signIn');
    router.subscribe(() => undefined);
    expect(router.getSnapshot().match.name).toBe('home');
  });
});

describe('the browser’s history', () => {
  test('is window.history and window.location', () => {
    // happy-dom starts on about:blank, which has no path to read.
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(
      'http://localhost/',
    );
    const port = browserHistory();
    port.replace('/sign-in?x=1');
    expect(port.read()).toEqual({ pathname: '/sign-in', search: '?x=1' });
    port.push('/w/acme');
    expect(window.location.pathname).toBe('/w/acme');
    let heard = 0;
    const stop = port.listen(() => {
      heard += 1;
    });
    window.dispatchEvent(new window.Event('popstate'));
    expect(heard).toBe(1);
    stop();
    window.dispatchEvent(new window.Event('popstate'));
    expect(heard).toBe(1);
  });
});

const Where = (): React.JSX.Element => {
  const { match, navigate } = useRoute();
  return (
    <div>
      <p data-testid="where">{match.name}</p>
      <button
        type="button"
        onClick={() => {
          navigate('/sign-in', { replace: true });
        }}
      >
        go
      </button>
    </div>
  );
};

describe('in React', () => {
  test('useRoute follows navigation and can navigate', () => {
    const history = fakeHistory('/');
    const { getByTestId, getByRole } = render(
      <RouterProvider history={history}>
        <Where />
      </RouterProvider>,
    );
    expect(getByTestId('where').textContent).toBe('home');
    act(() => {
      getByRole('button').click();
    });
    expect(getByTestId('where').textContent).toBe('signIn');
    expect(history.stack).toEqual(['/sign-in']);
  });

  test('follows Back', () => {
    const history = fakeHistory('/');
    const { getByTestId, getByRole } = render(
      <RouterProvider history={history}>
        <Where />
      </RouterProvider>,
    );
    act(() => {
      getByRole('button').click();
    });
    act(() => {
      history.stack.unshift('/');
      history.back();
    });
    expect(getByTestId('where').textContent).toBe('home');
  });

  test('uses the browser’s history when given none', () => {
    const { getByTestId } = render(
      <RouterProvider>
        <Where />
      </RouterProvider>,
    );
    expect(getByTestId('where').textContent).toBeTruthy();
  });

  test('the hooks refuse to work outside a provider', () => {
    // React reports the error it throws; the test asserts the throw.
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Where />)).toThrow('<RouterProvider>');
    } finally {
      logged.mockRestore();
    }
  });
});

describe('Link', () => {
  // A click the router leaves alone would make happy-dom follow the link — a real
  // network request to a server that is not there. The browser's default is not
  // what is under test, so it is cancelled *after* the router has looked at it.
  const cancelNavigation = (event: Event): void => {
    event.preventDefault();
  };
  beforeAll(() => {
    document.addEventListener('click', cancelNavigation);
  });
  afterAll(() => {
    document.removeEventListener('click', cancelNavigation);
  });

  const setup = (
    history = fakeHistory('/'),
  ): ReturnType<typeof render> & { history: ReturnType<typeof fakeHistory> } => ({
    history,
    ...render(
      <RouterProvider history={history}>
        <Link to="channel" params={{ slug: 'acme', channelId: 'c1' }}>
          api
        </Link>
        <Link to="home" target="_blank">
          new tab
        </Link>
        <Link to="signIn" download>
          saved
        </Link>
        <Link
          to="questions"
          params={{ slug: 'acme' }}
          onClick={(event) => {
            event.preventDefault();
          }}
        >
          handled
        </Link>
        <Link to="gallery" aria-current="location">
          gallery
        </Link>
      </RouterProvider>,
    ),
  });

  test('is a real anchor with the address', () => {
    const { getByRole } = setup();
    expect(getByRole('link', { name: 'api' }).getAttribute('href')).toBe('/w/acme/c/c1');
  });

  test('a plain click navigates without a reload', () => {
    const { getByRole, history } = setup();
    const link = getByRole('link', { name: 'api' });
    fireEvent.click(link);
    expect(history.stack).toEqual(['/', '/w/acme/c/c1']);
  });

  test.each([
    ['meta', { metaKey: true }],
    ['control', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['a non-primary button', { button: 1 }],
  ])('%s leaves the click to the browser', (_, init) => {
    const { getByRole, history } = setup();
    fireEvent.click(getByRole('link', { name: 'api' }), init);
    expect(history.stack).toEqual(['/']);
  });

  test('a target, a download and a click somebody else handled are the browser’s too', () => {
    const { getByRole, history } = setup();
    fireEvent.click(getByRole('link', { name: 'new tab' }));
    fireEvent.click(getByRole('link', { name: 'saved' }));
    fireEvent.click(getByRole('link', { name: 'handled' }));
    expect(history.stack).toEqual(['/']);
  });

  test('marks the link to the current page, and only that one', () => {
    const { getByRole } = setup(fakeHistory('/w/acme/c/c1'));
    expect(getByRole('link', { name: 'api' }).getAttribute('aria-current')).toBe('page');
    expect(getByRole('link', { name: 'handled' }).getAttribute('aria-current')).toBeNull();
    expect(getByRole('link', { name: 'gallery' }).getAttribute('aria-current')).toBe('location');
  });
});
