# Product

<!-- impeccable:product-schema 1 -->

## Platform

Windows desktop

## Users

OpenMail is for personal users who want to manage Gmail and Microsoft mailboxes from one lightweight Windows desktop application.

## Product Purpose

OpenMail brings mail from different providers into one fast, local workspace on Windows. Success means the user can see new mail quickly, receive a desktop notification, and complete essential mail actions without switching between provider websites.

## Positioning

OpenMail is a lightweight, self-hosted, local-first Windows mail client that keeps mail content on the user's device instead of storing it on an OpenMail server.

## Operating Context

The application starts with Windows or on user request and can remain active in the system tray. Gmail is the first provider; Microsoft Live/Outlook follows. Synchronization runs at short intervals and produces a Windows notification when a new message is found.

## Capabilities and Constraints

- Windows-only desktop application.
- Tauri, Rust, React, TypeScript, shadcn/ui, and Tailwind CSS v4.
- No OpenMail backend or OpenMail-hosted mail storage.
- Mail content and attachments are stored on the user's device.
- OAuth 2.0 + PKCE; OpenMail never receives the user's mailbox password.
- Gmail is the first provider.
- The first MVP includes a unified inbox, reading, sending, replying, read/unread state, archive, delete, basic search, and Windows notifications.
- Synchronization runs while the application or its tray service is active.
- Without a publicly reachable provider push endpoint, notifications while the application is fully stopped are not guaranteed.
- The interface is calm, fast to scan, and low-resource.
- Lucide Icons are not used. Tabler Icons is the shared icon family for interface actions, navigation, settings, and mail state.

## Brand Commitments

The product name is OpenMail. The product language is direct, calm, and free of unnecessary decoration.

## Evidence on Hand

No real mailbox content or additional brand assets have been supplied. The interface must not present fake accounts, fake mail, or fake performance data as real product state.

## Product Principles

- Local first: mailbox data stays on the user's device.
- Fast comprehension: inbox and account state are clear at a glance.
- Provider independent: Gmail and Outlook use a shared mail model.
- Quiet reliability: sync, error, and connection states are clear without being distracting.
- Lightweight operation: background and interface processes avoid unnecessary resource use.

## Current implementation status

- Gmail OAuth with PKCE is implemented.
- Mail metadata and loaded message pages use local JSON cache files.
- Refresh tokens are stored in Windows Credential Manager.
- HTML mail rendering, attachments, incremental synchronization, desktop notifications, tray controls, and launch-at-startup are implemented.
- Outlook support remains planned and is not available in the current release.

## Accessibility & Inclusion

Keyboard-complete interactions, visible focus states, sufficient color contrast, meaningful ARIA labels, and preserved function when the window is resized are required.
