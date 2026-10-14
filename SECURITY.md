# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities to **[security@bifrostwallet.com](mailto:security@bifrostwallet.com)**.

Do **not** open a public GitHub issue or pull request for security reports.

### Encrypted reports (preferred)

Encrypt sensitive reports to our OpenPGP key before sending mail:

| | |
| --- | --- |
| **UID** | `Bifrost Wallet Security <security@bifrostwallet.com>` |
| **Public key** | [https://bifrostwallet.com/.well-known/pgp-key.asc](https://bifrostwallet.com/.well-known/pgp-key.asc) |

```bash
curl -sS https://bifrostwallet.com/.well-known/pgp-key.asc | gpg --import
gpg --encrypt --armor -r security@bifrostwallet.com -o report.txt.asc report.txt
```

Plain-text mail to the same address is accepted when encryption is not practical; avoid including exploit details or secrets in unencrypted mail when you can encrypt instead.

### What to include

- Affected product, repository, or URL
- Description of the issue and impact
- Steps to reproduce or a minimal proof of concept
- Whether you plan any public disclosure, and on what timeline
- Optional contact details for follow-up

### Our commitments

- We acknowledge reports as soon as practical
- We keep you informed of triage and remediation progress
- We ask for a reasonable window to investigate and fix before public disclosure

### Scope

This policy covers Bifrost Wallet products and repositories under the [`bifrostwallet`](https://github.com/bifrostwallet) GitHub organization, including this repository.
