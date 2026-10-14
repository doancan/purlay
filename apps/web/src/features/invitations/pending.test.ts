import { describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import {
  browserInvitationPorts,
  captureInvitation,
  forgetInvitation,
  keepInvitation,
  pendingInvitation,
  type InvitationPorts,
} from './pending';

installDom();

const TOKEN = 'a'.repeat(64);

const ports = (
  refuses = false,
): InvitationPorts & { kept: Map<string, string>; urls: string[] } => {
  const kept = new Map<string, string>();
  const urls: string[] = [];
  return {
    kept,
    urls,
    storage: {
      getItem: (key): string | null => {
        if (refuses) throw new Error('blocked');
        return kept.get(key) ?? null;
      },
      setItem: (key, value): void => {
        if (refuses) throw new Error('blocked');
        kept.set(key, value);
      },
      removeItem: (key): void => {
        if (refuses) throw new Error('blocked');
        kept.delete(key);
      },
    },
    replace: (url): void => {
      urls.push(url);
    },
  };
};

describe('an invitation the page was opened with', () => {
  test('leaves the address as the page loads, and waits in the tab until it is used', () => {
    const p = ports();
    captureInvitation({ pathname: '/invite', hash: `#${TOKEN}` }, p);
    expect(p.urls).toEqual(['/invite']);
    expect(pendingInvitation(p, { hash: '' })).toBe(TOKEN);
    forgetInvitation(p);
    expect(pendingInvitation(p, { hash: '' })).toBeNull();
  });

  test('another page, or a fragment that is not a token, is left alone', () => {
    for (const location of [
      { pathname: '/w/acme', hash: `#${TOKEN}` },
      { pathname: '/invite', hash: '#not-a-token' },
      { pathname: '/invite', hash: `#${TOKEN.toUpperCase()}` },
      { pathname: '/invite', hash: '' },
    ]) {
      const p = ports();
      captureInvitation(location, p);
      expect(p.urls).toEqual([]);
      expect(p.kept.size).toBe(0);
    }
  });

  test('a tab that cannot keep it leaves it in the address, where the screen still finds it', () => {
    const p = ports(true);
    captureInvitation({ pathname: '/invite', hash: `#${TOKEN}` }, p);
    expect(p.urls).toEqual([]);
    expect(pendingInvitation(p, { hash: `#${TOKEN}` })).toBe(TOKEN);
    expect(() => {
      forgetInvitation(p);
    }).not.toThrow();
  });

  test('in the browser, the tab keeps it and the address is rewritten without a navigation', () => {
    window.history.replaceState(null, '', `/invite#${TOKEN}`);
    captureInvitation(window.location, browserInvitationPorts());
    expect(window.location.pathname).toBe('/invite');
    expect(window.location.hash).toBe('');
    expect(pendingInvitation(browserInvitationPorts(), window.location)).toBe(TOKEN);
    forgetInvitation(browserInvitationPorts());
    expect(window.sessionStorage.getItem('purlay.invitation')).toBeNull();
  });
});

describe('an invitation a sign-in link carried (D-138 §4)', () => {
  test('is kept as one opened here would be, and found by what reads them', () => {
    const tab = ports();
    keepInvitation(TOKEN, tab);
    expect(pendingInvitation(tab, { hash: '' })).toBe(TOKEN);
  });

  test('what is not a token is not kept, and storage that refuses is survived', () => {
    const tab = ports();
    keepInvitation('not-a-token', tab);
    expect(tab.kept.size).toBe(0);
    expect(() => {
      keepInvitation(TOKEN, ports(true));
    }).not.toThrow();
  });
});
