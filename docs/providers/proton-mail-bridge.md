# Proton Mail Bridge Provider Plan

## Scope

Support Proton Mail through Proton Mail Bridge on Windows. OpenMail will not connect directly to Proton's hosted mailbox service in this plan. Instead, it will use the local IMAP and SMTP interfaces exposed by the user's installed Bridge application.

Status: planned and optional. Priority: P5.

## Provider boundary

Proton Mail Bridge manages the encrypted connection to Proton and exposes local IMAP and SMTP endpoints for desktop clients. Proton documents Bridge support for Windows, macOS, and Linux, and states that Bridge is currently available only with paid Proton Mail plans. Proton Mail does not provide POP access. See [Proton IMAP, SMTP, and POP3 setup](https://proton.me/support/imap-smtp-and-pop3-setup).

OpenMail must not represent Bridge as a normal cloud OAuth provider. The user must have Bridge installed, signed in, running, and configured for the Proton account before OpenMail can connect.

## Account setup plan

1. Add a Proton Mail Bridge provider option with clear prerequisites.
2. Check whether the documented local Bridge endpoint is reachable before saving an account.
3. Let the user enter or confirm the Bridge-generated IMAP and SMTP host, port, username, and password.
4. Never assume the default ports because Bridge allows users to change them and another local application may occupy a port.
5. Probe IMAP and SMTP separately.
6. Store the Bridge credential in Windows Credential Manager.
7. Store only non-secret local endpoint metadata in `accounts.json`.

Automatic Bridge discovery should be a separate enhancement. It must use a documented or stable local integration surface, not process scraping or undocumented files. Until that is verified, manual connection fields are safer and easier to support.

## Mail and sync plan

Once connected, use the generic IMAP/SMTP adapter:

- Discover folders with `LIST`.
- Persist `UIDVALIDITY` and per-folder UIDs.
- Fetch summaries first and full MIME messages on selection.
- Support HTML rendering and attachments through the shared sanitizer and cache pipeline.
- Use IMAP IDLE when advertised.
- Reconnect with bounded backoff when Bridge restarts or loses its upstream connection.
- Use SMTP submission through the Bridge endpoint for compose and replies.

Proton states that Bridge stores an encrypted local cache and that its local ports may be changed. OpenMail must not try to reuse or inspect the Bridge cache. See the [Bridge settings guide](https://proton.me/support/comprehensive-guide-to-bridge-settings).

## Failure states

- Bridge not installed: show installation guidance.
- Bridge installed but not running: show a start Bridge action or instruction.
- Bridge account not authenticated: ask the user to sign in to Bridge.
- Local port unavailable: ask the user to copy the current Bridge ports.
- Upstream Proton connection lost: keep cached mail visible and mark the account offline.
- Bridge credential invalid: request a new Bridge credential without deleting cached mail.

## Implementation steps

1. Finish and stabilize the generic IMAP/SMTP adapter.
2. Add a Proton Bridge connection profile with manual local endpoint fields.
3. Add prerequisites, troubleshooting, and offline copy in both supported locales.
4. Test Bridge default and non-default ports.
5. Test Bridge restart, upstream disconnect, credential rotation, IDLE reconnect, and SMTP failure.
6. Investigate automatic Bridge discovery only after an official integration surface is confirmed.

## Acceptance criteria

- OpenMail connects to a running Proton Mail Bridge instance without a Proton web password.
- Changing Bridge ports does not require a code update.
- Cached mail remains readable when Bridge is temporarily offline.
- Restarting Bridge reconnects without duplicating messages.
- Compose and reply are disabled when SMTP is unavailable and recover after a successful SMTP probe.
- No Bridge credentials or Proton message content are written to logs.

## Official sources

- [Proton IMAP, SMTP, and POP3 setup](https://proton.me/support/imap-smtp-and-pop3-setup)
- [Introduction to Proton Mail Bridge](https://proton.me/support/mail/bridge/introduction-bridge)
- [Proton Bridge settings](https://proton.me/support/comprehensive-guide-to-bridge-settings)
- [Proton Bridge connection troubleshooting](https://proton.me/support/how-to-resolve-connection-issues-in-bridge)
- [IMAP4rev2](https://www.rfc-editor.org/rfc/rfc9051.html)
