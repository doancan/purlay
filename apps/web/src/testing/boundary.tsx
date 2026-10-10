/**
 * What a component says when it cannot render.
 *
 * React 19 reports an error thrown while rendering to the page instead of throwing it
 * from `render`, so `expect(() => render(...)).toThrow()` never sees it. A boundary
 * catches it and this returns its message — which is how a hook that refuses to be
 * used outside its provider is tested.
 */
import { Component } from 'react';
import { spyOn } from 'bun:test';
import { render } from '@testing-library/react';

class Catch extends Component<
  { readonly onError: (error: Error) => void; readonly children: React.ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: Error): void {
    this.props.onError(error);
  }
  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Renders `ui` and returns the message of the error it threw, or null if it rendered. */
export const errorOf = (ui: React.ReactElement): string | null => {
  let message: string | null = null;
  const quiet = spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <Catch
      onError={(error) => {
        message = error.message;
      }}
    >
      {ui}
    </Catch>,
  );
  quiet.mockRestore();
  return message;
};
