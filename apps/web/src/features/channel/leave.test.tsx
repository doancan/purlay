import { expect, test } from 'bun:test';
import { renderApp } from '../../testing/render';
import { installDom } from '../../testing/dom';
import { ApiError } from '../../data/errors';
import { useLeaveRefusal } from './leave';
installDom();

test('a generic leave failure says membership was retained', async () => {
  const Refusal = (): React.JSX.Element => {
    const describe = useLeaveRefusal();
    return <p>{describe(new ApiError(403, 'FORBIDDEN', 'refused'))}</p>;
  };
  const view = await renderApp(<Refusal />);
  expect(view.getByText(/You did not leave the channel/)).toBeDefined();
  view.unmount();
});
