# Security policy

## Supported version

DemoBro is pre-1.0 and under active development. Security fixes are applied to the latest commit on `main`; older commits and deployments are not supported.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include secrets, private URLs, generated customer videos, or exploit details in public discussions.

Use GitHub's **Report a vulnerability** option in this repository's Security tab. If private vulnerability reporting is unavailable, contact the repository owner privately through their GitHub profile and ask for a secure reporting channel.

Include the affected component, reproduction steps, potential impact, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Deployment notes

- Keep `SUPABASE_SERVICE_ROLE_KEY`, `XAI_API_KEY`, `BETA_PASSWORD`, and `IP_HASH_SECRET` in server-side environment variables only.
- Keep the finished-video Storage bucket private and deliver files through expiring signed URLs.
- Do not expose the local Supabase stack to the public internet.
- Review public URLs through the existing SSRF validation path before adding new fetch or browser entry points.
