# Train Robber

Isometric browser train-robbery game. TypeScript monorepo.

- `packages/sim` – deterministic simulation (no DOM/PixiJS/Date/Math.random; 60 Hz fixed step)
- `packages/config` – config schema, merge/validate/hash
- `packages/content` – JSON game content (base, variants, presets)
- `packages/tools` – CLI (map/car builders, replay, report)
- `apps/game` – PixiJS client

## Docs

In the repo:

- [Requirements](docs/requirements.md): what the game is and the prototype roadmap
- [Technical design](docs/technical-design.md): architecture and decided values (the source of truth)
- [Implementation plans](docs/plans/README.md): one per phase
  - [Phase 1: riding and boarding](docs/plans/phase-1-plan.md) (done)
  - [Phase 2: mail/express](docs/plans/phase-2-plan.md) (planned)

On the [wiki](https://github.com/devlinjunker/train-robber/wiki):

- [Playtesting](https://github.com/devlinjunker/train-robber/wiki/Playtesting): playing builds, switching variants and tuning values
- [Ideas](https://github.com/devlinjunker/train-robber/wiki/Ideas): ideas not yet scheduled, ranked
- [Creating maps](https://github.com/devlinjunker/train-robber/wiki/Creating-maps): making a map in Tiled
- [Creating train cars](https://github.com/devlinjunker/train-robber/wiki/Creating-train-cars): drawing a car interior in Tiled

## Commands

```
npm install
npm run dev      # start the client
npm run check    # typecheck, lint, dependency check, tools validate, maps check, tests
npm run tools -- replay <commands.log>      # rerun a downloaded log and compare hashes
npm run tools -- validate                   # resolve every preset and variant
npm run maps                                # rebuild base/maps from maps-src/*.tmj
npm run golden:update                       # rewrite the golden replay after a deliberate sim change
```

## Playing and previews

In the client, `?preset=alpha-default&v=boardingFailure:time-only&seed=abc123` picks the setup, and the Export logs button (or L) downloads the session's command and event logs (N adds a note to them). The Playtests link opens `playtests.html`, a history of every run played in that browser with outcomes grouped by setup.

Every pull request gets a playable build at `https://devlinjunker.github.io/train-robber/pr-preview/pr-<number>/` (linked in a PR comment), and `main` is published at `https://devlinjunker.github.io/train-robber/`. See `.github/workflows/pages.yml`.

## Versions

The game version is `0.<phase>.<milestone>`, set in `apps/game/package.json` (and the root `package.json`). Every run's log header and Playtests record carries it, so playtest notes can be filtered and exported per version. The pull request that finishes a milestone bumps the patch number (Phase 2 M1 → `0.2.1`); the first change of a new phase sets `0.<phase>.0`.

A pull request that isn't a milestone (polish, an experiment) tags the version it branched from with what it tests, e.g. `0.2.0-mud-effect`, so runs played on its preview are labelled with the feature. Tags are lowercase words joined by hyphens. Drop the tag before merging so `main` always carries a plain version; the Playtests page lists a tagged build right after its plain version. Records from before versions were set (`0.0.0`) show as `unknown`.
