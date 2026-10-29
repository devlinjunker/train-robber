# Train Robber: Game Requirements

Oct 8, 2026

## Vision and pillars

Train Robber is a stylized, arcade-feel isometric browser game: one outlaw rides alongside a moving train, jumps aboard, loots it before the law arrives, and escapes with as much as they can carry.

- **Arcade fun first.** Readable, forgiving and quick to retry.
- **Every train favors a different playstyle.** Some invite fights and others reward stealth or speed, but any approach can be tried on any train.
- **Risk against reward.** Heavy loot slows you down, and noise and violence raise heat.
- **Multiplayer-ready by design.** Single-player first, with friends joining as a gang later.

## Game structure: roguelike option

Initial picks from the procedural maps review (2026-10-18), to build and playtest rather than final: a run is one day on the line inside a career, and dying ends your outlaw. Permadeath is a death variant, so the roguelike and standard rules can both be playtested. In either one, dying or being downed loses all loot from that run.

| Option | What death does | Progression |
| --- | --- | --- |
| Roguelike (initial pick) | Ends the outlaw: the career is over. Some unlocks may carry over to the next outlaw; exactly which is to be defined. | Built around careers of days. Horse upgrades, gear and hideout need rules for what persists after death. |
| Standard (variant) | Ends the day and loses its loot, and possibly some of your banked loot. | Banked loot and upgrades persist, with death as a setback rather than a reset. |

To keep both options open:

- The simulation treats death consequences as configuration, not hard-coded rules.
- Run state (carried loot, health, countdown) stays separate from persistent state (banked loot, upgrades, wanted level), so either structure can be plugged in.
- The prototype can ship with the simplest rule, losing the run's loot, and the decision comes after playtesting.

Open question: which unlocks carry over to a new outlaw, and how much banked loot a standard death would cost.

## World structure: a day on the line

