# Tuta Mail Provider Decision

## Decision

Do not add Tuta Mail to the initial OpenMail provider roadmap.

Status: deferred by provider boundary. Priority: not scheduled.

## Reason

Tuta states that it does not support third-party mail clients or the IMAP, POP3, and SMTP protocols. Tuta's own explanation is that exposing decrypted mail through those protocols would conflict with its end-to-end encryption model. See [Tuta third-party email applications](https://tuta.com/de/support/howto) and [Tuta security](https://tuta.com/security).

OpenMail's current provider boundary is based on one of these mechanisms:

- A documented provider API with a supported OAuth flow.
- Standard IMAP/SMTP.
- A provider-supported local bridge that exposes IMAP/SMTP.

Tuta does not fit any of these current paths. Implementing an unofficial web-client integration or reverse-engineering a private API would create an unstable and unsupported dependency and would not be appropriate for the public MVP.

## Reconsideration criteria

Tuta can be reconsidered only if one of the following becomes available:

1. Tuta publishes an official public mail API for third-party clients.
2. Tuta officially supports a desktop integration contract that OpenMail can use.
3. OpenMail creates a separate provider adapter based on a documented, user-authorized interface and verifies that the integration preserves Tuta's security guarantees.

Until then, the OpenMail account picker should not show Tuta as a supported provider. The documentation may mention it as an intentionally unsupported service so users understand that this is a provider limitation, not a missing configuration step.

## Validation requirements if revisited

- Confirm official API terms and supported client types.
- Confirm OAuth or equivalent user authorization for a public Windows client.
- Confirm offline and local-cache behavior is permitted.
- Confirm HTML, attachments, search, read state, move, send, and reply semantics.
- Confirm revocation, rate limits, and account recovery behavior.
- Add a dedicated security review before implementation.
