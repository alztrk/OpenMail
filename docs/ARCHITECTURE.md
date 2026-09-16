# Architecture

## Goals

OpenMail is a local-first Windows application with a small runtime footprint. Provider access, local persistence, synchronization, and presentation are separate concerns.

## Layers

```text
React UI
  -> Tauri commands and events
    -> Rust application services
      -> Provider adapters (Gmail, Microsoft Graph)
      -> Encrypted local JSON cache
      -> Windows credential store
      -> Windows notification and tray integration
```

## Provider boundary

Each provider is expected to implement the same application-facing operations: authorize, list changes, fetch a message, send a message, update message state, and move a message. The current implementation provides Gmail and Microsoft Graph mail and authorization adapters. Provider-specific identifiers and payloads do not leak into React components.

Provider research and implementation plans are maintained in [docs/providers](providers/README.md). Native API providers and generic IMAP/SMTP providers must remain separate adapters behind the same boundary. A provider plan is not evidence that the integration is implemented or verified in a release.

System folders use the shared `MailFolder` model and message mutations use the
shared `MessageAction` model. The adapter maps them to provider-specific
labels, folder ids, flags, and endpoints. The UI can query the adapter's
capability set through `get_provider_capabilities` before enabling an action.

## Current authentication flow

The React account dialog invokes the provider-neutral `start_auth` Tauri command with either `gmail` or `outlook`. Rust resolves the selected authorization adapter, verifies that the required provider credentials are present in Windows Credential Manager, creates a loopback listener on an available local port, generates a CSRF state and PKCE verifier, and opens the system browser. The callback is validated before the authorization code is exchanged for tokens. Gmail uses a desktop OAuth client ID and secret; Microsoft Graph uses a public client ID and never uses a client secret. The provider profile becomes the local account metadata. Windows notifications are sent through a native toast bridge so the explicit Open mail action can return a one-time local destination key to the running frontend; account addresses and message identifiers are never included in the OS payload.

Refresh tokens and the local storage encryption key are stored in Windows Credential Manager through the `keyring` crate. Account metadata is stored in an encrypted `accounts.json` below the Tauri application data directory. OpenMail does not send credentials or mail content to an OpenMail service.

The current Gmail scopes are `gmail.modify` for mailbox actions and `gmail.send` for compose and reply delivery. Microsoft Graph requests `openid profile email User.Read Mail.ReadWrite Mail.Send offline_access`. Refresh-token use, local message persistence, and account reauthorization from the Accounts settings page are implemented for both adapters.

## Synchronization

OpenMail stores the Inbox page and provider sync cursor in an authenticated encrypted per-account JSON cache. Loaded folder pages for Spam, Sent, Trash, and Starred are stored in separate per-account cache scopes, so reopening a folder can render local data immediately. Previously loaded conversation messages can be restored from all matching cache scopes before the network refresh. Gmail synchronization uses the Gmail History API to apply additions, label changes, and deletions without downloading the entire Inbox again. Microsoft Graph synchronization uses a persisted delta cursor when available and falls back to a bounded initial delta import when it is not. The frontend renders cached messages immediately and refreshes them periodically while the mail view is open. New messages trigger a Windows notification when the user has enabled desktop notifications and is outside quiet hours.
Global search scans all locally cached scopes for an immediate first result, then refreshes every connected account concurrently. Provider results are stored in query-specific scopes and limited to the 20 most recently created scopes per account, preventing unbounded growth while preserving the Inbox and folder caches.

Cache writes use authenticated encryption, a temporary file, and a replacement with a recoverable encrypted backup, so an interrupted write does not leave a partially serialized message cache. Legacy plaintext cache files are migrated on first read without discarding messages. Metadata synchronization preserves full message bodies, inline images, and attachment metadata already fetched for a cached message.

Provider operations that read or mutate an account mailbox are serialized per account from the provider request through the related cache write. This prevents an older synchronization result from overwriting a newer message action while allowing independent accounts to continue concurrently. Outlook conversation reads request full HTML bodies and hydrate messages with attachments before the reader renders them.

The Windows shell provides a tray icon with show and quit actions. The Tauri single-instance plugin prevents a second OpenMail process and focuses the existing main window when the executable is launched again. The UI applies the user's minimize-to-tray and close-to-tray preferences to the window events. Launch-at-startup is stored in the current user's Windows Run key and does not require administrator access.

Selected messages are fetched in full only when needed. Their HTML body is sanitized in the renderer, `cid:` inline images are resolved through the Gmail attachment endpoint, and regular attachments can be downloaded to the Windows Downloads directory. Provider-loaded compose HTML is sanitized before it enters the editor state or is sent back to a provider. Reply and compose delivery stays behind the provider adapter: Gmail sends UTF-8 MIME through `messages.send`, while Microsoft Graph creates and sends a draft with its message APIs.

## Security boundary

Provider tokens and the local storage encryption key stay in the Windows secure credential store. Encrypted mail content stays in the local application data directory. Provider HTML is treated as untrusted content and requires sanitization before rendering.

## Performance rules

- Prefer incremental provider history APIs over full mailbox scans.
- Keep blocking network and database work outside the UI thread.
- Batch initial imports and render visible rows first.
- Avoid continuous animations and unnecessary background polling.
- Keep attachment downloads on demand unless the user requests local availability.
