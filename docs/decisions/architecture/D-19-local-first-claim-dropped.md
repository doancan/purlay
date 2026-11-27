# D-19. "Local-first" is dropped as a claim

The earlier `OVERVIEW.md` called Zustand "local-first optimistic state". Zustand lives in
memory — closing the tab loses everything. The accurate term is **optimistic**, which is what
we are building. Genuine local-first (IndexedDB persistence, offline queue, sync/merge on
reconnect) is a large, separate undertaking and is **not planned**.
