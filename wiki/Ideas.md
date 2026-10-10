Every idea that is written down somewhere but not scheduled in a phase yet. It covers ideas from playtests and the "later", "possible" and "long-term" items in [requirements.md](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md), [technical-design.md](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md) and the Phase 1 plan. Work already in a phase's build list (countdown, heat, loot, combat, the passenger and bank trains, the continuous world) is not repeated here.

This list is an index, not the source of truth. Where an idea came from a document, that document keeps the detail and decides it. When an idea is scheduled, move it into the requirements or the design doc and strike it here. New ideas from playtests go in the first table with who raised them and when.

## From playtests

| Idea | Raised | Notes |
| --- | --- | --- |
| Limited horse boost to catch up with a train | Devlin, M3 playtest, 2026-10-09 | A short burst above top speed with a cooldown or a stamina cost. It fits the reserved `handlingModel` variant group (stamina, speed tiers). |
| Resistance while boarding: guards on the train shoot at the rider, perhaps only at higher heat | Devlin, M3 playtest, 2026-10-09 | Needs combat (phase 3) and heat (phase 2). A heat threshold in config would let heat make the approach harder as well as the run. |
| More track layouts and terrain, to see whether runs vary enough to stay fun | Devlin, M3 playtest, 2026-10-09 | The map pipeline already supports several routes per map, speed zones and terrain zones. This needs new maps drawn in Tiled. See also "World and schedule" below. |
| Moving between cars and onto the roof | Devlin, M3 playtest, 2026-10-09 | The requirements make the roof a traversal route for bypassing or surrounding a car, but no phase builds it yet. Multi-car interiors were deferred to phase 2. |
| A deliberate camera and zoom design for the final game (how far out while riding, aboard and boarding); free wheel zoom is fine for the alpha | Devlin, M3 playtest, 2026-10-09 | Pairs with the renderer choice under "Presentation, input and platform". The boarding meter was enlarged for the alpha at the same time. |
| Track playtest responses in the repo (answers to each PR's playtest questions, and Playtests page exports, kept as files) | Devlin, 2026-10-10 | For now the answers go in a PR comment and run history stays local on the Playtests page, with an optional GitHub issue. Doing this means picking a folder layout and possibly a GitHub Action that collects `playtest` issues. |
| Online multiplayer, to look at once all the initial trains work and have been playtested, because it gives the game more staying power | Devlin, 2026-10-10 | Gang play is already listed under "Presentation, input and platform" below; this sets when to think about it. |
| A rival gangs mode | Devlin's wife, via Devlin, 2026-10-10 | How it works is undecided: other gangs racing you for the same train, or players on opposing gangs. Depends on multiplayer, or on AI gangs if it is single-player. |

## Riding and boarding

| Idea | Source |
| --- | --- |
| Stamina-based and speed-tier horse handling as alternatives to arcade handling (the `handlingModel` variant group) | [requirements: Approach and boarding](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#approach-and-boarding), [design: Riding controls](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#riding-controls) |
| Quick-time button prompts during boarding (`boardingInput: meter-qte`, `boarding.qte.*`) | [requirements: Approach and boarding](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#approach-and-boarding), [design: Variant groups](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#variant-groups) |
| A horse that can be hurt | [requirements: Approach and boarding](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#approach-and-boarding) (still to define) |
| Trains that restrict which entry points you can board from | [requirements: Approach and boarding](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#approach-and-boarding), [design: Trains and boarding cues](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#trains-and-boarding-cues-on-the-world-map) |

## Trains

| Idea | Source |
| --- | --- |
| Cargo train: throw crates off at drop zones and recover them on horseback, skipping the carry limit | [requirements: Train types](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#train-types), [edge cases](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#edge-cases-and-open-questions) |
| Bank train: dynamite and a key hunt as alternatives to the vault | [requirements: Train types](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#train-types), [design: flag C4](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#conflicts) |
| Later trains: traveling circus (chaos, animals, distractions), cattle (stampedes, non-cash loot), mining (heavy loot, dynamite, carts), haunted (odd supernatural rules), prison transport (free prisoners as allies or chaos) | [requirements: Train types](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#train-types) |

## Extraction and leaving the train

| Idea | Source |
| --- | --- |
| Designated jump points, and terrain-dependent jumps from anywhere, as well as whistling for the horse | [requirements: On-board gameplay](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#on-board-gameplay) |
| Leaving the train on foot mid-run (the frame model allows it through `leaveTrain` without a mount) | [design: Deliberately not supported](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#deliberately-not-supported) |

## Heat, wanted level and run structure

| Idea | Source |
| --- | --- |
| Bounty hunters who chase you on the map and on trains | [requirements: Time pressure and run end](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#time-pressure-and-run-end) |
| Heat that fades if you lie low, or that you can pay off | [requirements: Time pressure and run end](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#time-pressure-and-run-end) |
| Wanted level that decays over time, or that is a continuous value or named tiers instead of levels | [requirements: Time pressure and run end](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#time-pressure-and-run-end), [design: flag U11](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#unclear) |
| A wanted-level penalty for cancelling close to expiry, if playtests show cancel abuse (`cancelWantedDelta`, `cancelPenaltyBelowSec`) | [design: flag U6](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#unclear) |
| A roguelike structure where death resets more than the run's loot | [requirements: Game structure](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#game-structure-roguelike-option) (open question) |

## World and schedule

| Idea | Source |
| --- | --- |
| Procedurally generated tracks and terrain | [requirements: World, schedule and progression](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#world-schedule-and-progression) |
| Several routes per map, and routes that are selectable or less predictable | [design: Map decisions](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#map-decisions) |
| More curves, then hills (an `elevation` layer that slows trains uphill and drives rendered height) | [design: Track model](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#track-model), [Map decisions](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#map-decisions) |
| Timetables showing upcoming trains, bought with loot | [requirements: World, schedule and progression](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#world-schedule-and-progression) |

## Progression

| Idea | Source |
| --- | --- |
| Horse upgrades, gear and weapons, a hideout, then reputation and bounty | [requirements: World, schedule and progression](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#world-schedule-and-progression) |
| A leaderboard tied to accounts instead of local only | [requirements: open questions](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#edge-cases-and-open-questions) |

## Presentation, input and platform

| Idea | Source |
| --- | --- |
| Pixel art or low-poly 3D in place of placeholder shapes; pre-drawn car sprites for a set of directions | [requirements: Technical](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#technical-and-non-functional-requirements), [design: Trains and boarding cues](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#trains-and-boarding-cues-on-the-world-map) |
| A 3D renderer (Three.js) over the same sim | [requirements: Technical](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#technical-and-non-functional-requirements), [design: 3D](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#3d) |
| More occlusion rules beyond hiding the roof, starting with an x-ray silhouette for the player behind walls | [design: Render pipeline](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#render-pipeline) |
| Online multiplayer with a gang of friends | [requirements: Vision and pillars](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#vision-and-pillars), [design: Multiplayer](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#multiplayer-gang-play) |
| Gamepad support, then touch controls and mobile browsers | [requirements: Technical](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#technical-and-non-functional-requirements), [design: Mobile browsers](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md#mobile-browsers) |
| An in-game panel for switching variants (URL only in Phase 1) | Phase 1 plan, decision Q14 |
| Sound and music, and difficulty settings | [requirements: open questions](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#edge-cases-and-open-questions) |
