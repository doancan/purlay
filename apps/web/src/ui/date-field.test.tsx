import { installDom } from '../testing/dom';
import { describe, expect, mock, test } from 'bun:test';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { expectFocusOn } from '../testing/focus';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { DateField } from './date-field';

installDom();

const open = async (
  props: Partial<React.ComponentProps<typeof DateField>> = {},
): Promise<Awaited<ReturnType<typeof renderApp>> & { onChange: (value: string) => void }> => {
  const onChange = mock<(value: string) => void>(() => undefined);
  const view = await renderApp(<DateField label="From" value="" onChange={onChange} {...props} />);
  fireEvent.click(view.getByRole('button', { name: /From/ }));
  await waitFor(() => {
    view.getByRole('grid');
  });
  return { ...view, onChange };
};

describe('DateField', () => {
  test('says the chosen day in words and a placeholder when there is none', async () => {
    const { getByRole } = await renderApp(
      <DateField label="From" value="2026-03-09" onChange={() => undefined} />,
    );
    expect(getByRole('button', { name: /From/ }).textContent).toContain('2026');
    const empty = await renderApp(<DateField label="To" value="" onChange={() => undefined} />);
    expect(empty.getByRole('button', { name: /To/ }).textContent).toContain('Pick a day');
  });

  test('picking a day reports it as YYYY-MM-DD and closes', async () => {
    const { getByLabelText, onChange, queryByRole } = await open({ value: '2026-03-09' });
    fireEvent.click(getByLabelText(/March 12, 2026/));
    expect(onChange).toHaveBeenCalledWith('2026-03-12');
    await waitFor(() => {
      expect(queryByRole('grid')).toBeNull();
    });
  });

  test('arrows and paging move the focused day', async () => {
    const { getByRole } = await open({ value: '2026-03-09' });
    const grid = getByRole('grid');
    for (const [key, label] of [
      ['ArrowRight', /March 10, 2026/],
      ['ArrowDown', /March 17, 2026/],
      ['ArrowLeft', /March 16, 2026/],
      ['ArrowUp', /March 9, 2026/],
      ['Home', /March 9, 2026/],
      ['End', /March 15, 2026/],
      ['PageDown', /April 15, 2026/],
      ['PageUp', /March 15, 2026/],
    ] as const) {
      fireEvent.keyDown(grid, { key });
      await waitFor(() => {
        expectFocusOn(within(grid).getByLabelText(label));
      });
    }
    fireEvent.keyDown(grid, { key: 'x' });
  });

  test('days outside min and max cannot be picked', async () => {
    const { getByLabelText, onChange } = await open({
      value: '2026-03-09',
      min: '2026-03-05',
      max: '2026-03-20',
    });
    const before = getByLabelText(/March 4, 2026/) as HTMLButtonElement;
    expect(before.disabled).toBe(true);
    fireEvent.click(before);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('months turn from the header, and the field can be cleared', async () => {
    const { getByRole, getByText, onChange } = await open({ value: '2026-03-09' });
    fireEvent.click(getByRole('button', { name: 'Next month' }));
    expect(getByText('April 2026')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Previous month' }));
    fireEvent.click(getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  test('Today picks the current day', async () => {
    const { getByRole, onChange } = await open();
    fireEvent.click(getByRole('button', { name: 'Today' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('a hint and an error are announced with the field, and it passes axe', async () => {
    const { container, getByRole, getByText } = await renderApp(
      <DateField label="To" value="" onChange={() => undefined} hint="A hint" error="Wrong" />,
    );
    expect(getByText('A hint')).toBeTruthy();
    expect(getByRole('alert').textContent).toContain('Wrong');
    await expectNoAxeViolations(container);
  });
});
