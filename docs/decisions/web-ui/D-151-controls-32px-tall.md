# D-151. Controls are 32px tall

**Context.** `size-control` was 28px — every button, tab, select and text field — under UX §1's
density rule ("controls at this height, no larger"). D-118 §6 had already moved density from how
tightly things are set to what is shown. Looking at the running product on 2026-10-19 the owner called
the menus and screens cramped; a 28px field beside a two-line label in a settings row reads as an
afterthought, and a 28px button is a small pointer target for the actions people take most.

**Decided.** `size-control` is **32px** — Linear's height for buttons and fields. Below the narrow
breakpoint `size-touch` (44px) still applies. Sidebar rows stay `size-row` (32px), so a control and a
row are now one height, and the header (48px) keeps its 8px of air above and below a control.

**Rejected.** *36px or more* (Slack's fields): the composer's toolbar and the header would grow for
little gain, and density in a chat product is still worth something. *Bigger only in Settings*: two
heights for one kind of control is the drift a token exists to stop.

**Amends** UX §1's density rule and D-118 §6's wording. **Cost of reversing:** one token.
