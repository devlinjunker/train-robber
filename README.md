# Train Robber

Isometric browser train-robbery game. TypeScript monorepo.

- `packages/sim` – deterministic simulation (no DOM/PixiJS/Date/Math.random; 60 Hz fixed step)
- `packages/config` – config schema, merge/validate/hash
- `packages/content` – JSON game content (base, variants, presets)
- `packages/tools` – CLI (map/car builders, replay, report)
- `apps/game` – PixiJS client

Design: [docs/technical-design.md](docs/technical-design.md). Playing builds and tuning values: [Playtesting](https://github.com/devlinjunker/train-robber/wiki/Playtesting) on the wiki.

```
npm install
npm run dev      # start the client
npm run check    # typecheck, lint, dependency check, tools validate, maps check, tests
npm run tools -- replay <commands.log>      # rerun a downloaded log and compare hashes
npm run tools -- validate                   # resolve every preset and variant
npm run maps                                # rebuild base/maps from maps-src/*.tmj
npm run golden:update                       # rewrite the golden replay after a deliberate sim change
```

In the client, `?preset=alpha-default&v=boardingFailure:time-only&seed=abc123` picks the setup, and the Export logs button (or L) downloads the session's command and event logs (N adds a note to them). The Playtests link opens `playtests.html`, a history of every run played in that browser with outcomes grouped by setup.

Every pull request gets a playable build at `https://devlinjunker.github.io/train-robber/pr-preview/pr-<number>/` (linked in a PR comment), and `main` is published at `https://devlinjunker.github.io/train-robber/`. See `.github/workflows/pages.yml`.
