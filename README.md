# Train Robber

Isometric browser train-robbery game. TypeScript monorepo.

- `packages/sim` – deterministic simulation (no DOM/PixiJS/Date/Math.random; 60 Hz fixed step)
- `packages/config` – config schema, merge/validate/hash
- `packages/content` – JSON game content (base, variants, presets)
- `packages/tools` – CLI (map/car builders, replay, report)
- `apps/game` – PixiJS client

Design: [docs/technical-design.md](docs/technical-design.md)

```
npm install
npm run dev      # start the client
npm run check    # typecheck + lint + tests
```
