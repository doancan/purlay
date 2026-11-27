# D-321. A mention of you is a tint, not a fill — amends D-119 §5, D-187

**Decided by the owner, 2026-11-19**, from a live comparison in the running product, in both themes. D-119 §5 made a mention of you fill your own name (`accent` with `on-accent`) because your own messages, then drawn as `accent-subtle` bubbles, would have swallowed a tint; D-187 kept the fill ("still fills") when it removed the bubbles. With the bubbles gone the reason was gone and the fill stayed: in a feed with several mentions the solid blue chips were the loudest thing on the page, louder than the unread marker.

**What changes.** The name of the person themself in a message gets `accent-subtle` behind `accent-text` and `font-medium`; somebody else's mention stays the accent's text alone, so the two are still told apart by the wash. The pair is already in the contrast table (a mention's tint is named there since D-110), and the check was made on screen: in the light theme a pale blue pill with the deep blue text, in the dark theme the wash is close to the page and the pale blue text carries it, which still reads at once.

**Rejected.** Keeping the fill because the owner chose it twice: the reason given for it no longer holds, and the comparison was made on the real screen, not on tokens. A yellow highlight, as other chat products use: a second accent colour for one purpose (D-110's one accent).

**Cost of reversing.** One class string in `render-content.tsx`, its test and the screenshot baselines.
