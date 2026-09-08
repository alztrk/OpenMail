# Architecture

## Goals

OpenMail is a local-first Windows application with a small runtime footprint. Provider access, local persistence, synchronization, and presentation are separate concerns.

## Layers

```text
React UI
  -> Tauri commands and events
    -> Rust application services
      -> Provider adapters (Gmail, Microsoft Graph)
      -> Local JSON cache
      -> Windows credential store
      -> Windows notification and tray integration
```

## Provider boundary

Each provider is expected to implement the same application-facing operations: authorize, list changes, fetch a message, send a message, update message state, and move a message. The current implementation provides the Gmail adapter; Microsoft Graph is not implemented yet. Provider-specific identifiers and payloads do not leak into React components.

## Current authentication flow

The first provider implementation is Gmail desktop OAuth. The React account dialog invokes the `start_gmail_auth` Tauri command. Rust creates a loopback listener on an available local port, generates a CSRF state and PKCE verifier, and opens the system browser. The callback is validated before the authorization code is exchanged for tokens. The Gmail profile address becomes the local account identifier. Windows notifications open normally, but notification action callbacks are not used because the desktop notification backend does not expose them.

Refresh tokens are stored in Windows Credential Manager through the `keyring` crate. Account metadata is stored in `accounts.json` below the Tauri application data directory. OpenMail does not send credentials or mail content to an OpenMail service.

The current scopes are `gmail.modify` for mailbox actions and `gmail.send` for compose and reply delivery. Refresh-token use, local message persistence, and Gmail reauthorization from the Accounts settings page are implemented for Gmail.

## Synchronization

OpenMail stores the Inbox page and Gmail `historyId` in a per-account JSON cache. Loaded folder pages for Spam, Sent, Trash, and Starred are stored in separate per-account cache scopes, so reopening a folder can render local data immediately. Previously loaded conversation messages can be restored from all matching cache scopes before the network refresh. Background synchronization uses the Gmail History API to apply additions, label changes, and deletions without downloading the entire Inbox again. The frontend renders cached messages immediately and refreshes them periodically while the mail view is open. New messages trigger a Windows notification when the user has enabled desktop notifications and is outside quiet hours.
Search results are stored in query-specific scopes and limited to the 20 most recently created scopes per account, preventing unbounded growth while preserving the Inbox and folder caches.

Cache writes use a temporary file followed by a replacement with a recoverable backup, so an interrupted write does not leave a partially serialized message cache. Metadata synchronization preserves full message bodies, inline images, and attachment metadata already fetched for a cached message.

The Windows shell provides a tray icon with show and quit actions. The UI applies the user's minimize-to-tray and close-to-tray preferences to the window events. Launch-at-startup is stored in the current user's Windows Run key and does not require administrator access.

Selected messages are fetched in full only when needed. Their HTML body is sanitized in the renderer, `cid:` inline images are resolved through the Gmail attachment endpoint, and regular attachments can be downloaded to the Windows Downloads directory. Reply composition sends a UTF-8 MIME message through Gmail's `messages.send` endpoint.

## Security boundary

Provider tokens stay in the Windows secure credential store. Mail content stays in the local application data directory. Provider HTML is treated as untrusted content and requires sanitization before rendering.

## Performance rules

- Prefer incremental provider history APIs over full mailbox scans.
- Keep blocking network and database work outside the UI thread.
- Batch initial imports and render visible rows first.
- Avoid continuous animations and unnecessary background polling.
- Keep attachment downloads on demand unless the user requests local availability.
