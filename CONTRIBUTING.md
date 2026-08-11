# Contributing to DemoBro

Thanks for helping improve DemoBro. The best contributions make a generated tour more truthful, readable, reliable, or easier to self-host.

## Before you start

- Search existing issues before opening a new one.
- Use an issue for a substantial behavior or architecture change so the direction can be discussed first.
- Never include API keys, private URLs, beta passwords, rendered customer videos, or production data in an issue or commit.

## Development workflow

1. Fork the repository and create a focused branch.
2. Follow the setup in [README.md](README.md).
3. Keep changes scoped to one problem.
4. Add or update tests for worker planning, tour quality, or rendering logic.
5. Run the full verification suite:

   ```bash
   npm run check
   ```

6. Open a pull request and explain what changed, why it changed, and how it was verified.

## Video-quality expectations

Changes to the worker should preserve the core quality floor:

- three or more successful body beats;
- a real interaction;
- at least 12 seconds of body footage;
- multiple visual states;
- full-page composition for pause and landing beats; and
- no product-specific selectors in the generic fallback.

Do not weaken these checks simply to make a failing site produce a file. A clean failure is better than publishing an empty or misleading demo.

## Code style

- Follow the existing TypeScript and modern ES module patterns.
- Prefer small, testable helpers over adding logic directly to the polling loop.
- Keep worker logs useful for diagnosing a specific job, but do not log secrets or raw user data.
- Explain non-obvious video or browser behavior in comments; remove stale commentary when behavior changes.

## Pull requests

Pull requests should be small enough to review confidently. Include screenshots for interface changes and, when practical, a short sample output for rendering changes. Sample media must come from a project you own or have permission to share.
