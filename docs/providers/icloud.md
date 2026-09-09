# iCloud Mail Provider Plan

## Scope

Support iCloud Mail through the generic IMAP/SMTP adapter using an Apple app-specific password. Do not make Apple Account OAuth a prerequisite for the first implementation.

Status: planned through generic IMAP/SMTP. Priority: P2.

## Official connection profile

Apple documents the following settings for third-party mail clients:

```text
IMAP server: imap.mail.me.com
IMAP port: 993
IMAP security: TLS or implicit SSL

SMTP server: smtp.mail.me.com
SMTP port: 587
SMTP security: TLS or STARTTLS
SMTP authentication: required
```

iCloud Mail does not support POP. Apple documents an app-specific password for the IMAP and SMTP password fields. The IMAP username is usually the local part of the iCloud address, while SMTP uses the full iCloud address. The adapter must allow both username forms because Apple documents the full address as a fallback. See [iCloud Mail server settings](https://support.apple.com/en-euro/102525).

## Authentication and account setup

1. Let the user choose iCloud Mail in the provider picker.
2. Explain that two-factor authentication must be enabled on the Apple Account before an app-specific password can be generated.
3. Link to Apple's app-specific password instructions.
4. Ask for the iCloud address and app-specific password.
5. Probe the IMAP connection with TLS before saving the account.
6. Probe SMTP authentication separately so receive-only accounts do not appear to support sending when SMTP is unavailable.
7. Store the app-specific password in Windows Credential Manager only.

Apple also supports direct authorization in some supported third-party applications. That flow is not assumed to be available to an independent OpenMail client, so it should remain a later research item rather than a hidden fallback. See [Apple third-party app authorization](https://support.apple.com/en-us/121539).

## Mail protocol and data plan

Use the generic IMAP/SMTP adapter for:

- Folder discovery with `LIST`.
- Folder selection and message metadata fetch.
- MIME body and attachment parsing.
- Read/unread flags.
- Move and delete operations when the server advertises the required capabilities.
- SMTP submission for compose and reply.

Persist `UIDVALIDITY` and the highest synchronized UID per folder. Use `UID FETCH` for incremental message metadata. Use `IDLE` when advertised and fall back to polling when it is not. The implementation must obey [RFC 9051](https://www.rfc-editor.org/rfc/rfc9051.html) and [RFC 2177](https://www.rfc-editor.org/info/rfc2177/).

The provider adapter must map Apple folder names through discovered folder attributes instead of assuming an English name. The local account id should contain an `icloud` provider prefix and a normalized email address, while credentials remain separate in the secure store.

## Error handling

- TLS or certificate failure: show a connection error and do not save the account.
- Authentication failure: explain that an app-specific password is required rather than displaying a generic invalid-password error.
- IMAP succeeds but SMTP fails: show the account as receive-only and keep send actions disabled until fixed.
- `UIDVALIDITY` changes: discard only the affected folder cursor and resynchronize that folder.
- Connection loss: keep cached mail visible and reconnect with bounded backoff.

## Implementation steps

1. Add the iCloud preset to the generic IMAP provider registry.
2. Add localized app-password setup guidance and the Apple help link.
3. Implement username fallback for the IMAP probe.
4. Test folder discovery, MIME rendering, attachments, flags, move, delete, compose, and reply.
5. Test expired or revoked app-specific passwords and manual reconnect.
6. Verify that POP is never offered in the OpenMail account form.

## Acceptance criteria

- A valid iCloud app-specific password connects over TLS.
- The account dialog clearly distinguishes the app-specific password from the Apple Account password.
- Incoming mail syncs and caches locally without POP.
- SMTP capability is detected independently from IMAP.
- Local cache survives a temporary Bridge-like connection loss and resumes without duplicates.
- Provider-specific folder names do not break Inbox, Sent, Trash, or Spam mapping.

## Official sources

- [iCloud Mail server settings](https://support.apple.com/en-euro/102525)
- [Apple app-specific passwords](https://support.apple.com/en-us/102654)
- [Apple third-party app authorization](https://support.apple.com/en-us/121539)
- [IMAP4rev2](https://www.rfc-editor.org/rfc/rfc9051.html)
- [IMAP IDLE](https://www.rfc-editor.org/info/rfc2177/)
