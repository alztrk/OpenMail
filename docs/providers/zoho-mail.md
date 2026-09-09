# Zoho Mail Provider Plan

## Scope

Support Zoho Mail with an OAuth-based native adapter. Use Zoho Mail REST APIs for the first implementation if the required message operations and scopes are available for the target account type. Keep IMAP XOAUTH2 as the protocol fallback because Zoho documents it explicitly.

Status: planned. Priority: P4.

## Provider API and authentication

Zoho Mail uses OAuth 2.0 authorization codes, short-lived access tokens, and refresh tokens. The returned token response includes an `api_domain`; the adapter must use that value instead of assuming a single global Zoho data center.

The authorization URL is region-specific and follows the provider's documented form:

```text
https://accounts.{region}/oauth/v2/auth
```

The token endpoint follows:

```text
https://accounts.{region}/oauth/v2/token
```

OpenMail must keep the exact region and scopes in provider configuration after the Zoho application is registered. The initial implementation should request only the minimum mail scopes needed for profile, folders, reading, state changes, and sending. See [Zoho OAuth 2.0 User Guide](https://www.zoho.com/mail/help/api/using-oauth-2.html).

For IMAP and POP protocol access, Zoho requires an application registered as a Self-Client with the protocol scope. The documented IMAP scope is:

```text
ZOHOMAIL.PROTOCOL.IMAP
```

Zoho uses SASL XOAUTH2 for the IMAP exchange. See [Zoho SASL XOAUTH2](https://www.zoho.com/mail/help/sasl-xoauth2-smtp-imap-pop-protocol-exchange.html).

## Native adapter plan

The adapter should expose provider-specific REST methods behind the common OpenMail contract:

- Load the account profile and primary address.
- List folders and folder metadata.
- List message summaries with provider pagination.
- Fetch full message content and attachment metadata.
- Update read, star, and other supported states.
- Move or delete a message.
- Send and reply.

The exact REST resource paths and scope names must be copied from the registered Zoho data center documentation during implementation. Do not hardcode a `.com` API domain or assume that a scope valid for a personal account is valid for an organization account.

## IMAP fallback plan

If a required REST operation is not available to the selected account type, connect through IMAP with XOAUTH2 instead of asking for a primary mailbox password. Use the generic IMAP/SMTP mapping and capability detection:

- Discover folders through `LIST`.
- Persist `UIDVALIDITY` and the highest synchronized UID.
- Use `UID FETCH` for summaries and full MIME messages.
- Use `UID STORE` for flags.
- Use `IDLE` when advertised and polling otherwise.
- Use SMTP or Zoho's documented submission path for sending.

## Token and cache handling

Store the refresh token in Windows Credential Manager. The access token remains in memory and is refreshed before expiry or after a `401`. On refresh failure, distinguish a revoked token from a temporary provider failure. The adapter must preserve `api_domain`, account id, region, and provider scopes in non-secret account metadata so a reconnect uses the correct data center.

Use a provider-prefixed account id. Store provider message ids and thread ids as opaque strings. Do not derive identity from subject, sender, or timestamp.

## Provider-specific risks

- Zoho account types and data centers can change available scopes and API domains.
- Protocol access may require a Self-Client registration even when REST OAuth is available.
- Organization administrators can restrict third-party access.
- REST and IMAP can expose different folder, thread, and draft semantics.
- The adapter must not claim support for an action until the capability is verified for the current account.

## Implementation steps

1. Register an OpenMail Zoho OAuth client and document its region and redirect URI without committing credentials.
2. Implement PKCE if supported by the selected Zoho client type; otherwise verify the native public-client constraints before proceeding.
3. Implement token exchange, refresh, revoke, profile, and API-domain selection.
4. Verify the smallest REST scope set against a personal and organization account.
5. Implement folders, messages, bodies, attachments, actions, send, and reply.
6. Implement IMAP XOAUTH2 fallback only for operations that the REST adapter cannot provide.
7. Add organization consent, scope denial, throttling, and reauthorization tests.

## Acceptance criteria

- Zoho auth never requires OpenMail to collect the user's primary password.
- The adapter uses the returned Zoho API domain and survives a non-default region.
- Access-token refresh and revoke paths are tested without logging token data.
- Mail list, HTML body, attachments, read/unread, move, delete, send, and reply work for the supported account type.
- Missing admin consent and missing protocol scope are actionable errors.
- IMAP fallback is explicit and does not change the provider's reported capabilities silently.

## Official sources

- [Zoho Mail API index](https://www.zoho.com/mail/help/api/)
- [Zoho OAuth 2.0 User Guide](https://www.zoho.com/mail/help/api/using-oauth-2.html)
- [Zoho SASL XOAUTH2 for IMAP and SMTP](https://www.zoho.com/mail/help/sasl-xoauth2-smtp-imap-pop-protocol-exchange.html)
