# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Project administrators who install and configure a wiki, organize and maintain its documentation, and readers who visit the published documentation.

## Product Purpose

TxWiki lets project administrators publish and maintain clear documentation for their readers. Success means documentation is easy to publish, understand, and keep current.

## Positioning

TxWiki emphasizes straightforward installation and customization for a self-hosted documentation wiki.

## Operating Context

- Administrators install TxWiki on Node.js hosting, including VPS and Pterodactyl environments, then configure its database and site settings.
- Administrators manage documentation spaces, categories, pages, translations, accounts, and site configuration through a separate administration area.
- Readers select a documentation space and language, search and browse published pages, and can react to pages.
- Administrators can install themes from ZIP files; the built-in Default theme remains available if the external themes directory is missing or damaged.

## Capabilities and Constraints

- Public documentation and administration are separate areas of the same web application. Public-site improvements must preserve the administration area's existing functions and must not remove existing product capabilities.
- Documentation includes a rich-text editor and supports content such as formatting, links, images, video, code, tables, and callouts.
- The application supports multiple documentation spaces, localized content, user accounts, permissions, page reactions, backups, and signed application updates.
- MariaDB/MySQL is the default database choice; SQLite is also supported.
- `themes/default.zip` is an editable starter theme for administrators. The built-in Default theme is bundled internally and does not depend on `/themes`; uploaded theme archives are installed under `/themes`.
- The interface currently provides English, German, Spanish, French, and Brazilian Portuguese language files.
- Keep the public and administration interfaces usable on mobile devices as well as desktop, with keyboard navigation, visible focus, and reduced-motion preferences supported.

## Brand Commitments

The project is called TxWiki. The application can be branded by its administrator; the current interface uses the name Teralth Studio.

## Evidence on Hand

The repository contains the application source, automated unit and Playwright tests, five interface language files, a bundled Default theme, and its editable starter archive at `themes/default.zip`. No customer testimonials, adoption metrics, or case studies are established in the repository; do not invent them.

## Product Principles

- Make installation and customization approachable for project administrators.
- Help readers find and understand project documentation.
- Preserve working features and administrator workflows as the public experience evolves.
- Keep the built-in theme and documentation usable across supported hosting and device environments.
