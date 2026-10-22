import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { leave } from './leave';

installDom();

describe('leaving for another page', () => {
  afterEach(() => undefined);

  test('asks the browser to navigate to exactly the address it was given', () => {
    const assign = spyOn(window.location, 'assign').mockImplementation(() => undefined);
    leave.to('/auth/github');
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/auth/github');
    assign.mockRestore();
  });
});
