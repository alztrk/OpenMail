# Changelog

All notable changes to OpenMail are recorded here.

## Unreleased

### Added

- Microsoft Graph Inbox synchronization now persists and follows delta cursors, including provider-reported message removals.
- Gmail and Microsoft provider errors now expose distinct reconnect, permission, rate-limit, and temporary-service states.
- Provider recovery error contracts now have regression coverage for HTTP and OAuth failure categories.
- Gmail and Microsoft mailbox reads use a single bounded `Retry-After` retry without retrying message mutations.
- Gmail metadata failures no longer prevent successfully loaded messages from appearing in the mailbox.
- Reader hydration no longer resets the main reading surface scroll position.
- Single-instance Windows startup now focuses the existing OpenMail window instead of opening a second process.
- Global search now opens a compact result surface with one clear hierarchy, provider-aware account identity, and no repeated query or scope chrome.
- Global search now checks local mailbox cache while provider requests run concurrently, and Gmail search no longer waits for an unrelated history cursor request.
- Product and design system documentation.
- Tauri 2 Windows application shell.
- Initial local-first bilingual interface in English and Turkish.
- Tailwind CSS v4 and shadcn configuration.
- Project usage, contribution, security, privacy, architecture, and release documentation.
- Gmail OAuth with PKCE, local message caching, paging, and background synchronization.
- Gmail send permission is requested explicitly for compose and reply delivery.
- Sanitized HTML mail rendering with inline image hydration and plain-text whitespace preservation.
- HTML mail frames now wait for populated documents before measuring and normalize the frame canvas without overriding email-owned layout styles.
- HTML mail sanitization now preserves common email table layout attributes while explicitly forbidding active form and embedded content.
- Reader support sections stay left-aligned while only the rendered message body uses the centered reading column.
- Plain-text, empty-content, loading, and error reader states now keep the left reading alignment instead of moving when HTML content is unavailable.
- Sticky reader metadata now uses a tighter vertical rhythm so more of the message body remains visible while reading.
- Reader metadata now compacts after scrolling, keeping the selected message context visible without crowding the reading surface.
- Reader delete action now stays visually quiet until it receives focus or hover, preserving the reader's calm action hierarchy.
- Mailbox filters now use a restrained segmented control, while the active folder uses the same accent edge for a consistent selection language.
- Mailbox filters now expose single-selection semantics and keyboard navigation for assistive technology users.
- Mailbox navigation now remains fixed while the message list scrolls independently, keeping folders, filters, and paging controls reachable during triage.
- Narrow layouts now keep account onboarding and loading reader states visible, while empty mailbox, search, and filter results keep navigation available.
- Narrow layouts now retain a compact account rail so account switching and settings remain reachable.
- Theme-aware scrollbars and native form control color schemes now keep light and dark surfaces visually consistent.
- Mail context menus now support complete keyboard navigation with arrow, Home, End, and Escape keys.
- Mail row accessibility names now announce unread state directly instead of relying on a decorative status dot.
- Gmail synchronization logs now include completed message counts, new-message counts, and elapsed time.
- Background synchronization now preserves previously cached paging results instead of replacing them with the current page.
- Persisted settings are now validated and normalized on startup so malformed local values cannot break the interface.
- Gmail mail actions, provider-aware context menus, desktop notifications, and portable Windows release output.
- Search loading states and localized empty-subject handling.
- Gmail conversation threads load all messages in order and preserve them in the local message cache.
- Gmail MIME body parsing accepts charset and other parameters, keeping rich HTML messages from falling back to plain text.
- Gmail MIME decoding accepts whitespace-separated and standard base64 payloads, including URL-encoded inline image IDs.
- MIME body selection ignores HTML and plain-text parts explicitly marked as attachments.
- MIME parser coverage now includes nested related bodies and attachment-backed HTML parts.
- MIME body selection now prefers the most complete valid HTML or plain-text part when a message contains multiple alternatives.
- HTML mail frame resizing no longer collapses the reader to 1px, preventing scroll position jumps while reading.
- RFC 2047 encoded subjects and sender display names are decoded before rendering.
- Compose supports optional Cc and Bcc recipients with validation and draft persistence.
- Compose recipients use reusable keyboard-friendly chips with individual removal.
- Background synchronization adapts its polling interval to the app visibility state.
- Authentication failures from sync, mailbox loading, actions, and compose flows are normalized before they reach user-facing notifications.
- Search results are cached per account and query, including additional paging pages.
- Gmail network requests use explicit connection and request timeouts so a stalled provider response cannot leave the mailbox UI waiting indefinitely.
- Gmail token refresh errors now distinguish expired authorization from invalid or deleted OAuth clients without exposing token response contents.
- Gmail message action errors now expose permission failures separately, so a failed automatic read update does not obscure message loading.
- Message selection now loads uncached mail content before attempting the automatic read-state update.
- Confirmed window close requests now have the required Tauri destroy permission and close the application after confirmation.
- Gmail diagnostics record operation durations and item counts without logging message content or identifiers.
- Settings controls are now semantically associated with their visible labels for keyboard and assistive technology users.
- Narrow settings layouts now provide an explicit path back to the mailbox, and initial mailbox loading exposes an accurate status label.
- Folder refreshes preserve already loaded message bodies, HTML, avatars, and attachments.
- Mail bodies detect text direction automatically for mixed-language and right-to-left messages.
- The custom window header now reflects the actual maximized state on startup.
- Conversation cache updates now persist all hydrated messages in one disk transaction.
- The message cache now retains the previous valid JSON file as a recoverable backup after successful writes.
- Conversation messages are hydrated concurrently while preserving Gmail's original message order.
- Multiple MIME body attachments within one Gmail message are hydrated concurrently.
- Inline image attachment hydration now runs concurrently within each message.
- Account icons expose idle, syncing, and error states without adding another control to the sidebar.
- Account navigation now scrolls independently when many accounts are connected, while identity popovers render outside the rail overflow boundary and stay inside the viewport edges.
- Global search now lives in the window header and searches every connected account concurrently, showing provider-aware results in a keyboard-navigable modal panel.
- Search cache isolation is covered by a Rust regression test.
- A corrupted primary message cache now recovers from its valid backup.
- Cached message bodies now remain visible while conversation details refresh in the background.
- Previously opened conversations are restored from the local cache before a network refresh.
- Sanitized HTML bodies are memoized so unrelated reader actions do not reprocess large messages.
- Folder and search refreshes now retain already loaded message details while replacing metadata.
- Search cache keeps at most 20 query scopes per account to keep local storage bounded.
- Background thread refresh failures no longer replace valid cached content with an error state.
- Shared dialogs now manage initial focus, keyboard focus trapping, Escape close, and focus restoration.
- The reader now exposes its busy state while a selected message body is loading.
- Reconnecting an existing Gmail account now passes its address as an OAuth login hint.
- Remove the unsupported Windows notification action listener path that caused a startup IPC error.
- System theme now follows Windows appearance changes while OpenMail is running.
- Settings controls now expose accessible names, and quiet hours use the shared switch component.
- Empty conversation errors now use localized recovery copy, and the settings navigation panel keeps horizontal overflow suppressed.
- Account, folder, filter, and settings navigation semantics now expose their active context more clearly to assistive technology.
- Reader font scaling now applies consistently to plain-text and sanitized HTML message bodies, including conversation history.
- Product and design records now document Tabler Icons as the shared interface icon family.
- Added a reduced-motion policy for users whose Windows accessibility settings request less animation.
- Sender avatars in the mailbox now load lazily to reduce initial network work on large message lists.
- Sender avatar requests now omit the referrer header.
- Added a Ctrl+K/Cmd+K shortcut that focuses and selects the mailbox search field.
- Exposed the mailbox search shortcut through the field's accessibility metadata.
- Quiet-hours time fields now use the shared input component for consistent focus and styling behavior.
- Compose and reply fields now share a reusable textarea component.
- Light theme now applies its palette to shared select, textarea, and switch controls.
- Light-theme compose textarea styling now has explicit cascade priority over its shared base rule.
- Compose subject inputs now use the shared dark and light theme form styling instead of browser defaults.
- The custom window header now supports double-clicking its drag area to maximize or restore the window.
- Settings account authorization failures are now surfaced instead of being silently discarded.
- Fixed light-theme contrast for the Settings page heading.
- Settings and provider tabs now support roving focus and arrow-key navigation.
- Settings and provider tabs now expose explicit tab-to-panel relationships.
- Mail context menus now focus the first available action and return focus to the originating mail row when dismissed.
- Leaving the reader with Back or Escape now returns keyboard focus to the previously selected mail row.

### Planned

- Outlook provider support.
- Compose and reply delivery improvements beyond the current Gmail text flow.

## 0.1.0 - 2026-09-06

Initial public development baseline.
