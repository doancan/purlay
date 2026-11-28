import { installDom } from '../testing/dom';
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { renderApp } from '../testing/render';
import { person } from '../testing/user';
import { ConfirmDialog } from './confirm-dialog';

installDom();

const mount = async (
  onConfirm: () => void,
  changes: boolean[],
): Promise<Awaited<ReturnType<typeof renderApp>>> =>
  await renderApp(
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        changes.push(next);
      }}
      title="Delete it?"
      description="This cannot be undone."
      confirmLabel="Delete"
      confirmGlyph="delete"
      onConfirm={onConfirm}
    />,
  );

describe('a confirmation', () => {
  test('names the question, and Cancel closes without doing it', async () => {
    const changes: boolean[] = [];
    let done = 0;
    const view = await mount(() => {
      done += 1;
    }, changes);
    expect(view.getByRole('dialog', { name: 'Delete it?' })).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Cancel' }));
    expect(changes).toEqual([false]);
    expect(done).toBe(0);
  });

  test('the action closes the dialog first, then runs', async () => {
    const changes: boolean[] = [];
    const order: string[] = [];
    const view = await mount(() => {
      order.push(`done after ${String(changes.length)} change`);
    }, changes);
    await act(async () => {
      await person().click(view.getByRole('button', { name: 'Delete' }));
    });
    expect(changes).toEqual([false]);
    expect(order).toEqual(['done after 1 change']);
  });
});
