# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Small and medium businesses and corporate teams, including people outside software development.
This audience and the chat-first scope were explicitly specified by Görkem in the current task.

## Product Purpose

Purlay is the team's chat. People converse, share files and links, and return to the conversation
which supplies their context. Shared content discovery extends that workflow.

## Capabilities and Constraints

- The current Shared task covers files and links from accessible conversations, channel/person/type/date
  filters, bounded pages, message/thread navigation, existing previews and authorized downloads.
- Restricted guests see only their assigned channels and only content shared after joining. Existing
  private/DM, removed-member, deletion and session boundaries apply to every Shared surface.
- Reuse the existing interface, tokens, navigation, components and storage. Both English and Turkish,
  narrow layouts, keyboard use, error/stale/offline and live updates belong to the requested work.
- Procurement/ERP business workflows were deferred by the user; inbound webhook messages are delivered
  separately. Corporate identity/provisioning and remaining mobile acceptance stay in the wider goal.

## Evidence on Hand

The user's accepted goal is tracked in #1372. Existing technical and product authorities are
[OVERVIEW](../../docs/OVERVIEW.md), [UX](../../docs/UX.md), [DECISIONS](../../docs/DECISIONS.md),
the chat source, and committed browser screenshots under `e2e/__snapshots__/`. This record does not
replace those authorities or introduce new product claims.

## Product Principles

- Keep conversation as the primary product.
- Show only content the current person can access.
- Preserve useful message context when discovering shared material.
- Reuse established behavior and visual conventions.
