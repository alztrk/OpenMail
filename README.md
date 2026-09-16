# OpenMail

OpenMail is a lightweight, local-first Windows desktop mail client for bringing personal Gmail and Microsoft mailboxes into one focused workspace.

## Project status

OpenMail is under active development. The repository currently contains the Tauri desktop shell, localized UI, Gmail and Microsoft account OAuth with PKCE, local mailbox caching, incremental synchronization, HTML mail rendering, desktop notifications, Windows tray controls, and the product and design records.

Verification currently targets Gmail for live end-to-end testing. Microsoft Graph
is compile-checked and covered by unit tests, but is not live-tested in this
release cycle because its public client ID, tenant or consent configuration,
and a test account are not available.

## Principles

- Mail content stays on the user's device.
- No OpenMail-hosted mailbox backend is required.
- OAuth 2.0 + PKCE is used instead of collecting mailbox passwords.
- The application should remain lightweight and quick on Windows.
- Only one OpenMail desktop instance runs at a time; a second launch focuses the existing window.
- User-facing application text is localized in English, Turkish, German, Spanish, French, and Brazilian Portuguese.
- Product documentation is maintained in English.

## Stack

- Tauri 2 and Rust for the Windows desktop shell.
- React and TypeScript for the interface.
- Tailwind CSS v4 for utility styling.
- shadcn/ui for owned component primitives.
- Authenticated encrypted JSON files for local account metadata and message cache during the current MVP.
- i18next and react-i18next for localization.

## Development

Prerequisites: Windows 10 or newer, Node.js 20 or newer with pnpm 11.13.1,
Rust with the MSVC toolchain, and Microsoft WebView2 Runtime. The
`packageManager` field pins the pnpm version used by the project.

```powershell
pnpm install
pnpm tauri dev
```

Run the checks:

```powershell
pnpm lint
pnpm test
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

Build the Windows portable release:

```powershell
pnpm tauri build --no-bundle
```

The portable release is a single `openmail.exe`. Copy `.env.example` to `.env`,
fill in the provider client IDs, and place the file next to the executable.
OpenMail loads these values at runtime, so they are not embedded in the binary.
The Microsoft Graph client ID is a public application identifier, while the
Gmail client secret remains private. Never commit the real `.env` file.

## Localization

Translations live in `src/locales/`. Supported locale codes are `en`, `tr`, `de`, `es`, `fr`, and `pt-BR`. The shared locale registry is defined in `src/locale-config.ts`. New user-facing text must be added to every locale file, preserve the same interpolation placeholders, and be referenced by a stable key from React components.

## Documentation map

- [Product record](PRODUCT.md)
- [Design system](DESIGN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Authentication](docs/AUTHENTICATION.md)
- [Provider integration plans](docs/providers/README.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Local data and privacy](docs/PRIVACY.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [License](LICENSE.md)

## License

OpenMail is available for free noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Commercial use, including selling the project or a product based on it, requires separate written permission from the copyright holder.
