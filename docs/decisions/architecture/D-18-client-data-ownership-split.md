# D-18. Client data ownership is split, deliberately

- **TanStack Query** owns HTTP/server state: hydration, channel lists, history pages, search.
  Direct `fetch` inside `useEffect` is prohibited.
- **Zustand** owns real-time and optimistic state: the live message buffer, pending sends,
  presence, typing, socket status.

The boundary: *if it arrives over HTTP it belongs to Query; if it arrives over the socket or
hasn't been sent yet, it belongs to Zustand.* Query's cache is updated from socket events.
