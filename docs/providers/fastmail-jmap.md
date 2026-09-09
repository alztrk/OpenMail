# Fastmail JMAP Provider Plan

## Scope

Add Fastmail as a native provider using JMAP for mail data and OAuth 2.0 with PKCE for account authorization. Keep IMAP/SMTP as a fallback only if a specific capability is missing from the JMAP implementation.

Status: planned. Priority: P3.

## Why JMAP

Fastmail supports JMAP, IMAP, and SMTP. JMAP provides JSON-based mailbox, message, search, and submission operations with explicit state values for incremental synchronization. It is a better fit for OpenMail's local cache than parsing provider-specific IMAP behavior for a provider that already exposes a modern API. See [Fastmail API documentation](https://www.fastmail.com/dev/).

## OAuth registration and flow

Fastmail currently registers OAuth clients manually. The registration request includes the application name, logo URL, product URL, terms URL, privacy URL, support URL, scopes, and redirect URIs. Fastmail assigns the client id after registration.

Supported redirect forms include an application private-use URI and a loopback URL. OpenMail should request a provider-specific loopback path and an available local port.

Authorization endpoint:

```text
https://api.fastmail.com/oauth/authorize
```

Token endpoint:

```text
https://api.fastmail.com/oauth/refresh
```

Required OAuth parameters include `client_id`, `redirect_uri`, `response_type=code`, a space-delimited scope value, an S256 `code_challenge`, and a random `state`. The authorization code is exchanged with the `code_verifier`. Fastmail's documented flow does not require an embedded client secret for the native exchange. See the [Fastmail OAuth section](https://www.fastmail.com/dev/#oauth-at-fastmail).

Initial scopes:

```text
urn:ietf:params:jmap:core
urn:ietf:params:jmap:mail
urn:ietf:params:jmap:submission
```

The adapter must replace the previous refresh token whenever Fastmail returns a new one. A permanent `invalid_grant` requires reauthorization; a temporary `invalid_grant` can be retried according to the response.

## JMAP API surface

1. Load the session resource:

   ```text
   GET https://api.fastmail.com/jmap/session
   ```

2. Select the mail account id and capability from the session response.
3. Use JMAP method calls for:

   - `Mailbox/get` and `Mailbox/query` for folders.
   - `Email/query` for paged message ids and search.
   - `Email/get` for list fields, body values, headers, and attachments.
   - `Email/changes` for incremental synchronization from a saved state.
   - `Email/set` for flags and other supported message updates.
   - `EmailSubmission/set` for compose and reply delivery.

Requests are JSON method calls sent to the session API endpoint returned by the session resource. Do not hardcode an account id or API endpoint beyond the documented session URL.

## Mapping and cache plan

Use a provider-prefixed account id and persist Fastmail `accountId`, `mailboxId`, `emailId`, `threadId`, and the last JMAP state per mailbox or query scope. Map JMAP keywords to the shared model's read, starred, draft, and answered states.

Fetch list fields first. Fetch `bodyValues`, HTML, text, and attachment metadata only for a selected message or an explicit offline-download action. Sanitize HTML through the existing renderer.

Use `Email/changes` to apply created, updated, and destroyed ids. If the server reports an invalid state, run a fresh `Email/query` and rebuild only the affected cache scope. Do not treat an invalid state as a full-account failure.

## Implementation steps

1. Submit the OpenMail OAuth client registration request to Fastmail.
2. Add a reusable PKCE loopback flow with provider-specific endpoint and scope configuration.
3. Add Fastmail token exchange, refresh-token rotation, revoke, and profile loading.
4. Implement session discovery and capability checks.
5. Implement folder, query, message, body, and attachment mapping.
6. Implement `Email/changes` and transactional cache updates.
7. Implement message flags, move, send, and reply through JMAP.
8. Add fallback and reconnect states without silently switching to password authentication.

## Acceptance criteria

- A registered OpenMail client can authorize through Fastmail with PKCE and no client secret.
- Refresh-token rotation replaces the stored token and does not reuse the old token.
- Inbox and custom mailboxes render from local cache while `Email/changes` runs.
- Search and pagination use JMAP query state instead of downloading the whole mailbox.
- HTML, text, inline images, and attachments render through the shared pipeline.
- Revoked authorization and invalid JMAP state have clear reconnect and resync paths.

## Official sources

- [Fastmail API documentation](https://www.fastmail.com/dev/)
- [Fastmail JMAP API](https://www.fastmail.com/dev/#getting-started-with-jmap)
- [Fastmail OAuth](https://www.fastmail.com/dev/#oauth-at-fastmail)
- [RFC 8620 JMAP Core](https://www.rfc-editor.org/rfc/rfc8620.html)
- [RFC 8621 JMAP Mail](https://www.rfc-editor.org/rfc/rfc8621.html)
- [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636.html)
