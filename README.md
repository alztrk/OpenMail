# OpenMail

OpenMail is a lightweight, local-first Windows desktop mail client for bringing personal Gmail and Microsoft mailboxes into one focused workspace.

## Project status

OpenMail is under active public development. The repository currently contains the Tauri desktop shell, the first interface foundation, bilingual UI scaffolding, and the product and design records. Gmail integration is the next product milestone.

## Principles

- Mail content stays on the user's device.
- No OpenMail-hosted mailbox backend is required.
- OAuth 2.0 + PKCE is used instead of collecting mailbox passwords.
- The application should remain lightweight and quick on Windows.
- User-facing application text is localized in English and Turkish.
- Product documentation is maintained in English.

## Stack

- Tauri 2 and Rust for the Windows desktop shell.
- React and TypeScript for the interface.
- Tailwind CSS v4 for utility styling.
- shadcn/ui for owned component primitives.
- SQLite for local mailbox data.
- i18next and react-i18next for localization.

## Development

Prerequisites: Windows 10 or newer, Node.js 20 or newer, Rust with the MSVC toolchain, and Microsoft WebView2 Runtime.

```powershell
npm install
npm run tauri dev
```

Run the checks:

```powershell
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Build Windows installers:

```powershell
npm run tauri build
```

## Localization

Translations live in `src/i18n.ts`. Supported locale codes are `en` and `tr`. New user-facing text must be added to both translation objects and referenced by a stable key from React components.

## Documentation map

- [Product record](PRODUCT.md)
- [Design system](DESIGN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Local data and privacy](docs/PRIVACY.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [License](LICENSE.md)

## License

OpenMail is available for free noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Commercial use, including selling the project or a product based on it, requires separate written permission from the copyright holder.
