/**
 * The list screens' shared filter (D-158): a group of choices, the chosen one pressed, a press
 * choosing; a phone gives it the column's width.
 */
import { describe, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import { installDom } from '../testing/dom';
import { person } from '../testing/user';
import { ListFilter } from './list-column';

installDom();

describe('a list filter', () => {
  test('is a named group whose chosen choice is pressed; pressing another chooses it', async () => {
    const chosen: string[] = [];
    const view = render(
      <ListFilter
        label="Show"
        value="all"
        choices={[
          { value: 'all', label: 'All' },
          { value: 'unread', label: 'Unread' },
        ]}
        onChange={(value) => {
          chosen.push(value);
        }}
      />,
    );
    const group = view.getByRole('group', { name: 'Show' });
    expect(view.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    expect(view.getByRole('button', { name: 'Unread' }).getAttribute('aria-pressed')).toBe('false');
    await person().click(view.getByRole('button', { name: 'Unread' }));
    expect(chosen).toEqual(['unread']);
    // At the column's top on a wide window; the column's width, a finger tall, on a phone.
    expect(group.className.split(' ')).toEqual(
      expect.arrayContaining(['self-start', 'max-narrow:self-stretch']) as string[],
    );
    view.unmount();
  });
});
