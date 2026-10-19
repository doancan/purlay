/**
 * Only the row focus is in has stops inside it (`row-stops.ts`, D-168): what is taken out, what is
 * given back and as what, and what is drawn while a row is out.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, render } from '@testing-library/react';
import { useRef, useState } from 'react';
import { installDom } from '../../testing/dom';
import { expectFocusOn, pressTab, tabOrder } from '../../testing/focus';
import { useRowStops } from './row-stops';

installDom();

const Row = ({
  name,
  tabbable = false,
  children,
}: {
  readonly name: string;
  readonly tabbable?: boolean;
  readonly children?: React.ReactNode;
}): React.JSX.Element => {
  const self = useRef<HTMLElement>(null);
  useRowStops(self);
  return (
    <article ref={self} data-message-row="" aria-label={name} tabIndex={tabbable ? 0 : -1}>
      {children}
    </article>
  );
};

const names = (stops: readonly HTMLElement[]): string[] =>
  stops.map((stop) => stop.getAttribute('aria-label') ?? stop.textContent.trim());

const focus = (element: HTMLElement): void => {
  act(() => {
    element.focus();
  });
};

describe('a row out of focus', () => {
  test('has no stops inside it; the row focus is in has its own, in the order they are drawn', () => {
    const view = render(
      <>
        <button type="button">before</button>
        <Row name="a">
          <a href="https://example.com/">link a</a>
          <button type="button">chip a</button>
        </Row>
        <Row name="b" tabbable>
          <button type="button">chip b</button>
          <pre tabIndex={0} aria-label="code b" />
        </Row>
        <button type="button">after</button>
      </>,
    );
    expect(names(tabOrder())).toEqual(['before', 'b', 'after']);
    focus(view.getByRole('article', { name: 'b' }));
    expect(names(tabOrder())).toEqual(['before', 'b', 'chip b', 'code b', 'after']);
    // The other row, and only it, once focus moves there — by a script, a click or anything else.
    focus(view.getByRole('article', { name: 'a' }));
    expect(names(tabOrder())).toEqual(['before', 'link a', 'chip a', 'b', 'after']);
    focus(view.getByRole('button', { name: 'after' }));
    expect(names(tabOrder())).toEqual(['before', 'b', 'after']);
  });

  test('Tab walks into the focused row, through it and out; Shift+Tab from after comes back to the row', () => {
    const view = render(
      <>
        <button type="button">before</button>
        <Row name="a">
          <button type="button">chip a</button>
        </Row>
        <Row name="b" tabbable>
          <button type="button">chip b</button>
        </Row>
        <button type="button">after</button>
      </>,
    );
    focus(view.getByRole('button', { name: 'before' }));
    const walk: string[] = [];
    for (let press = 0; press < 3; press++) {
      act(() => {
        walk.push(names([pressTab() ?? document.body])[0] ?? '');
      });
    }
    expect(walk).toEqual(['b', 'chip b', 'after']);
    act(() => {
      pressTab(true);
    });
    expectFocusOn(view.getByRole('article', { name: 'b' }));
  });

  test('keeps every control within reach of the pointer and a script: taken out of Tab only', () => {
    let clicked = 0;
    const view = render(
      <Row name="a">
        <button
          type="button"
          onClick={() => {
            clicked += 1;
          }}
        >
          chip
        </button>
      </Row>,
    );
    const chip = view.getByRole('button', { name: 'chip' });
    expect(chip.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(chip);
    expect(clicked).toBe(1);
    // Still named and in the tree: a screen reader's browse mode reads and presses it.
    expect(chip.closest('[inert], [aria-hidden="true"]')).toBeNull();
    focus(chip);
    expectFocusOn(chip);
    // Focused, it brings its row in: its own stop is given back as it was.
    expect(chip.hasAttribute('tabindex')).toBe(false);
  });
});

describe('what a row is given back', () => {
  test('is what it had: none, its own stop, or out because its author meant it', () => {
    const view = render(
      <>
        <Row name="a">
          <button type="button">plain</button>
          <div tabIndex={0} aria-label="region" />
          <h3 tabIndex={-1}>heading</h3>
        </Row>
        <button type="button">elsewhere</button>
      </>,
    );
    const plain = view.getByRole('button', { name: 'plain' });
    const region = view.getByLabelText('region');
    const heading = view.getByText('heading');
    expect([plain, region, heading].map((e) => e.getAttribute('tabindex'))).toEqual([
      '-1',
      '-1',
      '-1',
    ]);
    focus(view.getByRole('article'));
    expect([plain, region, heading].map((e) => e.getAttribute('tabindex'))).toEqual([
      null,
      '0',
      '-1',
    ]);
  });

  test('a row let in and taken out again before it heard itself keeps what it had', async () => {
    const view = render(
      <>
        <Row name="a">
          <button type="button">chip</button>
        </Row>
        <button type="button">elsewhere</button>
      </>,
    );
    const row = view.getByRole('article');
    const chip = view.getByRole('button', { name: 'chip' });
    act(() => {
      row.focus();
      view.getByRole('button', { name: 'elsewhere' }).focus();
    });
    await act(async () => {
      await Promise.resolve();
    });
    focus(row);
    expect(chip.hasAttribute('tabindex')).toBe(false);
  });

  test('a row drawn around focus is the one; a row that goes while it is one leaves nothing held', () => {
    const Around = (): React.JSX.Element => {
      const [shown, setShown] = useState(true);
      return (
        <>
          {shown && (
            <Row name="a">
              <button
                type="button"
                onClick={() => {
                  setShown(false);
                }}
              >
                go
              </button>
            </Row>
          )}
          <Row name="b">
            <button type="button">chip b</button>
          </Row>
        </>
      );
    };
    const view = render(<Around />);
    const go = view.getByRole('button', { name: 'go' });
    focus(go);
    act(() => {
      fireEvent.click(go);
    });
    focus(view.getByRole('article', { name: 'b' }));
    expect(view.getByRole('button', { name: 'chip b' }).hasAttribute('tabindex')).toBe(false);
    view.unmount();
    // Focus already in a row when it registers: it is not taken out under the person.
    const host = document.createElement('div');
    document.body.append(host);
    const Late = (): React.JSX.Element => {
      const self = useRef<HTMLElement>(null);
      const [registered, setRegistered] = useState(false);
      return (
        <article ref={self} data-message-row="" tabIndex={-1}>
          <button
            type="button"
            onClick={() => {
              setRegistered(true);
            }}
          >
            late
          </button>
          {registered && <Registers target={self} />}
        </article>
      );
    };
    const Registers = ({
      target,
    }: {
      readonly target: React.RefObject<HTMLElement | null>;
    }): null => {
      useRowStops(target);
      return null;
    };
    const late = render(<Late />, { container: host });
    const button = late.getByRole('button', { name: 'late' });
    focus(button);
    act(() => {
      fireEvent.click(button);
    });
    expect(button.hasAttribute('tabindex')).toBe(false);
    late.unmount();
    host.remove();
  });
});

describe('a row drawn into while it is out', () => {
  const Growing = (): React.JSX.Element => {
    const [more, setMore] = useState(false);
    const [clamped, setClamped] = useState(true);
    const [index, setIndex] = useState<0 | -1>(0);
    return (
      <>
        <Row name="a">
          <pre tabIndex={clamped ? undefined : 0} aria-label="code" />
          <div tabIndex={index} aria-label="region" />
          {more && <button type="button">new chip</button>}
        </Row>
        <button
          type="button"
          onClick={() => {
            setMore(true);
            setClamped((c) => !c);
          }}
        >
          grow
        </button>
        <button
          type="button"
          onClick={() => {
            setIndex(-1);
          }}
        >
          withdraw
        </button>
      </>
    );
  };

  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  test('takes out what arrives, and gives back what its author changed it to', async () => {
    const view = render(<Growing />);
    const code = view.getByLabelText('code');
    expect(code.hasAttribute('tabindex')).toBe(false);
    fireEvent.click(view.getByRole('button', { name: 'grow' }));
    await flush();
    // A new chip, and a block no longer clamped and so a stop: both out while the row is.
    expect(view.getByRole('button', { name: 'new chip' }).getAttribute('tabindex')).toBe('-1');
    expect(code.getAttribute('tabindex')).toBe('-1');
    expect(names(tabOrder())).toEqual(['grow', 'withdraw']);
    focus(view.getByRole('article'));
    expect(code.getAttribute('tabindex')).toBe('0');
    expect(view.getByRole('button', { name: 'new chip' }).hasAttribute('tabindex')).toBe(false);
  });

  test('a block clamped again while out is nothing to give back; one its author took out stays out', async () => {
    const view = render(<Growing />);
    const code = view.getByLabelText('code');
    const region = view.getByLabelText('region');
    fireEvent.click(view.getByRole('button', { name: 'grow' }));
    await flush();
    fireEvent.click(view.getByRole('button', { name: 'grow' }));
    fireEvent.click(view.getByRole('button', { name: 'withdraw' }));
    await flush();
    focus(view.getByRole('article'));
    expect(code.hasAttribute('tabindex')).toBe(false);
    expect(region.getAttribute('tabindex')).toBe('-1');
  });

  test('a control of a row drawn inside another row is that row’s', () => {
    const view = render(
      <>
        <Row name="outer">
          <button type="button">outer chip</button>
          <Row name="inner">
            <button type="button">inner chip</button>
          </Row>
        </Row>
      </>,
    );
    focus(view.getByRole('article', { name: 'inner' }));
    expect(view.getByRole('button', { name: 'inner chip' }).hasAttribute('tabindex')).toBe(false);
    expect(view.getByRole('button', { name: 'outer chip' }).getAttribute('tabindex')).toBe('-1');
  });

  test('focus leaving for nothing — the window — takes the row out', () => {
    const view = render(
      <Row name="a">
        <button type="button">chip</button>
      </Row>,
    );
    const chip = view.getByRole('button', { name: 'chip' });
    focus(chip);
    act(() => {
      chip.blur();
    });
    expect(chip.getAttribute('tabindex')).toBe('-1');
  });
});
