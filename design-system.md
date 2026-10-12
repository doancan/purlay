# Design System — "Relay" (developer-first team chat)

## Product context
- Developer-first team chat, positioned as a Slack competitor for engineering teams.
- Web first (desktop browser, 1440px primary), later a native macOS app — layout must map cleanly to a macOS window (traffic-light area top-left, sidebar + content split, toolbar-style header).
- JTBD: discuss code in context, react to CI/PR/deploy events without leaving chat, run incidents, navigate everything from the keyboard.

## Key surfaces
1. **Workspace rail** (far left, 56px): workspace avatars, Home, DMs, Activity, Search.
2. **Sidebar** (240px): workspace name + ⌘K search trigger; sections: Starred, Channels (#frontend, #backend, #deploys, #incidents), Direct messages (avatar + presence dot), Integrations (GitHub, CI). Unread = bold + count pill.
3. **Channel header** (48px): channel name, topic, member avatars, linked repo chip (`acme/web`), actions (call, pin, search, details).
4. **Message stream**: grouped messages (avatar 32px, name, mono timestamp), code blocks with syntax highlight + language label + Copy / Open in editor, inline diff blocks (green/red line gutters), GitHub PR cards (title, #number, status, checks, reviewers), CI/deploy event rows (compact, status icon, duration, commit sha in mono), reactions, "3 replies" thread link.
5. **Composer**: rich input, slash-command hint, `/` and `@` affordances, code-block toggle, attach, send (⌘↵).
6. **Thread panel** (right, 380px): parent message + replies + own composer.
7. **Incident banner**: thin status strip in #incidents (severity, duration, on-call person).
8. **Command palette (⌘K)**: centered overlay, grouped results, keyboard hints.

## Visual direction — Light, minimal
- Calm, neutral, high information density without clutter. Reference feel: Linear (light), Height, GitHub's modern UI.
- No gradients, no glassmorphism on web, no decorative illustrations.

## Color
- Background app: `#FFFFFF`; sidebar/rail: `#F7F7F8`; subtle surface: `#FAFAFA`
- Border: `#EEEEF0` (hairline 1px, use sparingly — separate regions with surface tone, not boxes); card border `#EDEDF0`; strong border `#D4D4D8`
- Text primary `#18181B`, secondary `#52525B`, tertiary `#8E8E96` (never lighter for readable text); meta text `#71717A`
- Accent (brand): deep navy `#2C2C54` (hover `#1E1E3B`, tint `#EEEEF3`). Syntax keywords use the accent + font-medium. No bright purple/indigo/violet/teal.
- Status: success `#16A34A` / tint `#F0FDF4`; danger `#DC2626` / tint `#FEF2F2`; warning `#D97706` / tint `#FFFBEB`; info `#2563EB`
- Diff: added bg `#E6FFEC` gutter `#22863A`; removed bg `#FFEBE9` gutter `#CF222E`
- Code block bg `#F6F8FA`, border `#E6E6E9`
- Presence: online `#16A34A`, away `#D97706`, dnd `#DC2626`

## Typography
- UI: **Inter** (13px base for dense UI, 14px for message body), weights 400/500/600 only.
- Code / meta (timestamps, SHAs, branch names, durations, keyboard hints): **JetBrains Mono** 12–13px.
- Headings: Inter 600, 15px (channel name), 13px uppercase-free section labels in 500 secondary color.

## Spacing & shape
- 4px base grid; common: 4, 8, 12, 16, 24.
- Radius: 6px controls, 8px cards/code blocks, 12px overlays (palette), full for avatars/pills.
- Shadows: almost none; overlays only `0 8px 24px rgba(0,0,0,0.08)` + 1px border.
- Row heights: sidebar item 28px; message group padding 8px 20px.

## Components
- Buttons: ghost icon buttons (28px) by default; primary = solid indigo, 6px radius.
- Pills/badges: 18px tall, mono text for counts/SHAs.
- Keyboard hints: `kbd` style — 1px border, 4px radius, mono 11px, bg `#FAFAFA`.
- Icons: Lucide, 16px, 1.5 stroke, secondary color.
- Avatars: rounded square 6px radius for users (developer-tool feel), circle for presence dot.

## Motion
- 120–160ms ease-out for hover/focus; palette opens with 150ms scale(0.98→1) + fade.
- No bouncy motion. Respect reduced-motion.

## macOS readiness
- Leave a 28px-tall top drag region in the rail/sidebar area for traffic lights in the native app.
- Avoid browser-only patterns (hover-only critical actions must have keyboard shortcuts).

## Readability & polish rules (v4)
- Type scale (never override Tailwind smaller than this): xs 12/16, sm 13/20, base 14/22, lg 15/22, xl 16/24. Nothing readable below 11px.
- Message body 14px, line-height 1.6, max readable width ~760px; sender name 14px/600; 16px gap between message groups.
- Sidebar rows 32px, 13.5–14px text, 8px radius hover/active; active = accent tint `#EEEEF3` + accent text.
- Minimal borders: message groups have no borders, only hover bg `#FAFAFA` (8px radius).
- Cards (PR, code, diff): 10px radius, 1px `#EDEDF0` border, shadow `0 1px 2px rgba(0,0,0,0.04)`; status as soft tinted pills.
- Composer: floating 12px-radius surface with subtle shadow, toolbar inside, accent send button.
- Stream avatars 36px, 8px radius.
