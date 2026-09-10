# Security Policy

## Scope

This policy covers the OpenMail source code and official releases in this repository.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use a private GitHub Security Advisory for this repository when available. If that channel is unavailable, open a minimal issue asking for a private reporting channel without including exploit details.

## Security requirements

- Store refresh tokens through the Windows secure credential store.
- Use the smallest provider permission scopes that support the feature.
- Treat all provider content as untrusted input.
- Sanitize rendered HTML mail and attachments before display.
- Keep the runtime cache and provider state inside the OpenMail application data directory. User-initiated attachment downloads are written to the Windows Downloads directory and must use sanitized filenames without exposing provider credentials.

## Supported versions

Only the latest public `main` revision and the latest published release receive active fixes until a release policy is established.
