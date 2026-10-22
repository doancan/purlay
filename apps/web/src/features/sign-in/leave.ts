/**
 * Leaving this page for another by a full navigation, as only the browser can do it: the GitHub round trip
 * ends on this origin with a session cookie none of the router's moves could set. An object, so a test
 * replaces what it does and reads where it was asked to go.
 */
export const leave = {
  to: (url: string): void => {
    window.location.assign(url);
  },
};
