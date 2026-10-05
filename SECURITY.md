# Security Policy

## Reporting a vulnerability

Do not open a public issue, pull request, or discussion for a suspected vulnerability.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- the affected endpoint, converter, or file format
- a minimal input or request that reproduces the problem
- the impact you observed (for example code execution, path traversal, data exposure, or resource exhaustion)

Reports are acknowledged as soon as possible. Fixes are developed in a private advisory and disclosed after a release is available.

## Scope

In scope: the web application and API under `src/app/`, the conversion engines under `src/lib/`, the worker runtime and sandbox under `src/worker/`, and the container and CI configuration in this repository.

Out of scope: denial of service through traffic volume, findings that require a compromised host, and reports produced only by automated scanners without a demonstrated impact.

## Supported versions

Only the latest commit on `main` receives security fixes.
