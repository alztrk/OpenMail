# OpenMail Design System

## Design read

OpenMail is a frequently used Windows desktop tool. Its interface is calm, local, and quick to scan: a near-black work surface, one muted green accent, and thin boundaries that keep the mail workspace quiet.

## Direction

OpenMail should feel like a local tool that stays beside the user's work, not a copy of a webmail marketing surface. The default heavy top navigation and colorful card grid are rejected in favor of account context on the left and one focused content surface on the right.

## Layout

- Full-window layout with a custom header, account sidebar, and content area.
- Header: `OpenMail` on the left; custom minimize, maximize, and close controls on the right.
- Sidebar: accounts are first-class navigation objects. Provider, account identity, and sync state appear together.
- Content: inbox, search, filters, and message rows stay in one reading flow.
- Footer: not present in the current shell. Do not reserve empty space for a footer.
- Narrow windows collapse or reduce the sidebar without losing the message workflow.

## Visual tokens

- Background: `#080A09`
- Sidebar surface: `#0E1210`
- Raised surface: `#121713`
- Hairline border: `#202A22`
- Primary text: `#F1F3EF`
- Secondary text: `#A4AEA6`
- Muted text: `#6F7B72`
- Single accent: `#79B982`
- Positive sync state: `#9CC66B`
- Radius rule: 7-8px controls, 10-12px protected surfaces, circular avatar only.
- Shadows: only for modal or protected overlay surfaces, never on every row or card.

## Typography

Use a Windows system sans-serif stack. Headings are short and moderately weighted. Message rows prioritize scanability. User-facing copy names actions directly instead of adding explanatory clutter.

## Components

- `WindowHeader`: application name and three window controls.
- `AccountList`: connected accounts, provider labels, and sync indicators.
- `SidebarNav`: Inbox, Starred, Sent, Archive, and Trash.
- `MailList`: controlled-density rows, never a card grid.
- `MailRow`: sender, subject, preview, time, and read state.
- `SearchField`: keyboard-accessible search with visible focus.
- Sync status: surfaced through the existing refresh and error states when it carries useful information.
- `Composer`: protected surface for new mail and replies.

## Interaction states

Every primary surface needs loading, empty, error, disabled, and success states. The empty inbox guides the user to connect the first account. Sync errors keep the message list visible when possible and explain the problem in a contextual status row.

## Icon policy

Lucide is not used. Tabler Icons is the shared icon family for interface actions, navigation, settings, and mail state. Provider branding remains in its own SVG assets. Hand-drawn SVG path icons are not allowed.

## Performance and motion

Preserve Tauri's lightweight footprint. Avoid continuous animation, blur, and heavy effects. Motion is limited to modal transitions, sync state changes, and short notification-related transitions. Respect reduced-motion preferences.

## Acceptance criteria

- The first viewport clearly contains OpenMail, the account area, the content title, and window controls.
- The sidebar is reserved for accounts and navigation; mail content stays on the right.
- Header carries real window controls; no decorative footer zone is added.
- The color system uses one accent color.
- The message list is a scannable row layout, not a card grid.
- Keyboard focus, empty, loading, and error states are visible.
- `npm run lint`, `npm run build`, `cargo check`, and the Windows Tauri build pass.
