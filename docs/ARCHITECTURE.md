# Architecture

## Goals

OpenMail is a local-first Windows application with a small runtime footprint. Provider access, local persistence, synchronization, and presentation are separate concerns.

## Layers

```text
React UI
  -> Tauri commands and events
    -> Rust application services
      -> Provider adapters (Gmail, Microsoft Graph)
      -> Local SQLite repository
      -> Windows credential store
      -> Windows notification and tray integration
```

## Provider boundary

Each provider implements the same application-facing operations: authorize, list changes, fetch a message, send a message, update message state, and move a message. Provider-specific identifiers and payloads do not leak into React components.

## Synchronization

The first local-only mode runs while OpenMail or its tray service is active. It records a provider cursor or history identifier, fetches only changes after that cursor, persists messages transactionally, and emits a new-mail event after persistence succeeds. A periodic reconciliation pass repairs missed or delayed provider notifications.

## Security boundary

Provider tokens stay in the Windows secure credential store. Mail content stays in the local application data directory. Provider HTML is treated as untrusted content and requires sanitization before rendering.

## Performance rules

- Prefer incremental provider history APIs over full mailbox scans.
- Keep blocking network and database work outside the UI thread.
- Batch initial imports and render visible rows first.
- Avoid continuous animations and unnecessary background polling.
- Keep attachment downloads on demand unless the user requests local availability.
