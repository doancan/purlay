# D-358. An unread Urgent notification can re-alert through the device queue — amends D-337 (#1381)

The original send writes one repeat cursor for each new unread direct-message or mention notification. It anchors to the original notification's time and follows the same account-wide read receipt. An edit or a replay of the send leaves the original cursor unchanged.

A chat worker advances the cursor every two minutes within a twenty-minute window, starting at minute two. It picks the current slot after a delay, and the delivery expires at the next boundary. The cursor move and device capture commit together. The occurrence identifies one slot across retries. The original notification identifies the recipient and the current source for authorization.

A repeat needs current access to the message, a direct-message recipient or a current personal mention, and a workspace that allows Urgent. The original unread receipt must still be open. Deep Work, quiet hours, notification preferences and current device registration apply at delivery. A newly eligible slot can alert after Deep Work ends. The provider receives the reason and navigation target already used for a message notice. The same inbox entry and unread counts describe the message throughout the window.

**Rejected.** Creating a fresh inbox entry for every repeat would multiply unread counts. Capturing every future device delivery during the original send would reserve work even for messages read in the first interval.

**Cost of reversing.** The worker can be removed independently of the original send. Its cursors follow notification deletion and queued occurrences expire within their slots. Older delivery workers do not claim the repeat kind.
