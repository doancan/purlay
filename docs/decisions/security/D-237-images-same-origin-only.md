# D-237. Images are this origin's alone: the avatar host's exception goes — amends D-102; closes #850

**Decided (the owner gave the decision to the maintainer, 2026-11-01).** D-102 let the page load images from
`https://avatars.githubusercontent.com`, for avatars "until the image proxy serves them". But D-100, two decisions
earlier, had already decided what an avatar is: initials on a tint chosen from the username, which "needs no image
fetch". The web client has drawn exactly that ever since (`ui/avatar.tsx`); no element of it loads `avatarUrl`. The
exception allowed a host nothing used — a hole in the policy kept for a plan that had been dropped, which #850 then
proposed to fill with avatar mirroring.

- **`img-src 'self'`.** What the page shows is the server's: attachments and their thumbnails, and another host's
  picture through the image proxy (#110). A tag injected past every other defence cannot make a reader's browser call
  GitHub, or anybody, with their address.
- **Nothing is mirrored.** Copying every avatar into the object store would build storage, refresh and erasure for a
  picture the product decided not to draw. `avatarUrl` stays in the contract, GitHub's address, for a client that
  chooses to draw it; such a client fetches it on its own terms.
- **Held where it was.** `serving-the-client.test.ts` states the whole policy, and the browser suite fails a run on
  any `securitypolicyviolation` the page reports, so an image from another host is a red build.

**Considered and rejected.** Mirroring avatars into the object store and serving them from `/api/avatars` (#850's
proposal: a feature for a picture nobody draws). Routing them through `/api/images` (no cache, four fetches a node
at a time: a members list would queue past it). Keeping the exception "in case" (a policy wider than its use is the
gap D-102 exists to close).

**Cost of reversing.** Put the host back in `img-src` beside the client change that draws GitHub's picture.
