# OpenMail Design System

## Design read

OpenMail is a frequently used Windows desktop tool. Its interface is calm, local, and quick to scan: a soft neutral light surface by default, a balanced dark alternative, one green accent, and thin boundaries that keep the mail workspace quiet.

## Direction

OpenMail should feel like a local tool that stays beside the user's work, not a copy of a webmail marketing surface. The default heavy top navigation and colorful card grid are rejected in favor of account context on the left and one focused content surface on the right.

## Layout

- Full-window layout with a custom header, a 64px account rail, and a content area. The shell fills the available Tauri window and does not force a fixed display resolution.
- Header: `OpenMail` on the left; custom minimize, maximize, and close controls on the right.
- Sidebar: accounts are first-class navigation objects. Provider, account identity, and sync state appear together.
- Content: the main workspace owns its folder and filter controls in a full-width header; the body uses a mail list pane on the left and opens the reader in a right pane after a message is selected. Global search remains in the window header.
- Footer: not present in the current shell. Do not reserve empty space for a footer.
- Narrow windows collapse or reduce the sidebar without losing the message workflow. Account onboarding and loading states can take over the reader, while empty mailbox, search, and filter results keep the mailbox navigation available after an account is connected.
- At mobile and intermediate widths, the account rail reduces to a compact 56px column instead of disappearing, preserving account switching and settings access while protecting reader space. When there are no accounts, the rail exposes the same Add account action as the empty reader state.
- Below 1080px, the long localized read-state action keeps its accessible label and tooltip but collapses its visible text to an icon so the toolbar stays within the minimum window width. Below 680px, all reader action labels collapse to icons for the same reason.
- Below 420px, the centered search field reserves a fixed gap after the wordmark and before the window controls so the compact header cannot overlap its own controls.
- Settings exposes a visible back-to-mail control so navigation never dead-ends, including when the account rail is compact.
- Settings content stays left-aligned within a readable 980px maximum width on wide windows; the mail reader keeps its own independent width rules.
- Below 680px, Settings stacks navigation above its content so controls keep usable space, and the mail view becomes a reader-or-list flow instead of squeezing two panes side by side.

## Colors

- Light application background: `#F6F9F7`
- Light sidebar and rail surfaces: `#FFFFFF` and `#EDF3EE`
- Light reader surface: `#F9FBFA`
- Light hover and selected surfaces: `#EFF5F0` and `#E3F0E5`
- Light borders: `#D9E3DB` and `#B8C8BC`
- Light text: `#1F2A23`, `#44534A`, and `#5B6A61`
- Dark application background: `#0F1411`
- Dark sidebar and rail surfaces: `#171E19` and `#141B16`
- Dark reader surface: `#0B100D`
- Dark hover and selected surfaces: `#202B22` and `#253A2A`
- Dark borders: `#29352D` and `#3B4B40`
- Dark text: `#F2F7F3`, `#C1CEC4`, and `#9AA79D`
- Single accent: `#2F7A45` in light mode and `#9AD5A3` in dark mode
- Positive sync state: the active accent token

## Visual tokens

- Radius rule: 4px for compact indicators, 8px controls, 10-12px protected surfaces, and pill only for status/chip controls.
- Spacing rule: a small 4px base rhythm with 8, 12, 16, 20, 24, and 32px steps.
- Shadows: only for modal or protected overlay surfaces, never on every row or card.

## Typography

Use a Windows system sans-serif stack. Headings are short and moderately weighted. Message rows prioritize scanability. User-facing copy names actions directly instead of adding explanatory clutter. The application type scale starts at `1.05` for new installations and is controlled globally from `0.9` to `1.2`; reader UI text composes that value with the independent reader scale from `0.9` to `1.3`.

## Components

