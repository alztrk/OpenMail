# Provider Integration Plans

This directory contains the implementation plans and current integration notes for OpenMail mail providers.

The plans are written against the current OpenMail architecture:

```text
React UI
  -> Tauri commands and events
    -> Rust provider adapter
      -> provider API or mail protocol
      -> shared mail model
      -> local cache
      -> Windows Credential Manager
```

Research baseline: 2026-09-08. Provider documentation and standards links in each plan must be rechecked before implementation because provider policies, endpoints, scopes, and OAuth registration requirements can change.

## Implementation order

1. [Microsoft Graph](microsoft-graph.md) for Outlook, Hotmail, Live, and Microsoft 365. The initial adapter is implemented; delta cursor persistence remains follow-up work.
2. [Generic IMAP and SMTP](generic-imap-smtp.md), with verified presets for Yahoo, AOL, iCloud, GMX, mail.com, and self-hosted mail servers.
3. [Fastmail JMAP](fastmail-jmap.md) for a native modern API integration.
4. [Zoho Mail](zoho-mail.md) for business and personal Zoho mailboxes.
5. [Proton Mail Bridge](proton-mail-bridge.md) for users who have the Windows Bridge application available.

[Tuta Mail](tuta-mail.md) is documented as intentionally deferred because its official client policy does not expose the IMAP, POP, or SMTP interfaces required by the current OpenMail architecture.

## Shared adapter contract

Every provider adapter should expose the same application-facing operations. Provider-specific identifiers, scopes, folder names, error payloads, and pagination tokens must remain inside the Rust adapter.

- `authorize` and `reauthorize`
- `load_profile`
- `list_folders`
- `list_messages`
- `sync_changes`
- `get_message`
- `download_attachment`
- `update_message_state`
- `move_message`
- `send_message`
- `send_reply`
- `revoke` or `disconnect`, when the provider supports it

The shared model must retain the provider name, account id, provider message id, thread or conversation id when available, folder id, received time, sender and recipient data, read state, star or flag state, subject, preview, HTML or plain body, and attachment metadata.

## Cross-provider rules

- Use a provider-prefixed account id and never use an email address as the only persistent key.
- Keep access and refresh tokens in Windows Credential Manager. Never put tokens, app passwords, or mailbox content in logs or documentation.
- Use PKCE for installed-app OAuth flows. Distributed desktop builds are public clients and must not depend on an embedded confidential client secret.
- Use provider-specific cache cursors, such as a Gmail history id, a Graph delta link, a JMAP state, or an IMAP UID validity value. Never reuse a cursor across providers.
- Render provider HTML as untrusted content through the existing sanitization and inline-image pipeline.
- Show cached data before network refresh when available, but never show fabricated account or message data.
- Treat `401`, `403`, token revocation, rate limiting, invalid cursors, TLS failures, and missing permissions as distinct user-visible states.
- Add provider capability flags before enabling actions that a provider cannot represent, such as labels, stars, archive, server-side search, or permanent delete.

The current Rust boundary exposes these capabilities through the
`get_provider_capabilities` Tauri command. Message mutations use the typed
`MessageAction` model, and system folders cross the boundary as `MailFolder`
values. A provider adapter is responsible for mapping those shared values to
its own labels, folder ids, flags, or API operations.

## Plan index

| Provider family | Primary integration | Plan |
| --- | --- | --- |
| Outlook, Hotmail, Live, Microsoft 365 | Microsoft Graph and OAuth 2.0 with PKCE | [Microsoft Graph](microsoft-graph.md) |
| Yahoo Mail and AOL | Generic IMAP/SMTP first; Yahoo Mail OAuth later | [Yahoo and AOL](yahoo-aol.md) |
| iCloud Mail | IMAP/SMTP with an Apple app-specific password | [iCloud Mail](icloud.md) |
| Fastmail | JMAP and OAuth 2.0 with PKCE | [Fastmail JMAP](fastmail-jmap.md) |
| Zoho Mail | Zoho OAuth or IMAP XOAUTH2 | [Zoho Mail](zoho-mail.md) |
| Proton Mail | Proton Mail Bridge and local IMAP/SMTP | [Proton Mail Bridge](proton-mail-bridge.md) |
| GMX, mail.com, WEB.DE, custom domains, and self-hosted servers | Generic IMAP/SMTP | [Generic IMAP/SMTP](generic-imap-smtp.md) |
| Tuta Mail | No current standard mail-client integration | [Tuta Mail](tuta-mail.md) |
