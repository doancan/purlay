# D-314. The composer offers an emoji by its name, and what is sent is the emoji — builds on D-181, D-253

**Decided by the owner, 2026-11-18.** A colon and at least two name characters before the caret open a list of up to eight emoji, as `@` opens people and `/` opens commands: ↑ ↓ move, Enter or Tab write the emoji where the colon and the letters were, Esc closes the list for that colon. Enter never sends while the list is open. A name written out in full (`:tada`) and a closing colon become the emoji at that colon, whether or not a list was showing. What is stored and sent is the character, never the name, so readers, search and export need no catalogue of names.

The query stands alone: it is not read after a letter, a digit, another colon or a slash (`12:30`, `Note:x`, `http://host:80`), not inside a fence or inline code, and not for one letter, which keeps the faces typed as text of D-253 (`:D`, `:P`) as they were. Names are folded as the mention list folds them (no case, no Turkish marks). The table is a curated set of nearly two hundred names people know from other chat tools, in `emoji-shortcodes.ts`; a name is added by editing it.

**Rejected.** The full Unicode CLDR name list: several thousand entries in the chat chunk for names nobody types, and the chunk is held to a byte budget (D-277). Storing `:tada:` and drawing it on read: every client, the export and the search would then need the same table forever. Offering the list after one letter: `:D` and `:P` would open it over a face.

**Cost of reversing.** Delete the module and its list; messages already sent hold ordinary emoji. No schema, no contract, no server behaviour.