Initial picks from the procedural maps review (2026-10-18, [options doc](https://claude.ai/code/artifact/3766a4a9-8b9c-4867-8615-0bc65022f0bf)). Three time scales nest inside each other:

| Scale | What it is | Ends when |
| --- | --- | --- |
| Train | Boarding and looting one train | It reaches the next town, you extract, or you are thrown off |
| Day (one run) | Finding and robbing trains from dawn to dusk, about 12 minutes | Dusk |
| Career (one outlaw) | Days in a row, moving down the line | Your outlaw dies |

- **The world is an endless line with towns.** One railway generated from a seed forever, with towns along it and land around it, wide enough that riding to the line and choosing where to meet a train are part of the run. An open world with a rail network can grow out of it later.
- **A day starts at camp** 300-800 tiles off the line. At dusk you pick tonight's camp from 2-3 spots near where you finished, each with a trade-off, and tomorrow starts there. Towns are where you buy and sell.
- **Day clock.** Dawn to dusk only to start; night comes later as a twist. Dusk waits for a robbery in progress.
- **Train clock.** Once aboard, the clock is the time until the train reaches the next town, where the law gets on, so town spacing sets run length. This replaces the fixed countdown as a variant (`trainClock`: `next-town`, built in G6; `fixed-countdown` is the Phase 2 clock).
- **How the clocks fit together.** The day clock budgets the whole day, and riding to a train and scouting use part of it. The train clock is town spacing divided by train speed, so it sets how long one robbery can last. Train length (cars and loot) has to fit that time: too long and the train can't be finished, too short and the player is left waiting. Town spacing, train speed and cars per train are therefore tuned together, starting from the Phase 2 robbery time.
- **Being thrown off ends that train only.** Its loot is lost and the day goes on.
- **Finding and telling trains apart.** Finding a train while the day clock runs (smoke, whistles, telegraph poles) comes first, with mail trains alone (G9). Telling train types apart by sight comes once there are several types and 3D graphics, with regions (G13), plus rumours and timetables you earn, so information is worth buying. The spyglass still needs design (decided 2026-10-28).
- **Trains run one way first**, and both ways once passing loops exist (G14a, right after the day gate). Forks come with regions (G14b).
- **Seeds.** A new world per career, a daily seed for the daily, and `?seed=` to replay any world. The same seed builds the same world on every machine.
- **Hand-made maps stay** as test fixtures, golden runs and the source of set pieces.

**Daily demo.** The free daily is a short day; a weekly heist may come later. Your streak, wanted poster and the community line carry over, and your record moves into the full game on purchase. Owners can ride the daily as a gang with free friends, on a gang board, and an occasional free gang weekend lets free players ride together with no owner. Every train type shows up in dailies over a week. No ghost riders in your daily; friends' choices may show on the result screen after you finish.

## Core loop

One run is one train robbery. Phase 2 plays it as a stand-alone run and compares a short (2-5 min) and a medium (8-15 min) setup. On the endless line a robbery is one *train* inside a *day* (about 12 minutes), so the short setup is the train-sized scale and the medium setup is the day-sized one. The loop below repeats for each train robbed before dusk (see World structure).

1. Pick a train from the real-time loop, using a timetable if you have bought one, and ride your horse toward it.
2. Match speed and pull alongside the train.
3. Jump aboard with a timing meter.
4. Loot the train using your chosen approach (combat, stealth or speed), though each train favors one while the clock and heat meter run.
5. Extract by whistling for your horse, which arrives after a variable, unknown amount of time, and jumping back on.
6. Cash out what you carried off. In the alpha, banked loot is a leaderboard-ready score, tracked per run and in total. If the clock expires first, the run ends with a wanted level.

## Approach and boarding

You reach the train on horseback, and boarding is a timing-meter jump.

- **Riding.** Direct control of a horse. Speed and terrain matter. Handling is arcade to start, with stamina-based and speed-tier handling kept as options to playtest.
- **Boarding.** A timing meter; better timing means a cleaner landing. Quick-time button prompts are a possible addition; playtest both to find what is most fun without being too difficult.
- **Failure.** You lose time and take damage, the train keeps moving, and you can retry.
- **Cancel.** You can abort a run at any point, but cancelling loses any loot you have not extracted. Like every ending, it rolls heat for a wanted level.
- **Entry points.** These vary by train. Some trains restrict where you can board.

Still to define: how long the horse can run beside the train, obstacles such as rocks and rivers, and whether the horse can be hurt.

## Train types

Six trains are planned for the first version and four more come later. Each has its own core verb and a favored playstyle, so trains play differently, but any approach can be used on any train.

| Train | Favored playstyle and core verb | Loot and risk | Version |
| --- | --- | --- | --- |
| Passenger | Stealth and judgment. Work through passengers, picking who looks valuable, and hold them up. | Judged by visual cues and a timed inspect action. Some passengers are armed heroes or undercover lawmen. | First |
| Cargo/freight | Search. Find valuable crates among decoys. Throwing them off the side at drop zones is a possible later addition if it proves fun. | The normal carry limit applies. If throwing is added, it skips the carry limit, but crates must be recovered on horseback and can be lost at bad drop zones. | First |
| Bank/gold | Vault cracking minigame, interrupted by guards. | Large payout. Dynamite and key hunt are alternative approaches added later. | First |
| Military payroll | Combat-heavy. Fight through soldiers. | Heavy guards, big payout. | First |
| Mail/express | Speed and stealth. Fast and light. | Many small items, short run. | First |
| Tycoon's private | Boss-like target. | Elite guards, luxury loot. | First |
| Traveling circus | Chaos, animals and distractions. | To be designed. | Later |
| Cattle/livestock | Stampedes. | Non-cash loot. | Later |
| Mining/ore | Heavy and slow. Dynamite and cart mechanics. | Valuable but cumbersome. | Later |
| Haunted/ghost | Supernatural twist with odd rules. | To be designed. | Later |
| Prison transport | Free prisoners to recruit allies or cause chaos. | To be designed. | Later |

## On-board gameplay

You control one outlaw directly, moving mainly through the train interior.

- **Traversal.** The interior is the main route. The roof is an alternative for bypassing a car or surrounding it. The roof is hidden while the player is inside.
- **Combat and stealth.** Both exist, and any approach can be used on any train. Each train leans toward one. Combat uses ranged shooting and melee. Stealth uses enemy sight cones and noise, and noise feeds the heat meter.
- **Health.** A health bar with healing items first. A downed state, where you fall at zero health and have a short window to recover, is built as a prototype variant for comparison.
- **Loot carrying.** A carry limit means you must get off the train to cash in. Heavy items slow you down, so grabbing the big prize is a tradeoff against speed. The carry limit and weight slowdown need playtesting and may be cut.
- **Extraction.** First version: whistle for your horse and jump back on. The horse takes a variable, unknown amount of time to arrive after you call it. The delay has a wide range, and the horse can only keep pace beside the train for a limited time. Both are tuned through playtests. Later: designated jump points, and terrain-dependent jumps from anywhere.

## Time pressure and run end

The law arrives when the clock reaches zero. On the open line the clock is the train's time to the next town. Heat no longer shortens it (decided 2026-10-28): heat makes guards sharper and raises the chance of a wanted level.

- **Countdown.** A base time until the train stops and the authorities arrive. Length is configurable per train, so short and medium runs can be compared. This fixed clock, and heat's effect on it, are Phase 2 mechanisms. On the endless line the train clock (time to the next town) replaces them, so what carries forward from the Phase 2 comparison is the measured robbery time, loot value per minute and cars per train, not the countdown value.
- **Heat.** Gunshots, alarms and being spotted, violence and kills, and loot taken all raise heat. Higher heat makes guards more alert, quicker to chase and slower to calm down, and once combat exists more likely to shoot. Heat at the end of a robbery is the percent chance of gaining a wanted level, even after a clean getaway. Other sources may be added.
- **Expiry.** If the clock runs out before you extract, the run ends, the loot is lost, and you gain a wanted level. A small grace window lets you escape if you are already jumping off.
- **Wanted level.** It makes later trains tougher by adding more guards. It starts with a few levels, and other structures such as a continuous value or named tiers stay possibilities.

Whether wanted level drops on its own (each day, only after a quiet day, or never) is tested in the Phase 2 gate; paying it off comes later with careers and towns. Cancelling a run rolls heat for a wanted level like every other ending, so it can't be used to dodge one. Possibilities to explore later: bounty hunters who chase you on the map and on trains, and heat that fades if you lay low or pay it off.

## World, schedule and progression

The prototype uses hand-made maps with fixed track loops, and trains run on them continuously in real time. Generated maps come in stages, each ending in a playtest (see World structure for where they lead).

- **World.** Hand-made isometric maps first. Generated worlds follow: seeded loops (`?map=gen`), then an open line across a long map (`?map=line`), then an endless line with towns, built in chunks as you ride.
- **Schedule.** A real-time loop. You choose which train to chase, and a missed train comes back around. On an open line, trains set out from the town at the start of the line on a seeded timetable and leave past the end instead; every town has a timetable of when each train reaches it and what type it is (G6). The game knows every timetable from the start; showing one to the player (a bought timetable, or rumours) and what it costs in loot come later (G12). For now the HUD shows only when the next train is due at the next town, without its type unless train names are shown. Train frequency and how many run at once are configurable tuning values.
- **Generated maps (G6).** Towns along the line have a name, a size (halt, village or town) and buildings, all from the seed; a town off each end of the line is where trains set out from and arrive. Each town's timetable comes from the seed alone, with trains a headway apart give or take the spread, as on the G3 line. Town spacing is still G3's (one or two towns at least 1,200 tiles apart, so about 2-4 minutes of train time between them): setting it from the Phase 2 target robbery time is left until that gate picks the time, and moving towns moves the terrain, so it will be a deliberate generator change. Buildings are only drawn for now: the horse and the player pass through them.
- **Progression.** Camps at dusk (G11a) come right after finding trains, as part of the day. Saved careers (G11b) and towns with a fence, outfitter, rumours and the first upgrades (G12) come before Phase 4, so the passenger and bank trains are playtested inside a career (decided 2026-10-28). Deeper progression (more horse upgrades, gear and weapons, a hideout, reputation and bounty) comes after the prototype. Reputation and bounty come last.
- **Wanted level.** It is the only persistence the first version needs: it raises guard counts on later trains.

## Technical and non-functional requirements

The game logic must run independently of the renderer, so a server can host it for multiplayer and the renderer can move from 2D to 3D without a rewrite.

- **Multiplayer architecture (required in the plan).** A network test comes right after Phase 3 (military payroll and combat) and is kept working as later trains are added; full online play with a gang of friends comes after the prototype (decided 2026-10-27). Until then, the simulation is a standalone module with no rendering or browser dependencies. It uses a fixed timestep, takes player input as commands, and keeps its state serializable so a server can later run it as the authority.
- **Rendering.** 2D isometric first, with 3D as the eventual preferred way to play. The switch to live 3D comes after Phase 3 and the network test, before G10's land and set pieces, and includes a re-check that combat still reads clearly (decided 2026-10-28). The alpha camera has a fixed angle with zoom levels, and rotation comes with 3D.
- **Art.** Placeholder shapes first. Pixel art or low-poly 3D comes later.
- **Input.** Desktop keyboard and mouse first, with gamepad support after the alpha. Touch controls are a possible later addition.
- **Platform.** A browser game on desktop. Mobile is not an initial target, but the possibility stays open, so avoid choices that would rule out touch controls and small screens later. The performance target is a 30 fps floor and a 60 fps target.
- **Recommended stack (fine for the prototype).** TypeScript with PixiJS as the 2D renderer and the simulation as a separate package. Phaser mixes game logic into its scene and physics objects, which works against the separation above. Three.js is the likely later renderer, and a Node server could run the same simulation package. Stack choices should keep mobile browsers working and leave room for a native mobile build someday.
- **Data-driven tuning.** Train length, countdown, heat rates, loot density and health model are configuration values, so run lengths and health variants can be compared without code changes.

## Prototype scope and roadmap

The prototype includes four trains (bank, passenger, military payroll and mail/express) and must prove four things: riding and boarding feel, time pressure, run length, and combat versus stealth, including that any approach is viable on any train. Built in the order below, each phase is playable on its own and ends with a playtest.

1. **Riding and boarding.** One map, one blank train, the horse, the timing-meter jump and the failure rules. Gate: riding and boarding is fun before any loot exists.
2. **Mail/express.** The first full run: countdown, heat, loot, carry limit, extraction and wanted level. Gate: played on the open line, pick the town spacing (robbery time), cars per train and baseline carry that make a robbery fun enough to play three times in a row, recording loot value per minute and robberies per day. These are provisional inputs to G6 (town spacing and timetables) and G8 (trains per day), which re-test them on the open line.
3. **Military payroll.** Combat, health bar and the downed-state variant. Gate: combat feels good and the health variants are compared.
   - **Then a network test.** Two players on one train through a simple server, with no lobby, built once combat exists so it is tested over the network early. Phases 4 and 5 keep it working, so each new train is checked over the network as it is built (decided 2026-10-27).
4. **Passenger hold-up.** Visual cues, inspect action and armed passengers. Gate: judging passengers is a decision, not a chore.
5. **Bank.** Vault cracking with guard interruptions. Gate: the minigame holds up under time pressure, and each train clearly favors a different playstyle while other approaches still work.
6. **After the prototype.** Cargo and tycoon trains, then the later trains, deeper progression and full online multiplayer.

**Order of work across the phases and the G series** (decided 2026-10-28; the wiki [Roadmap](https://github.com/devlinjunker/train-robber/wiki/Roadmap) keeps the live status). After the Phase 2 gate: G7 long replays, then G8 the day clock, with the Phase 3 plan written alongside them; G9 finding trains, G11a camps at dusk and the day gate; G14a passing loops and trains both ways; Phase 3 and the network test; the switch to live 3D; G10 land worth riding with the first map edges; G11b saved careers and G12 towns as places, with the career gate; Phases 4 and 5; G13 regions with telling train types apart, G14b forks and the choosing-a-train gate; G15 the daily day; full online multiplayer; G16 shared world.

## Prototype requirements and test plan

The alpha prototype is single-player on one map with placeholder art, and trains are built in the roadmap order: mail/express, military payroll, passenger hold-up, then bank.

**In the alpha**

- Horse riding, the timing-meter boarding, and the failure and cancel rules. Horse handling starts arcade, with stamina and speed tiers as test variants.
- The countdown and heat meter, with the run ending when the clock expires.
- Loot, the carry limit and extraction by whistling for the horse, which arrives after a variable delay.
- A health bar, with the downed state as a test variant.
- A wanted level that persists between runs and adds guards to later trains.
- Guards and soldiers that patrol, react when they detect you, and call for help, which raises an alarm that adds heat, plus basic passenger behavior.
- The roof hidden while the player is inside the train.
- Keyboard and mouse input.

**Not in the alpha**

- Timetables and their loot cost, which may be added later.
- Cargo and tycoon trains, and throwing crates from the train.
- Deeper progression: more horse upgrades, gear, hideout and reputation. Camps (G11a) come with the day; saved careers and town shops (G11b, G12) come before Phase 4.
- Gamepad support, full multiplayer (a network test comes right after Phase 3) and mobile. 3D rendering arrives after the network test.

**Variants to test**

| Test | Variants | Question it answers |
| --- | --- | --- |
| Run length | 2-5 minutes and 8-15 minutes | Which length is more fun? |
| Boarding input | Timing meter alone, and meter plus quick-time buttons | Which is most fun without being too difficult? |
| Health model | Health bar, and downed state | Which suits the arcade tone? |
| World structure | Separate train map, and one continuous world | Which is easier to build and more fun? |
| Loot carrying | Carry limit and weight slowdown on and off | Does it add a good tradeoff or just friction? |
| Countdown end | Size of the grace window | How forgiving should close calls be? |

**Technical guidelines for the prototype**

- Tunable values live in configuration: boarding meter difficulty, horse handling, horse arrival delay, countdown length, heat rate, grace window, guard counts per wanted level and loot density.
- Each variant above can be switched without code changes.
- Death consequences are configurable, and run state stays separate from persistent state such as banked loot and wanted level (see the game structure section).
- Randomness such as loot placement comes from a seed, so runs can be replayed and compared.
- Key events are logged for comparison: run length, boarding attempts, deaths, extractions and cancels.
- The wanted level is saved in the browser to start, with accounts left for later.

**Still to define**

- Playtest criteria, such as run completion rate, boarding failures, and deaths and retries.
- A baseline browser and hardware for the 30 fps floor and 60 fps target.
- Minimum audio and visual feedback so the countdown and heat read clearly.
- How other occlusion in the isometric view is handled, beyond hiding the roof.

## Edge cases and open questions

These are the gaps found so far, grouped by where they bite.

**Edge cases**

- Dying or being downed mid-run: all loot from that run is lost, including loot already thrown off a cargo train. Whether death also costs banked loot depends on the open roguelike question.
- Cancelling a run: loot only counts once you extract, so cancelling loses it. Cancelling rolls heat for a wanted level like every other ending (decided 2026-10-28).
- If throwing from the train is added later: crates that land in water or a ravine, or that are never collected before the next train arrives.
- On a loop, the train never leaves the map while you are aboard; only the clock expiring ends the run. On an open line under the next-town clock, the run expires when the train reaches the next town (the town at the end of the line at the latest). Under the fixed countdown, a train that reaches the end of the line ends the run as if the clock had expired.
- Close calls: if the countdown hits zero just as you jump off, a small grace window lets the player get away.

**Open questions**

- Horse handling details: speed, obstacles, how long the horse can run beside the train, and whether it can be hurt.
- Which train frequency to start with, since it is configurable. Seeded timetables exist since G6; still open: what one costs, how far ahead it looks, whether it reveals train type, loot and guards, and whether trains stop at towns (G6 trains pass through).
- How to balance each train so a less-favored approach is viable but not dominant, for example stealth on a military train.
- The horse arrival range, what makes it vary, and whether it is shown to the player.
- Whether the carry limit and weight slowdown survive playtesting, or are replaced by simpler looting.
- How riding, the timing meter and combat would work with touch controls if mobile is pursued.
- Whether the game is a roguelike, where death sets you back further, or a standard game where death costs only the run's loot and possibly some banked loot. Keep both options open.
- Which world structure wins after prototyping both a separate train map and one continuous world. The architecture must support either.
- How large the grace window is at the end of the countdown, and what counts as already extracting.
- Combat details: ammo limits, aiming with the mouse, and whether enemies can be knocked out as well as killed.
- Detection details: sight cone size, noise ranges, and how much heat each action adds.
- Leaderboard: local only at first, or tied to accounts later.
- Scale: tile size, cars per train, and how large the approach map is relative to train speed.
- The design of the prison transport train.
- The designs for the circus and haunted trains.
- Sound and music direction, and difficulty settings.
- Saving: whether progress lives only in the browser at first, or needs accounts once multiplayer arrives.
