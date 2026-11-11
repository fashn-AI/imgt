# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not open a public
issue for a security problem.

Include the affected version or commit, how to reproduce the problem, and its
impact. We aim to acknowledge reports within three business days and will keep
you informed until a fix is released.

## Supported versions

Security fixes land on `main`. Deployments built from older commits should
update to the latest `main`.

## Scope

imgt fetches images only from hosts in `ALLOWED_HOSTS`, rejects non-HTTPS
sources, checks every redirect against the same allowlist, and limits source
size, pixel count and processing time. Reports that bypass these controls, read
data across deployments, or make the service process unbounded work are in
scope. Problems in a deployment's own Cloudflare configuration, such as an
overly broad `ALLOWED_HOSTS` value, are not vulnerabilities in imgt.
