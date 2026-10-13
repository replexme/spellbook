# Security Policy

## Supported versions

Security fixes target the latest release and the default branch.

## Reporting

Do not open a public issue for a suspected vulnerability. Email security@replex.me with the affected version, reproduction steps, impact, and any suggested mitigation. Do not include real customer documents or credentials. We will acknowledge a valid report as soon as practical and coordinate disclosure after a fix is available.

## Self-hosting boundary

Spellbook processes active document content and local AI subscription credentials. Keep the web app and document view behind TLS, and keep the workers, database and object-data volume on a private network. Set a unique session secret, internal service token, and local password. Never expose worker ports directly to the public internet.
