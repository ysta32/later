# Contributing

Later is a TypeScript ESM monorepo on Node 24 (native type stripping, no build step for the server).

## Setup

```sh
npm ci
npm run build -w apps/web
npm run dev
```

## Rules

- Import local files with the `.ts` extension. No enums, parameter properties or namespaces.
- Tests are vitest, colocated as `*.test.ts`.
- Before opening a PR run `npm run format:check`, `npm run typecheck` and `npm test`.
- API changes must be reflected in `docs/API.md`.
