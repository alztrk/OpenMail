# Microsoft Graph Provider Plan

## Scope

Support Outlook.com, Hotmail, Live, and Microsoft 365 mailboxes through Microsoft Graph. One adapter covers both personal Microsoft accounts and work or school accounts.

Status: implemented in the Rust adapter. Initial release requires a Microsoft Entra public client ID in the runtime `.env` file or build environment. Live-provider and portable-release verification remain release checks. Priority: P1.

## Provider capabilities

Microsoft Graph represents messages inside mail folders and provides delegated access for the signed-in user. The OpenMail surface is:

- List folders and messages.
- Read full text or HTML message bodies and attachments.
- Mark read or unread.
- Move messages to archive, deleted items, junk, or another folder.
- Send new mail and replies.
- Preserve a local cache using message delta synchronization.

Graph supports personal Microsoft accounts and organizational accounts. Delegated `Mail.ReadWrite` and `Mail.Send` permissions are available for personal accounts as well as work or school accounts. See the [Outlook mail API overview](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0) and [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).

## Authentication plan

Use the system browser and the authorization code flow with PKCE S256. Register the application as a mobile and desktop application in Microsoft Entra ID. Use the `common` tenant so personal Microsoft accounts and organizational accounts can sign in.

Authorization endpoint:

```text
https://login.microsoftonline.com/common/oauth2/v2.0/authorize
```

Token endpoint:

```text
https://login.microsoftonline.com/common/oauth2/v2.0/token
```

Initial delegated scopes:

```text
openid profile email User.Read Mail.ReadWrite Mail.Send offline_access
```

