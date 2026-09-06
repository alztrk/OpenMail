# Local Data and Privacy

OpenMail is intended to be local-first.

## Storage model

Mailbox messages and user-requested attachments are stored in the OpenMail application data directory on the Windows device. Refresh credentials are stored separately through the Windows secure credential store.

OpenMail does not require an OpenMail-hosted backend for the first local mode. Provider APIs remain the source of truth for synchronization; the local database is a device cache and offline reading store.

## Data sent to providers

OpenMail sends only the provider API requests required for the user action, such as listing messages, fetching a message, updating message state, or sending mail. Mail content is not sent to an OpenMail service.

## User control

Users must be able to disconnect an account, remove local mailbox data, and remove downloaded attachments. These controls are part of the production acceptance scope even when the first MVP exposes them in a basic form.

## Limitations

Local storage means a device failure can remove the local cache. Provider mail remains on the provider account, but OpenMail is not a backup service.