- `WindowHeader`: application name and three window controls.
- `AccountList`: connected accounts, provider labels, sync indicators, and an independent scroll region for larger account sets. Account identity popovers render outside the scroll region and stay within the viewport edges so the rail never clips them. The list uses one Tab stop; Arrow Up/Down, Home, and End move focus without switching accounts until the user activates the focused account.
- `MailWorkspaceHeader`: Inbox, Sent, Spam, and Trash, followed by three optional filters: Unread, Starred, and Attachments. Selecting the active filter clears it, so the default unfiltered view does not need a redundant `All` tab. The controls stay above the mail list and reader so mailbox context remains visible on wide screens and becomes a compact stacked toolbar on narrow screens.
- `MailList`: controlled-density rows, never a card grid. On wide screens, a quiet column guide aligns sender, subject, preview, and received time so the list reads like a lightweight table without losing mail-row semantics. The list toolbar shows the current visible message count and keeps bulk action controls visible but disabled until at least one message is selected; provider capability restrictions can keep individual actions disabled. Paging stays available below the list without moving the mailbox navigation out of view.
- `MailRow`: sender, subject, preview, time, read state, attachment indicator, a compact selection mark, and a direct icon-only star control. The selection mark stays visually small inside a 32px pointer target, while star state is communicated through the icon color and fill. The message content button owns `data-mail-id` so Arrow/Home/End navigation returns focus to a focusable element. Sender identity uses the address when a display name is missing and a visible `?` only when both values are unavailable.
- `MailListEmptyState`: a compact, left-aligned state for an empty mailbox or filter. Its Tabler icon follows the active folder or filter so an empty Inbox, Spam folder, or filtered view is recognizable without adding another control.
- `SenderAvatar`: shared sender logo/initial treatment for the list, search results, and reader metadata; failed remote images reveal the same deterministic initial instead of leaving a blank mark.
- `GlobalSearch`: a header search field with a non-blocking modal result panel. Results are grouped by connected account identity and provider, while selecting a result switches to its account before opening the reader. Opening search dismisses any mail context menu so transient actions never stack over results. The keyboard-highlighted result uses the selected surface and accent edge, while pointer hover remains quieter. The field communicates whether accounts are still loading, unavailable, or ready instead of presenting a silent disabled control.
- `SearchField`: keyboard-accessible search with visible focus.
- `EmptyState`: contextual mailbox onboarding and no-selection guidance with one clear action.
- `Reader`: sticky toolbar and message metadata compact after scroll; the header, metadata, body, and thread history share a readable column while the rendered HTML body uses a slightly narrower frame within it. Plain text and actions remain left aligned for a predictable workspace edge. On narrow windows, toolbar labels become icon-only while their accessible names remain available.
- Sync status: surfaced through the existing refresh and error states when it carries useful information. Loading rows mirror the final sender-row geometry, including the unread indicator, to avoid a layout shift when messages arrive.
- `Composer`: protected surface for new mail and replies. Opening an inline reply moves the reading column to the composer and places focus in its textarea so the next writing action is immediately available.
- `AccountChooser`: the Add account dialog presents Gmail and Outlook as two direct action cards. There is no hidden provider tab state; the first provider action receives initial focus and the selected provider reports its connection state.

## Interaction states

Every primary surface needs loading, empty, error, disabled, and success states. The empty inbox guides the user to connect the first account. Sync errors keep the message list visible when possible and explain the problem in a contextual status row.
The first-account action opens the provider chooser directly; account-dependent navigation is withheld until an account is available, while message actions remain disabled until their provider capability is known. A failed account read is shown as an explicit retryable error instead of being presented as an empty account state.
The mailbox header only renders refresh when an account is active, so the no-account state presents one clear connection path instead of a dead action.
Empty mailbox and filter states remain inside the message list, use contextual copy, and do not fabricate message data while a real account has no matching messages.
Disabled primary and destructive actions use the raised surface and muted text tokens instead of retaining their active accent fill, so unavailable actions remain visibly unavailable without changing the active state hierarchy.

## Icon policy

Lucide is not used. Tabler Icons is the shared icon family for interface actions, navigation, settings, and mail state. Provider branding remains in its own SVG assets. Hand-drawn SVG path icons are not allowed.

## Performance and motion

Preserve Tauri's lightweight footprint. Avoid continuous animation, blur, and heavy effects. Motion is limited to modal transitions, sync state changes, and short notification-related transitions. Respect reduced-motion preferences.

## Acceptance criteria

- The first viewport clearly contains OpenMail, the account area, the content title, and window controls.
- The account rail is reserved for account switching and settings; mail content lives in the main workspace.
- Header carries real window controls; no decorative footer zone is added.
- New installations use the light theme; saved user theme choices are preserved.
- The color system uses one accent color in both themes.
- The message list is a scannable row layout, not a card grid.
- Keyboard focus, empty, loading, error, disabled, provider-selection, and responsive states are visible and usable.
- `pnpm lint`, `pnpm build`, `cargo check`, and the Windows Tauri build pass.
