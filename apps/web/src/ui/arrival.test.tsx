import { expect, test } from 'bun:test';
import { fireEvent, render } from '@testing-library/react';
import { installDom } from '../testing/dom';
import { useArrivals } from './arrival';

installDom();

const Rows = ({ ids }: { readonly ids?: readonly string[] }): React.JSX.Element => {
  const arrival = useArrivals(ids);
  return (
    <ul>
      {ids?.map((id) => (
        <li key={id} data-testid={`row-${id}`} {...arrival(id)}>
          <span>{id}</span>
        </li>
      ))}
    </ul>
  );
};

test('a newly arrived row finishes once, on its own final animation', () => {
  const view = render(<Rows />);
  view.rerender(<Rows ids={['existing']} />);
  expect(view.getByTestId('row-existing').hasAttribute('data-arrived')).toBe(false);

  view.rerender(<Rows ids={['existing', 'new']} />);
  const row = view.getByTestId('row-new');
  expect(row.hasAttribute('data-arrived')).toBe(true);

  fireEvent.animationEnd(view.getByText('new'), { animationName: 'arrive-glow' });
  fireEvent.animationEnd(row, { animationName: 'arrive-rise' });
  expect(row.hasAttribute('data-arrived')).toBe(true);

  fireEvent.animationEnd(row, { animationName: 'arrive-glow' });
  expect(row.hasAttribute('data-arrived')).toBe(false);

  view.rerender(<Rows ids={['existing']} />);
  view.rerender(<Rows ids={['existing', 'new']} />);
  expect(view.getByTestId('row-new').hasAttribute('data-arrived')).toBe(false);
  view.unmount();
});
