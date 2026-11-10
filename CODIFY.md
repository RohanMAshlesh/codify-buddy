# Codify Buddy — project memory

Conventions for anyone (human or agent) changing this repository.

- TypeScript, ESM, Node 20+. Relative imports end in `.js`.
- Keep the runtime free of native modules so `npx` and `bun build --compile` keep working.
- Every model-supplied path goes through `resolveInRoot` before touching the filesystem.
- Use `Object.create(null)` for maps keyed by user or code text (tokens, file paths).
- Anything placed in the system prompt must be deterministic for the whole session (prompt caching).
- New tools: add to `src/tools/registry.ts`, declare `access` correctly, validate input with zod, add tests.
- Run `npm run typecheck && npm test` before committing.
