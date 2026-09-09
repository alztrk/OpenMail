# Generic IMAP and SMTP Provider Plan

## Scope

Implement one standards-based adapter for providers that expose IMAP for mailbox access and SMTP submission for sending. This adapter should cover Yahoo, AOL, iCloud, GMX, mail.com, compatible business mailboxes, custom domains, and self-hosted servers such as Dovecot or mailcow.

Status: planned. Priority: P1 after Microsoft Graph.

## Why this adapter matters

IMAP4rev2 provides mailbox and message operations, offline resynchronization, flags, search, selective fetch, and message body access. It does not send mail; SMTP submission is a separate protocol. IMAP IDLE can provide near-real-time mailbox updates when a server advertises the capability, with polling as the required fallback. See [RFC 9051 IMAP4rev2](https://www.rfc-editor.org/rfc/rfc9051.html), [RFC 2177 IMAP IDLE](https://www.rfc-editor.org/info/rfc2177/), and [RFC 4954 SMTP AUTH](https://www.rfc-editor.org/info/rfc4954/).

## Account profile

The account form must support both presets and custom values:

- Display name.
- Email address.
- IMAP host.
- IMAP port.
- IMAP security: implicit TLS, STARTTLS, or disabled only for explicitly local test servers.
- SMTP host.
- SMTP port.
- SMTP security: implicit TLS or STARTTLS.
- Authentication method: app password, OAuth XOAUTH2, or provider-specific credential.
- Username, defaulting to the full email address.
- Optional folder namespace or root path.

The MVP should prefer OAuth or app passwords. Supporting a user's primary mailbox password would conflict with OpenMail's current no-mailbox-password product principle and must be an explicit product decision. If custom self-hosted servers require a primary password, the account dialog must explain that limitation before saving it.

## Authentication plan

At connection time:

1. Open a TLS connection to the configured IMAP server.
2. Issue `CAPABILITY`.
3. Select the strongest compatible authentication mechanism supported by the provider and configured by the user.
4. Refuse cleartext authentication on a non-TLS connection.
5. Verify the account identity with `LIST` and a safe mailbox status request.
6. Probe SMTP independently.
7. Save credentials only in Windows Credential Manager.

Support XOAUTH2 as an authentication mechanism, but keep provider authorization outside this adapter. Gmail, Yahoo, Zoho, and other providers may have different OAuth endpoints and scopes. The provider adapter must deliver a token to the generic protocol layer rather than making the IMAP layer responsible for OAuth registration.

## Mailbox sync plan

### Discovery

- Use `LIST` to discover mailboxes.
- Prefer `SPECIAL-USE` attributes when available.
- Map Inbox, Sent, Drafts, Trash, and Spam from discovered attributes and provider aliases.
- Preserve custom folders using opaque provider mailbox names.

### Initial sync

- Select the target mailbox.
- Read `UIDVALIDITY` and `UIDNEXT`.
- Fetch only list fields for the first page.
- Fetch more pages on demand.
- Store `UIDVALIDITY`, highest synchronized UID, and the server capability set per mailbox.

### Incremental sync

- Use `UID SEARCH` and `UID FETCH` from the saved UID boundary.
- Use `UID STORE` for flags and `UID MOVE` when advertised.
- Use `IDLE` for near-real-time notifications when the capability exists.
- Send `DONE`, refresh the mailbox state, and restart IDLE before provider inactivity limits are reached.
- Fall back to bounded polling when IDLE is unavailable or fails repeatedly.
- If `UIDVALIDITY` changes, invalidate only that mailbox cursor and perform a fresh mailbox sync.

### Message content

Parse MIME parts with a dedicated Rust MIME parser. Select the best HTML or plain-text alternative, preserve inline `Content-ID` references, and expose attachments lazily. Sanitize HTML in the existing renderer before displaying it. Never treat a provider preview as the complete message body.

## Actions

Map the shared actions to protocol capabilities:

- Mark read or unread: `UID STORE` with `\\Seen`.
- Star or unstar: provider-supported flags such as `\\Flagged`.
- Archive: move to a discovered archive or All Mail mailbox when available.
- Delete: move to Trash when available; only expunge permanently after an explicit user action.
- Move: `UID MOVE`, or `COPY` plus `STORE \\Deleted` and `EXPUNGE` only when the provider requires it.
- Send: SMTP submission with TLS and SMTP AUTH.
- Reply: construct a standards-compliant MIME message with `In-Reply-To` and `References` headers.

Do not enable an action solely because the UI has a button. Query capabilities and provider folder mappings first.

## Error handling

- TLS errors: block saving and show a connection diagnosis.
- Authentication errors: distinguish invalid credentials, expired app password, and rejected OAuth token.
- `NO` or `BAD` command responses: preserve the raw provider code in logs without recording message content or credentials.
- IDLE disconnect: reconnect and resume from the last verified UID.
- SMTP failure: keep the account receive-only and preserve the composed draft locally if draft support is implemented.
- Large or malformed MIME: show a readable fallback while preserving the raw message in the local cache only if the user has enabled that behavior.

## Provider presets

Presets are configuration data, not separate adapters. Each preset must be verified against the provider's current official documentation before release. The first preset candidates are:

- Yahoo Mail and AOL.
- iCloud Mail.
- GMX.
- mail.com.
- Custom IMAP/SMTP.
- Proton Mail Bridge.

GMX documents IMAP and SMTP access through third-party clients at [GMX third-party email applications](https://support.gmx.com/pop-imap/index.html). mail.com documents IMAP and SMTP synchronization at [mail.com IMAP and SMTP](https://support.mail.com/premium/imap/imap.html).

## Implementation steps

1. Select and test a maintained Rust IMAP/MIME implementation compatible with the current Tokio and Rust versions before adding dependencies.
2. Define provider-neutral connection, capability, folder, cursor, message, and SMTP error types.
3. Implement TLS connection and capability negotiation.
4. Implement auth mechanisms, folder discovery, UID-based paging, and MIME parsing.
5. Implement cache merge, UIDVALIDITY recovery, IDLE lifecycle, and polling fallback.
6. Implement read state, flags, move, archive, trash, send, and reply based on capabilities.
7. Add provider presets and localized setup instructions one provider at a time.
8. Add integration tests with a local test mail server and manual tests against each supported provider.

## Acceptance criteria

- One generic adapter can connect to at least one Yahoo or AOL account, one iCloud account, one GMX or mail.com account, and one custom IMAP server.
- The adapter never assumes Gmail label ids or folder names.
- Initial sync, pagination, cache restore, IDLE, polling, reconnect, and UIDVALIDITY reset work without duplicates.
- HTML, plain text, inline images, and attachments are rendered safely.
- Read/unread, star, move, archive, delete, send, and reply are capability-gated.
- Credentials remain in Windows Credential Manager and are absent from logs and JSON metadata.
- A receive-only account is represented honestly when SMTP is unavailable.
