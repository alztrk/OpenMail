# Local Data and Privacy

OpenMail is intended to be local-first.

## Storage model

Mailbox messages and account metadata are stored as authenticated encrypted files in the OpenMail application data directory on the Windows device. The local storage key is stored separately through the Windows secure credential store. Refresh credentials are also stored through that secure credential store. User-requested attachments remain ordinary files in the user's Downloads directory.

OpenMail does not require an OpenMail-hosted backend for the first local mode. Provider APIs remain the source of truth for synchronization; the local database is a device cache and offline reading store.

## Data sent to providers

OpenMail sends only the provider API requests required for the user action, such as listing messages, fetching a message, updating message state, or sending mail. Mail content is not sent to an OpenMail service.

## User control

Disconnecting an account deletes its refresh credential and removes its local mailbox cache. Existing legacy plaintext account and message cache files are migrated to the encrypted format when first read. Downloaded attachments remain ordinary files in the user's Downloads directory and must be removed by the user.

## Limitations

Local storage means a device failure can remove the local cache. Provider mail remains on the provider account, but OpenMail is not a backup service.
