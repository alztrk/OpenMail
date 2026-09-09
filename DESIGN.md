# OpenMail Design System

## Design read

OpenMail is a frequently used Windows desktop tool. Its interface is calm, local, and quick to scan: a near-black work surface, one muted green accent, and thin boundaries that keep the mail workspace quiet.

## Direction

OpenMail should feel like a local tool that stays beside the user's work, not a copy of a webmail marketing surface. The default heavy top navigation and colorful card grid are rejected in favor of account context on the left and one focused content surface on the right.

## Layout

- Full-window layout with a custom header, a 68px account rail, and a content area.
- Header: `OpenMail` on the left; custom minimize, maximize, and close controls on the right.
- Sidebar: accounts are first-class navigation objects. Provider, account identity, and sync state appear together.
- Content: a 304px mailbox sidebar owns folders, filters, and message rows; global search lives in the window header and the reader stays on the right.
- Footer: not present in the current shell. Do not reserve empty space for a footer.
- Narrow windows collapse or reduce the sidebar without losing the message workflow. Account onboarding and loading states can take over the reader, while empty mailbox, search, and filter results keep the mailbox navigation available after an account is connected.
- At mobile and intermediate widths, the account rail reduces to a compact 64px column instead of disappearing, preserving account switching and settings access while protecting reader space.
- Below 1080px, the long localized read-state action keeps its accessible label and tooltip but collapses its visible text to an icon so the toolbar stays within the minimum window width. Below 580px, all reader action labels collapse to icons for the same reason.
- Below 420px, the centered search field reserves a fixed gap after the wordmark and before the window controls so the compact header cannot overlap its own controls.
- Settings exposes a visible back-to-mail control so navigation never dead-ends, including when the account rail is compact.
- Settings content stays left-aligned within a readable 980px maximum width on wide windows; the mail reader keeps its own independent width rules.
- Below 680px, Settings stacks navigation above its content so controls keep usable space; below 360px, the tab list becomes a single column.

## Colors

- Application background: `#070A08`
- Account rail surface: `#0B100D`
- Mail sidebar surface: `#0F1511`
- Raised surface: `#131A15`
- Reader surface: `#090D0B`
- Hover surface: `#172119`
- Selected surface: `#1C2B20`
- Hairline border: `#202C24`
- Strong border: `#2C3D30`
- Primary text: `#F1F5F0`
- Secondary text: `#B9C7BB`
- Muted text: `#899A8D`
- Tertiary text: `#76867A`
- Single accent: `#91C99A`
- Positive sync state: `#91C99A`

## Visual tokens

- Radius rule: 7-8px controls, 10-12px protected surfaces, circular avatar only.
- Shadows: only for modal or protected overlay surfaces, never on every row or card.

## Typography

Use a Windows system sans-serif stack. Headings are short and moderately weighted. Message rows prioritize scanability. User-facing copy names actions directly instead of adding explanatory clutter. The application type scale starts at `1.05` for new installations and is controlled globally from `0.9` to `1.2`; reader UI text composes that value with the independent reader scale from `0.9` to `1.3`.

## Components

- `WindowHeader`: application name and three window controls.
- `AccountList`: connected accounts, provider labels, sync indicators, and an independent scroll region for larger account sets. Account identity popovers render outside the scroll region and stay within the viewport edges so the rail never clips them. The list uses one Tab stop; Arrow Up/Down, Home, and End move focus without switching accounts until the user activates the focused account.
- `SidebarNav`: Inbox, Sent, Spam, and Trash, followed by three optional filters: Unread, Starred, and Attachments. Selecting the active filter clears it, so the default unfiltered view does not need a redundant `All` tab. Navigation remains fixed while the message list scrolls independently. Before the first account is connected, these account-dependent controls stay out of the empty sidebar so disabled UI does not compete with the onboarding action.
- `MailList`: controlled-density rows, never a card grid. Paging stays available below the list without moving the mailbox navigation out of view.
- `MailRow`: sender, subject, preview, time, read state, and a clear selected state. Selection reinforces the row's sender, subject, time, and avatar contrast without introducing a second accent color. Sender identity uses the address when a display name is missing and a visible `?` only when both values are unavailable.
- `MailListEmptyState`: a compact, left-aligned state for an empty mailbox or filter. Its Tabler icon follows the active folder or filter so an empty Inbox, Spam folder, or filtered view is recognizable without adding another control.
- `SenderAvatar`: shared sender logo/initial treatment for the list, search results, and reader metadata; failed remote images reveal the same deterministic initial instead of leaving a blank mark.
- `GlobalSearch`: a header search field with a non-blocking modal result panel. Results are grouped by connected account identity and provider, while selecting a result switches to its account before opening the reader. Opening search dismisses any mail context menu so transient actions never stack over results. The keyboard-highlighted result uses the selected surface and accent edge, while pointer hover remains quieter. The field communicates whether accounts are still loading, unavailable, or ready instead of presenting a silent disabled control.
- `SearchField`: keyboard-accessible search with visible focus.
- `EmptyState`: contextual mailbox onboarding and no-selection guidance with one clear action.
- `Reader`: sticky toolbar and message metadata compact after scroll; only the rendered HTML body uses the centered reading width. Plain text and actions remain left aligned for a predictable workspace edge. On narrow windows, toolbar labels become icon-only while their accessible names remain available.
- Sync status: surfaced through the existing refresh and error states when it carries useful information. Loading rows mirror the final sender-row geometry, including the unread indicator, to avoid a layout shift when messages arrive.
- `Composer`: protected surface for new mail and replies. Opening an inline reply moves the reading column to the composer and places focus in its textarea so the next writing action is immediately available.

## Interaction states

Every primary surface needs loading, empty, error, disabled, and success states. The empty inbox guides the user to connect the first account. Sync errors keep the message list visible when possible and explain the problem in a contextual status row.
The first-account action opens the provider modal directly; account-dependent navigation is withheld until an account is available, while message actions remain disabled until their provider capability is known. A failed account read is shown as an explicit retryable error instead of being presented as an empty account state.
The mailbox header only renders refresh when an account is active, so the no-account state presents one clear connection path instead of a dead action.
Empty mailbox and filter states remain inside the message list, use contextual copy, and do not fabricate message data while a real account has no matching messages.
Disabled primary and destructive actions use the raised surface and muted text tokens instead of retaining their active accent fill, so unavailable actions remain visibly unavailable without changing the active state hierarchy.

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
