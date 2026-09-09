# Yahoo Mail and AOL Provider Plan

## Scope

Support Yahoo Mail and AOL accounts through the generic IMAP/SMTP adapter first. Consider direct Yahoo Mail OAuth only after Yahoo grants OpenMail developer access to the mail scope.

Status: planned through generic IMAP/SMTP. Direct OAuth: deferred. Priority: P2.

## Provider access options

Yahoo documents IMAP and SMTP settings for third-party mail clients:

```text
IMAP server: imap.mail.yahoo.com
IMAP port: 993
IMAP security: TLS or implicit SSL

SMTP server: smtp.mail.yahoo.com
SMTP port: 465 or 587
SMTP security: TLS or implicit SSL
```

Yahoo's current help documentation instructs users to generate an app password for third-party access. OpenMail must label this credential as an app password and must not ask users to reuse their primary account password when an app password is available. See [Yahoo IMAP server settings](https://help.yahoo.com/kb/SLN4075.html).

Yahoo also documents OAuth-based access to Mail services, but mail access requires developer access and the appropriate mail scope. AOL uses related Yahoo infrastructure but requires its own application credentials for the AOL namespace. See [Yahoo developer access](https://senders.yahooinc.com/developer/developer-access/) and the [Yahoo OAuth guide](https://developer.yahoo.com/oauth2/guide/).

## Authentication plan

### Initial IMAP path

1. Let the user choose Yahoo or AOL in the provider picker.
2. Pre-fill the server profile.
3. Request the mailbox address and an app password.
4. Probe TLS and authenticate with the server's advertised SASL capabilities.
5. Store the app password in Windows Credential Manager under a provider-prefixed account id.
6. Never write the password to `accounts.json`, logs, crash reports, or cache files.

Use OAuth XOAUTH2 only when the provider advertises it and the account has a valid provider token. Do not silently fall back from failed OAuth to password authentication.

### Future native OAuth path

If Yahoo grants OpenMail developer access, add a separate Yahoo OAuth adapter using the approved client id, redirect URI, scopes, and token endpoints. Do not infer these values from the IMAP profile. Keep Yahoo and AOL client registrations separate and make the provider namespace part of the auth state.

## Mail protocol plan

Use the generic IMAP/SMTP plan for mailbox discovery, MIME parsing, local cache, actions, and sync. Yahoo and AOL folder names must not be hardcoded. Discover folders with `LIST`, inspect special-use attributes where advertised, and map Inbox, Sent, Drafts, Trash, and Spam using provider-specific aliases.

The adapter must use UIDs and persist `UIDVALIDITY` for every selected mailbox. It may use `IDLE` for near-real-time updates only when the server advertises the capability. Otherwise it must use bounded polling. See [RFC 9051 IMAP4rev2](https://www.rfc-editor.org/rfc/rfc9051.html) and [RFC 2177 IMAP IDLE](https://www.rfc-editor.org/info/rfc2177/).

Required operations:

- `SELECT` or `EXAMINE` a mailbox.
- `UID SEARCH` for initial and incremental message discovery.
- `UID FETCH` for list metadata and selected full messages.
- `UID STORE` for `\\Seen` and other supported flags.
- `UID MOVE` only after capability detection, with copy and expunge fallback when necessary.
- SMTP submission for new mail and replies after the provider's authentication and TLS capabilities are verified.

## Provider-specific risks

- Folder names and special folders can vary by locale and account configuration.
- Yahoo may require a generated app password even when normal web login succeeds.
- IMAP access can be disabled or rate-limited by the provider.
- OAuth developer access is not part of the initial implementation and must not be represented as supported in the UI.
- Server-side search, labels, conversation threading, and archive semantics may not match Gmail. Advertise only capabilities the adapter can confirm.

## Implementation steps

1. Add Yahoo and AOL server profiles to the generic IMAP provider registry.
2. Add provider-specific app-password instructions and links to the account dialog.
3. Test folder discovery and special-folder mapping with both namespaces.
4. Test initial sync, pagination, IDLE reconnect, polling fallback, and cache recovery.
5. Test read/unread, move, delete, send, and reply operations without assuming Gmail labels.
6. Add direct OAuth only after a Yahoo developer registration is approved and its mail endpoints are verified.

## Acceptance criteria

- Yahoo and AOL accounts connect with an app password over TLS.
- The account setup never stores the credential in account metadata.
- Folder mapping works with localized folder names.
- New messages appear through IDLE when supported and through polling otherwise.
- A dropped IMAP connection reconnects without duplicating cached messages.
- Unsupported Gmail-only actions are disabled instead of failing after the click.
- Direct OAuth is not shown until the required Yahoo developer access exists.

## Official sources

- [Yahoo IMAP server settings](https://help.yahoo.com/kb/SLN4075.html)
- [Yahoo third-party mail download and IMAP guidance](https://help.yahoo.com/kb/new-yahoo-mail/download-email-yahoo-mail-third-party-sln28681.html)
- [Yahoo Mail developer access](https://senders.yahooinc.com/developer/developer-access/)
- [Yahoo OAuth 2.0 guide](https://developer.yahoo.com/oauth2/guide/)
- [IMAP4rev2](https://www.rfc-editor.org/rfc/rfc9051.html)
- [IMAP IDLE](https://www.rfc-editor.org/info/rfc2177/)