The desktop application uses a public client id. Do not add a client secret to the OpenMail binary or source configuration. Microsoft documents that client secrets are not needed for public native clients. See [Get access on behalf of a user](https://learn.microsoft.com/en-us/graph/auth-v2-user) and [Register an application](https://learn.microsoft.com/en-us/graph/auth-register-app-v2).

OpenMail reads the public client ID from `OPENMAIL_MICROSOFT_CLIENT_ID` in the
runtime `.env` file when available, with the build-time environment as a
fallback. This is an application identifier, not a client secret. The existing
Gmail credential configuration is independent and is not changed by this
provider.

For the Entra app registration, add a mobile and desktop redirect URI for `http://localhost`. The adapter binds an available loopback port and sends the same `http://localhost:{port}/oauth2/callback` shape during authorization. Do not add a client secret to this application registration or to a build environment.

The Rust auth adapter must:

1. Bind an available loopback port.
2. Create a cryptographically random state and PKCE verifier.
3. Open the system browser with the provider-specific redirect URI.
4. Validate state, redirect host, and the one-time authorization code.
5. Exchange the code without a client secret.
6. Load `/v1.0/me` and derive a stable local account id.
7. Store the refresh token in Windows Credential Manager.

Refresh-token rotation and invalid-grant responses must replace the stored token when a new token is returned. Reauthorization must be available from the Accounts page.

## API surface

Use the v1.0 Graph API only for the first implementation. The current adapter uses immutable Graph IDs, lazy full-message loading, and draft-then-send for compose and reply so the sent message identifier can be cached locally.

```text
GET   /v1.0/me
GET   /v1.0/me/mailFolders
GET   /v1.0/me/mailFolders/{folderId}/messages
GET   /v1.0/me/messages/{messageId}
GET   /v1.0/me/messages/{messageId}/attachments
PATCH /v1.0/me/messages/{messageId}
POST  /v1.0/me/messages/{messageId}/move
POST  /v1.0/me/messages/{messageId}/attachments
POST  /v1.0/me/messages/{messageId}/attachments/createUploadSession
DELETE /v1.0/me/messages/{messageId}/attachments/{attachmentId}
POST  /v1.0/me/messages/{messageId}/send
GET   /v1.0/me/mailFolders/{folderId}/messages/delta
```

Use `$select` for list rows and fetch the full body only for the selected message. Request HTML bodies where available and preserve the original content type. Compose creates a draft, adds direct attachments or uploads large attachments through an upload session, and sends the completed draft. Use the documented move and message update operations for archive, delete, and read state changes. See [list messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0), [update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0), [move message](https://learn.microsoft.com/en-us/graph/api/message-move?view=graph-rest-1.0), [file attachments](https://learn.microsoft.com/en-us/graph/api/resources/fileattachment?view=graph-rest-1.0), and [large file attachments](https://learn.microsoft.com/en-us/graph/outlook-large-attachments).

## Sync and cache plan

Graph delta is a per-folder operation. The initial sync should enumerate the mailbox folders, then run a full delta round for Inbox and the folders OpenMail exposes. Persist the returned `@odata.nextLink` while a round is incomplete and persist `@odata.deltaLink` when the round finishes.

The adapter initializes and persists the Microsoft Graph Inbox delta link in the local message cache. Subsequent syncs follow the provider-issued delta cursor and apply changed and removed message entries without refreshing the complete Inbox. If Graph invalidates an old cursor, the adapter starts a fresh delta round and keeps the existing cache until that round succeeds.

- Reuse the saved delta link for each folder.
- Apply additions, updates, and deletions transactionally to the local cache.
- Fetch full message content lazily when the user opens a message.
- Refresh the visible folder immediately after a user action.
- Poll while the app or tray service is active because Graph change notifications require a reachable notification URL and OpenMail has no backend.

Outlook attachments up to 150 MB per compose are supported. Files below 3 MB are sent with the regular file-attachment endpoint. Larger files use Graph's resumable upload-session endpoint in chunks below 4 MB, retry transient chunk failures up to a bounded attempt limit, and use the pre-authenticated upload URL without forwarding the Graph bearer token. The 150 MB cap is an OpenMail memory and request-safety limit for one compose operation.

The adapter must verify whether the selected Graph id remains stable after a move. If the default id changes, use Graph's immutable id support or store a provider-native id mapping before finalizing the cache contract. Do not silently treat a new id as a new message.

## Error and capability handling

- `401`: refresh the access token once and retry read requests once; mutation requests are not replayed because the provider may have accepted the original request before returning the error. Expose a reconnect state when the retry still fails.
- `403`: expose missing delegated permission or organization consent, not a generic network error.
- `404`: invalidate the local message or folder reference and run a targeted delta refresh.
- `410` or `InvalidDeltaToken`: discard the stale cursor and start a fresh delta round without treating existing cached mail as lost.
- `429`: honor `Retry-After` and keep the cached view visible.
- `5xx` and transport errors: retain cache and show sync status; do not replace a usable cached view with partial or fabricated data.
- Unsupported shared mailboxes: keep them outside the initial scope unless the required shared permissions are explicitly implemented.

## Implementation steps

1. Persist Graph delta cursors for folders beyond Inbox and merge delta additions, updates, and deletions transactionally.
2. Extract the shared loopback OAuth and PKCE flow while keeping provider endpoints and scopes in each adapter.
3. Graph throttling handling and the dedicated reconnect state for revoked refresh tokens are implemented.
4. Add localized provider setup, permission, throttling, attachment-limit, and offline messages.
5. Add integration tests using recorded redacted fixtures and a manual test matrix with a personal and a work account.

## Acceptance criteria

- A personal Outlook.com or Hotmail account can authorize without a client secret when the public client ID is configured in the runtime `.env` file or at build time.
- A Microsoft 365 account can authorize when tenant consent permits the delegated scopes.
- The Inbox renders from cache before the refresh completes.
- The Inbox adapter uses a persisted Graph delta cursor and applies additions, updates, and removals incrementally. Invalid cursors trigger a fresh round, and read throttling honors `Retry-After` with one bounded retry. Portable-release and live-provider verification remain release-hardening work.
- HTML bodies, plain text bodies, and attachments render correctly.
- Outlook compose uploads direct attachments and 3 MB to 150 MB attachments through upload sessions before sending the draft.
- Read/unread, move, delete, send, and reply update both the provider and local cache.
- Token expiration, missing consent, throttling, invalid cursors, and offline mode have distinct recoverable states.

## Official sources

- [Microsoft Graph delegated access](https://learn.microsoft.com/en-us/graph/auth-v2-user)
- [Register a Microsoft identity platform application](https://learn.microsoft.com/en-us/graph/auth-register-app-v2)
- [Outlook mail API overview](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0)
- [Message delta query](https://learn.microsoft.com/en-us/graph/delta-query-messages)
- [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
