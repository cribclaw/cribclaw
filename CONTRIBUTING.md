# Contributing to CribClaw

Thanks for your interest in CribClaw!

## How to Contribute

1. **Open an issue first** — Before submitting a PR, please open an issue to discuss the change. This helps us align on approach and avoid wasted effort.

2. **Bug reports** — Include steps to reproduce, expected behavior, and actual behavior. Logs and screenshots are helpful.

3. **Feature requests** — Describe the use case, not just the solution. We prefer features that benefit all families, not niche configurations.

## Guidelines

- Keep changes focused — one issue per PR
- Follow existing code patterns and style
- Add tests for new functionality
- Don't break existing tests (`npm test` must pass)

## Skills

CribClaw supports a [skills system](https://code.claude.com/docs/en/skills) — markdown files in `.claude/skills/` that teach Claude Code how to transform an installation. Skills let users selectively add features without inheriting code they don't need.

A skill PR should contain **instructions** Claude follows to add the feature, not pre-built code. See `/add-telegram` for a good example. Test your skill on a fresh clone before submitting.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0-or-later](LICENSE) license.
