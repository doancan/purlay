/**
 * Loading, empty, failed — and the form field and skip link that share their
 * accessibility concerns. Each is audited, and each state UX.md §8 names is shown
 * to render.
 */
import { installDom } from '../testing/dom';
import { describe, expect, mock, test } from 'bun:test';
import { fireEvent } from '@testing-library/react';
import { expectNoAxeViolations } from '../testing/axe';
import { person } from '../testing/user';
import { renderApp } from '../testing/render';
import { Button } from './button';
import { Skeleton, SkeletonRow, LoadingStatus } from './skeleton';
import { SkipLink } from './skip-link';
import { EmptyState, ErrorState } from './states';
import { TextField } from './text-field';

installDom();

describe('loading', () => {
  test('is one sentence for a screen reader and a shape for everyone else', async () => {
    const { getByRole, container } = await renderApp(
      <LoadingStatus label="Loading messages">
        <Skeleton className="w-sidebar" />
        <Skeleton />
      </LoadingStatus>,
    );
    const status = getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toBe('Loading messages');
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    await expectNoAxeViolations(container);
  });

  test('a skeleton block takes a width from the caller', async () => {
    const { container } = await renderApp(<Skeleton className="w-sidebar" />);
    expect(container.firstElementChild?.className).toContain('w-sidebar');
  });
});

describe('EmptyState', () => {
  test('is a heading, an explanation and, when there is one, the next action', async () => {
    const { getByRole, container } = await renderApp(
      <EmptyState
        title="No messages yet"
        body="Say what this channel is for."
        action={<Button variant="primary">Write the first message</Button>}
      />,
    );
    expect(getByRole('heading', { level: 2, name: 'No messages yet' })).toBeDefined();
    expect(getByRole('button', { name: 'Write the first message' })).toBeDefined();
    await expectNoAxeViolations(container);
  });

  test('sits at the heading level its page needs', async () => {
    const { getByRole } = await renderApp(<EmptyState as="h1" title="Nothing here" body="…" />);
    expect(getByRole('heading', { level: 1 })).toBeDefined();
  });
});

describe('ErrorState', () => {
  test('is announced, says what happened, and retries', async () => {
    const onRetry = mock(() => undefined);
    const { getByRole, container } = await renderApp(
      <ErrorState
        title="Couldn't load messages"
        body="The server did not answer."
        retryLabel="Retry"
        onRetry={onRetry}
      />,
    );
    expect(getByRole('alert').textContent).toContain("Couldn't load messages");
    fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await expectNoAxeViolations(container);
  });
});

describe('SkipLink', () => {
  test('is the first link and points at the main content', async () => {
    const { getByRole, container } = await renderApp(
      <div>
        <SkipLink target="main">Skip to the conversation</SkipLink>
        <main id="main" tabIndex={-1}>
          <h1>Channel</h1>
        </main>
      </div>,
    );
    expect(getByRole('link', { name: 'Skip to the conversation' }).getAttribute('href')).toBe(
      '#main',
    );
    await expectNoAxeViolations(container);
  });
});

describe('TextField', () => {
  test('the label names the input', async () => {
    const { getByLabelText } = await renderApp(<TextField label="Name" />);
    expect(getByLabelText('Name').tagName).toBe('INPUT');
  });

  test('a hint is read with the field', async () => {
    const { getByLabelText, getByText } = await renderApp(
      <TextField label="Name" hint="Lowercase letters and hyphens." />,
    );
    const input = getByLabelText('Name');
    const hint = getByText('Lowercase letters and hyphens.');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  test('an error marks the field invalid, is announced, and is read with it', async () => {
    const { getByLabelText, getByRole } = await renderApp(
      <TextField label="Name" hint="A hint." error="That name is taken." />,
    );
    const input = getByLabelText('Name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const alert = getByRole('alert');
    expect(alert.textContent).toContain('That name is taken.');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    expect(input.getAttribute('aria-describedby')?.split(' ')).toHaveLength(2);
  });

  test('two fields never share an id', async () => {
    const { getByLabelText } = await renderApp(
      <div>
        <TextField label="Name" />
        <TextField label="Topic" />
      </div>,
    );
    expect(getByLabelText('Name').id).not.toBe(getByLabelText('Topic').id);
  });

  test('passes native attributes through, and takes input', async () => {
    const onChange = mock(() => undefined);
    const { getByLabelText } = await renderApp(
      <TextField
        label="Name"
        name="name"
        placeholder="api"
        onChange={onChange}
        className="w-sidebar"
      />,
    );
    const input = getByLabelText('Name') as HTMLInputElement;
    expect(input.getAttribute('name')).toBe('name');
    expect(input.className).toContain('w-sidebar');
    await person().type(input, 'deploys');
    // One change per key, as a person typing makes them.
    expect(onChange).toHaveBeenCalledTimes('deploys'.length);
    expect(input.value).toBe('deploys');
  });

  test('passes the accessibility audit in each state', async () => {
    const { container } = await renderApp(
      <form>
        <TextField label="Name" />
        <TextField label="Topic" hint="Optional." />
        <TextField label="Slug" error="Already used." />
      </form>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('a skeleton row', () => {
  test('is the outline of a message row: an avatar square and two lines, hidden from assistive technology', async () => {
    const { container } = await renderApp(<SkeletonRow />);
    const row = container.firstElementChild as HTMLElement;
    expect(row.getAttribute('aria-hidden')).toBe('true');
    expect(row.querySelector('.size-avatar-lg.rounded-lg')).not.toBeNull();
    expect(row.querySelectorAll('.h-3')).toHaveLength(2);
  });
});
