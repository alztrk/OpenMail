# Authentication

OpenMail connects directly to provider APIs from the Windows desktop application. There is no OpenMail authentication server and no mailbox password is collected.

## Gmail desktop OAuth setup

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the Gmail API for that project.
3. Configure the OAuth consent screen and add the test user used during development.
4. Create an OAuth client with application type `Desktop app`.
5. Copy the client identifier and client secret into a local `.env` file. Do not use a `Web application` client for OpenMail.

OpenMail loads the Gmail OAuth settings at runtime from `.env`. Put the file in
the project working directory during development or next to `OpenMail.exe` for
a portable release:

```env
OPENMAIL_GMAIL_CLIENT_ID=your-google-client-id
OPENMAIL_GMAIL_CLIENT_SECRET=your-google-client-secret
```

Desktop applications still use PKCE. The local secret is not committed, logged,
or embedded in the executable. OAuth tokens are stored in Windows Credential
Manager.

## Flow

The account dialog starts the provider-neutral `start_auth` Tauri command with `gmail`. OpenMail then resolves the Gmail authorization adapter, binds an available loopback port, generates a one-time CSRF state and PKCE verifier, opens the authorization URL in the default browser, validates the callback, exchanges the code over HTTPS, reads the Gmail profile address, and stores the refresh token in Windows Credential Manager. Reconnecting an existing account passes its address as a non-secret OAuth login hint.

PKCE is used because it is recommended for installed desktop applications. Google continues to support loopback redirects for desktop applications. See the [OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices), [loopback migration guidance](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration), and [server-side OAuth documentation](https://developers.google.com/workspace/gmail/api/auth/web-server).

## Scopes

The current connection requests `https://www.googleapis.com/auth/gmail.modify` for reading messages and applying user-triggered mailbox actions such as archiving, trashing, starring, and marking messages unread. It also requests `https://www.googleapis.com/auth/gmail.send` for compose and reply delivery.

If an account was connected before the send scope was added, reconnect it from the Accounts settings page. Gmail must issue a new refresh token with the additional permission.

## Local data

- Refresh tokens: Windows Credential Manager, service name `OpenMail`.
- Account metadata: Tauri application data directory, file `accounts.json`.
- Access tokens: process memory only during the active application session, with an expiry-aware cache; they are not persisted to disk or Credential Manager.
- Mail content and folder caches: Tauri application data directory, scoped per account.

The Gmail OAuth client ID and secret are loaded from the runtime environment.
The normal build does not read local credential JSON files. Keep credential JSON
files, `.env`, refresh tokens,
access tokens, and service-account credentials out of the repository. OpenMail
requests offline access and requires a refresh token before saving an account
locally.

Revoked, expired, or missing credentials become an account reauthorization state during token refresh and synchronization. Gmail incremental synchronization persists the provider history cursor and falls back to a full sync when Gmail reports that the cursor is invalid or too old. See the [Gmail history API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

## Microsoft Graph provider

Outlook, Hotmail, Live, and Microsoft 365 accounts use the Microsoft identity platform authorization code flow with PKCE and the system browser. A public Microsoft Entra application client ID is required for a distributed desktop build; no client secret is used or embedded in OpenMail.

Set `OPENMAIL_MICROSOFT_CLIENT_ID` in the build environment before compiling the desktop application. The value is a public application identifier, not a credential. Register `http://localhost` as a mobile and desktop redirect URI in the Entra app registration. The running adapter binds an available loopback port and uses the corresponding callback path.

The delegated permissions are `User.Read`, `Mail.ReadWrite`, `Mail.Send`, and `offline_access`, together with the OpenID Connect scopes used during sign-in. The Graph adapter uses the signed-in user's `/me` profile and mail folder/message endpoints, stores refresh tokens in Windows Credential Manager, and keeps access tokens in the process cache with expiry-aware refresh. It uses draft-then-send for compose and reply so the sent message can be hydrated into the local cache. See the [Microsoft Graph delegated access flow](https://learn.microsoft.com/en-us/graph/auth-v2-user), [authorization code flow with PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [create a reply](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0), and [list messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0).

## Current verification boundary

The Gmail OAuth flow and mailbox synchronization are compile-checked and require a real Google Cloud desktop client and an interactive Google account to verify end to end. The Microsoft Graph adapter is compile-checked and requires a public Microsoft Entra client ID plus an interactive Microsoft account for end-to-end verification. No refresh tokens or mailbox credentials are included in this repository.
