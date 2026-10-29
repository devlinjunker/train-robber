# Phase 2 implementation plan

> Exported from the live [Phase 2 implementation plan](https://claude.ai/code/artifact/b87c9954-66b4-4b7d-b759-0f74a8eaf0fd) on 2026-10-11, refreshed 2026-10-28 for the M6 regrill. The live doc stays the working copy while Phase 2 runs. Each Phase 2 milestone PR refreshes this file from it, and when Phase 2 ends this copy becomes the final record. Decided values still live in [technical-design.md](../technical-design.md).

Oct 10, 2026 · @Devlin

## Overview

Phase 2 builds the mail/express train and with it the first full run: board, loot under a countdown and heat meter, whistle for the horse, extract and bank a score. A failed run ends with a wanted level that carries into the next one. Per the [requirements roadmap](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md#prototype-scope-and-roadmap), the gate is to decide how long one train robbery on the open line should be and how much train fills it (regrilled 2026-10-28, G31-G44).

In scope: countdown, heat, loot and carry limit (with weight slowdown as a variant), the whistle extraction with a variable horse delay, the grace window, wanted level saved in the browser, a banked score per run and in total, and enough of a guard to make heat and detection mean something. Out of scope: combat and the downed state (Phase 3), passengers (Phase 4) and the vault (Phase 5).

## Starting point

Phase 2 starts from Phase 1 as merged on main (M1 to M4, PRs #4 to #7). Since then M5 (bots, tick benchmark, gate playtest, PR #9), the log export, landing feedback and crash damage (PR #12) and the replay viewer (PR #13) have merged. The gate playtest found riding and boarding "kinda fun" but needing more going on, which is what Phase 2 adds. Devlin also wants more Phase 1 playtesting on varied maps before Phase 2 starts: draft PR #10 adds tight-loop, long-sweep, canyon-run and big-country (800 x 400, about a 197 s loop) as a map-size test, and the 400 x 200 value in the design doc stays until that playtest.

| Area | What Phase 1 left on main | What Phase 2 adds |
| --- | --- | --- |
| Run lifecycle | `idle`, `approach`, `boarding`, `aboard`, `ended`; outcomes `died` and `cancelled` | The `extracting` phase and the `extracted` and `expired` outcomes |
| Countdown and heat | `countdown.enabled: false`; no heat | Countdown from commit, heat 0-100 shortening it, grace window |
| Train | One `blank` train, engine plus 3 cars generated in code (`world/cars.ts`), blank 16 x 6 interiors | A `mail-express` train with mail cars that hold walls, props, loot slots and a guard spawn |
| Car authoring | No car pipeline; templates are code | The Tiled car pipeline (`tools build-cars`) with 3 generated starter layouts (D6) |
| Loot | None | Items, loot tables, the `search` verb, carry limit and weight slowdown |
| Horse aboard | Abstract, `mode: 'away'`, never comes back | Whistle, arrival delay, pacing beside the train, mount jump on the boarding meter |
| Persistence | `PersistentState` exists in the sim; `applyOutcome` handles died and cancelled; nothing saved by the host | `LocalStorageStore`, wanted level, bank, lifetime earned, local leaderboard (built in M5) |
| HUD | Phase, health, prompt, meter | Countdown bar, heat meter, carried loot and weight, whistle state, end-of-run summary |
| World mode | Sim runs the separate mode, but the client draws the world view aboard (M4 decision) | Stays separate mode, but the horse is physical whenever it is in the world: it runs off when you board, and the whistle places it behind the train to ride up around terrain (G3, changed in the PR #14 review) |

**Carried from Phase 1**

- Every new mechanic that has a playtest question is switchable from the URL, so it can be re-tested later in iso and 3D: a named variant group for behaviour choices, and a plain config value set with ?set= for numbers (G22, G23).
- Devlin's tuning lives in `presets/alpha-default.json`, which overrides `game.json`; new defaults go in `game.json` and Devlin's picks in the preset.
- Bigger, more varied maps were deferred until after Phase 1. Phase 2 keeps `alpha-flats` unless review decides otherwise.
- Each milestone ships as its own PR with a playable PR preview, named `claude/phase-2-m<n>-<goal>`.

## Workstreams

Six milestones, each a playable PR. M1 and M2 can run in parallel; M3 adds the guards right after the mail train, so heat and the guard catch question are playable early (G16); M4 extraction needs the mail train; M5 saving needs the outcomes from M1 and M4; M6 (three PRs: M6a, M6b, M6c) is the tests, the heat changes and the line gate.

### M1: Countdown, heat and run end

- [x] Turn on `countdown` for runs: `run.countdownSec` = train `countdown.baseSec` x `countdown.scale`, started at commit (U1)
- [x] Heat 0-100 in `RunState`, with `raiseHeat` as the one helper and drain rate `1 + heatDrainFactor x heat/100` (U2)
- [x] `heat.sources` map in `game.json`; emit `HeatChanged` with its cause
- [x] `expired` outcome when the countdown hits zero, after the grace window (U3); `outcomePolicy.expired` adds one wanted level
- [x] `countdown.scale` and `loot.densityScale` as plain config values (G22), plus a generic URL override such as `?set=countdown.scale=4`, recorded in the log header
- [x] `countdown.graceSec` as a plain config value (G23)
- [x] HUD: countdown bar with colour steps that visibly speeds up and shows its drain rate (G10), heat meter with three bands, a text notice per heat gain
- [x] Placeholder audio through an `AudioBus`: countdown tick that speeds up under 20%, alarm sting
- [x] `RunEnded` carries countdown left and heat; cancels keep their time left (U6)
- [x] `heat.boardingResistanceAt` hook, off by default (G30); `heat.sources.timeAboardPerSec` 0 by default with a playtest preset at 0.2 (G26); after the M1 playtest the default is 0.33 and a `no-time-aboard-heat` preset turns it off

Built in the M1 PR (branch `claude/phase-2-m1-countdown-heat`). The grace check is a hook that stays shut until M4 brings the horse alongside. With no loot or guards yet, H raises heat by 10 and Shift+H raises an alarm's worth, so the meter, drain and alarm sting can be playtested. The blank train uses a 150 s countdown base until the mail train lands.

### M2: Mail train and loot

- [x] `mail-express` train config: engine, 3 mail cars, caboose, speed, `countdown.baseSec`, loot table and density, entry points
- [x] Tiled car pipeline (`tools build-cars`, D6) and 3 generated starter mail car layouts with walls, props, loot slots and a guard spawn, for Devlin to edit
- [x] `items.json` and `loot-tables.json` (`mail-small-items`): value, weight, category, slot tags; mostly small items plus one or two heavy prizes per train, and a drop command to swap items (G13)
- [x] Run generation: build the committed train's cars and fill loot slots from the `gen` stream; two layouts per car type picked by seed
- [x] Walk between cars through end doors, so the whole train is one interior (multi-car interiors were deferred to Phase 2 in the ideas list)
- [x] Car count, search time and hidden loot as plain config values (G2, G23), plus ready-made playtest presets
- [x] `search` verb: hold E on a loot slot for `searchTimeSec`, then `LootPickedUp` and `lootTaken` heat
- [x] Carry limit and weight slowdown as separate flags (C3), with slowdown from 6 to the 10-unit max and a 20-item cap (G25); `lootCarry` variant group (`limit-and-slowdown`, `unlimited`)
- [x] Cell catalog `cell-types.json` with movement and sight; noise values wait for M3
- [x] Iso renderer draws the mail car interior, loot slots and props; HUD shows carried value and weight
- [x] Trains on the map: mail by default, blank decoys mixable per map or by the trainMix variant group (all-mail, mixed, mostly-blank), and an option to hide train names on the off-screen arrows (G17)

Built in the M2 PR ([#17](https://github.com/devlinjunker/train-robber/pull/17), branch claude/phase-2-m2-mail-train-loot). There are three mail layouts (doors on both sides, one side, end doors only) plus engine, caboose and a blank car, and each train's layouts are picked from the next run's seed so doors show before you commit. `requireSideDoors: both` swaps picks so every mail train can be boarded from either side. Loot density is the share of a train's eligible slots that get a small item. Each pickup raises `lootTaken` heat and `loot.densityScale` scales density (wired in after M1 merged). `?car=<id>` opens one car on its own with overlays for checking a layout.

After Devlin's M2 playtest (2026-10-14): search time per item (letters 0.8 s, large prizes 2.2 s, `verbs.search.timeScale` for the slow preset), hidden loot on by default, an inventory panel (I, then 1-9 drops that item), loot slots in the caboose, a walkable engine cab behind the boiler, long trains capped at 2 door cars with less loot (`maxSideDoorCars`, `loot.densityScale` 0.7), blank cars a slightly greyer brown, and the carry stats under the health bar. Then (Devlin, 2026-10-14): a hidden stash takes 1.8 s to search and reveals its item to be searched again, mixed trains are the default (preset map-trains for the map's own trains), long-train leaves run length to `countdown.scale`, and the engine's front is solid wall. Open from it: maps feel small for long trains, and a 10-minute run is too long for looting alone until guards arrive.

### M3: Light guards and detection

- [x] Guard actors spawned from car guard spawns, count from config and wanted level
- [x] Patrol along car routes; stand watch without one
- [x] Sight cone with a precomputed cosine threshold and wall blocking; noise radius from footsteps and running
- [x] Suspicious then alert; spotted adds `playerSpotted` heat, alert raises an alarm (`alarmRaised` heat)
- [x] No combat yet: `guardCatch` variant group (G4) with `heat-only` and `thrown-off` (alert guards chase; contact throws you off the train and costs half your carried loot)
- [x] Debug overlay draws sight cones; HUD notice when spotted
- [x] Horse boost (G20): a short burst above top speed with a cooldown, on by default, switchable through `handlingModel` (`arcade-boost`, `arcade`)

Built in the M3 PR ([#28](https://github.com/devlinjunker/train-robber/pull/28), branch claude/phase-2-m3-guards-boost, v0.2.3). The mail express carries 3 guards (`trains.mail-express.guards.base`); the wanted-level bonus reads through `wantedGuardBonus`, which returns 0 until M5. Guards turn amber when suspicious and red when alert. Sight is 7 tiles in an 80° cone, and hearing is 1.5 tiles walking and 5 running, times the floor's noise. These guard numbers are Claude's picks and are all config under `ai.*`. Boost is on C. After Devlin's playtest on 2026-10-18: chase speed is 4 tiles/s, being thrown off loses half your carried items, picked at random (`ai.thrownOffLootShare`), sight cones are drawn faint by default (`?cones=on` full, `?cones=off` hidden), a footstep ring (`?noiseRing=off` hides it) and an ear over the guard's head show when noise gives you away, and boosting kicks up dust (`?boostDust=` scales it). Switching trains now regenerates loot as well as guards.

### Sneaking: outside the train and stealth (added 2026-10-17)

After playtesting M3, Devlin wants to sneak past guards. The design and its seven decisions are in [Outside the train: roofs, ledges and stealth](https://claude.ai/code/artifact/5a6a4ecc-15cc-4747-9326-52c30881cc98). It pulls the roof forward from Phase 3 (changes G29) and grows cars from 16 x 6 to 28 x 7. Thrown-off became the default guard catch, with about 2 guards per 3 cars. Three PRs, in order, each after the one before; none waits on M4:

- [x] Stealth inside and bigger cars (PR #33, v0.2.4-sneaking-1): crouch (C aboard), cover of 0.25 or more (crates, barrels, benches) blocks sight to a crouched player, 28 x 7 layouts (cars about 5 tiles tall, visual only), chasing guards give up after `ai.loseSightSec` and stay alert. Playtest (2026-10-20): sight 10 tiles, crouch noise 1 tile, searching loot noise 3 tiles, generated maps curviness 0.2; car spacing moves to the platforms PR
- [x] Platforms and side ledges (PR #35, merged as v0.2.4): half-tile end platforms and a 1-tile coupling gap (cars 2 tiles apart, crossed on a 3-tile plate), 0.1-tile side ledges, any size walkable, platforms 4 tiles/s walk-only, ledges 1.2 tiles/s and heard through the wall while moving, guards see you through windows and outer doors (and 30 tiles along a ledge), suspicious guards walk over and step outside, chasing or searching guards follow you out, good landings stagger you in loudly, trackside rocks scrape you or knock you off onto the horse (`FellOff`, doors stay open), two big-window mail layouts; values under `outside.*` and `ai.*`
- [ ] Roof: ladders at end platforms, gap jumps with hang-and-climb, leaning toward the edge on curves (a skill check, never random), loud footsteps for guards below, guards climb up after you

Side ladders for boarding straight onto the roof, and landing on foot after a fall, stay for later (wiki Ideas page).

### M4: Extraction

- [x] `whistle` (F) moves the run to `extracting` and draws the arrival delay from the `horse` stream (U4)
- [x] Horse states `away`, `approaching`, `alongside`, `leaving`, with `extraction.paceWindowSec` and a re-whistle cooldown
- [x] Physical horse (G3, changed): after boarding it runs off for horse.runOffSec and is removed; the whistle places it behind the last car on your side at the distance the seeded 5-20 s delay takes to close, and a steering AI rides it up a lane 2 tiles out from your car, pathing around blocked and water tiles. A second whistle sends it to the other side, crossing behind the train; HUD notice if it is blocked; after the pace window it drops back and is removed
- [x] Mount jump on the boarding meter at its own difficulty (`extraction.meter.*`); perfect mounts clean, good (amber) mounts but spills loot (`mountSpill` variant: `random`, `heaviest`, `share`; G15), fail leaves you on the train with failure damage to retry (G14)
- [x] `extracted` outcome when the mount lands; loot is cashed out at that moment
- [x] Grace (G18): while the horse is alongside and you are within reach of a door on its side, expiry waits up to `countdown.graceSec`
- [x] Events `HorseWhistled`, `HorseArrived`, `HorseDeparted`; horse visible approaching with hoofbeats when close; the `horseArrivalCue` timer variant was built, then removed after the M4 playtest (2026-10-19): seeing the horse is enough (G11)

Built in PR [#29](https://github.com/devlinjunker/train-robber/pull/29), branch `claude/phase-2-m4-extraction` (v0.2.4). Also there: `HorseSideChanged`, `HorseBlocked`, `MountAttempt` and `LootSpilled` events, `RunEnded.cashOut`, presets `arrival-timer`, `spill-heaviest` and `spill-share`, and an Extracted column on the Playtests page. The horse starts behind your car by the distance the delay closes at 14 against 9 tiles/s, at least 4 tiles behind the last car. Claude's picks to playtest: drop back 3 s, alongside within 3 tiles, mount reach 4 tiles, door reach 1.5 cells, share spill 30%. Whichever of M3 and M4 merges second makes `guardCatch: thrown-off` place the horse beside you: done when M3 merged into it (2026-10-19), and guards keep watching while you extract.

### M5: Wanted level, persistence and score

- [x] Full `outcomePolicy` (extracted, expired, died, cancelled) through `rules/applyOutcome`, unit-tested as a table
- [x] `PersistentStore` with a versioned `LocalStorageStore`: `wantedLevel`, `bank`, `lifetimeEarned`; a bad or newer save is backed up and reset with a notice
- [x] Wanted level 0-5 read at run generation: `wanted.guardBonus` plus `trains.<id>.guards.perWantedLevel`
- [x] Local leaderboard: score, seed, config hash, variants, date. A `wanted.forceLevel` option (preset or `?wanted=`) sets the run's wanted level; such runs save nothing (G8, G9)
- [x] End-of-run summary screen: outcome, loot banked, time, heat, wanted level change, quick retry
- [x] Log header records persistent state at start; `PersistentChanged` on every outcome

Built in the M5 PR (branch `claude/phase-2-m5-wanted-persistence`, v0.2.5). `applyOutcome(persistent, outcome, { cashOut }, policy, maxLevel)` covers all five outcomes (cashedOut too), keeps wanted level within 0 to `wanted.maxLevel` and never lowers lifetime earned; the cash-out after being thrown off banks only what the throw left, and a good mount banks what the spill left. Every run end emits `PersistentChanged` (with its outcome), changed or not, and the host saves on it. The save lives in localStorage under `train-robber.save` (version 1; an unversioned save migrates, a corrupt or newer one is copied to `train-robber.save.backup.<time>` and reset with an on-screen notice). Wanted level adds `wanted.guardBonus` [0, 1, 1, 2, 2, 3] guards by level (Claude's pick), plus `guards.perWantedLevel` × level per train (0 on the mail train), capped by the train's guard spawns (5 to 6 on three mail cars). `?wanted=N` is short for `?set=wanted.forceLevel=N`; the `wanted-3` preset sets 3. Forced runs are practice: the HUD, the run start notice and the summary say so, and wanted level, bank, lifetime and the leaderboard stay as they were. Reset save is a button with the debug overlay (`` ` ``) and `?resetSave=1`; both confirm first and back the old save up. The summary panel shows the outcome, loot banked (or lost), loot lost on the way, items, time, heat, the wanted level change, the bank and the best runs, with Quick retry and Close (`?summary=off` hides it; it stays until closed or the next commit). After Devlin's playtest, every guard throw-off adds a wanted level (`wanted.perThrowOff`), and a throw that shuts the doors ends the run `caught` (`cashOut.shutDoorsEndRun`), so the run can't get stuck. The HUD shows the wanted level as stars next to the phase. The Playtests page has Wanted and Bank columns, a practice filter, and lost loot under Loot.

### M6: Tests, tuning and the line gate

M6 is roadmap step 9, regrilled with Devlin on 2026-10-28 (G31-G44 below). The gate is now played on the open line, not the loop maps: it asks how long one train robbery should be and how much train fills it. The loop maps stay for automated tests only and will not be offered to players. M6 ships as three PRs in this order.

**M6a: Playtests page** (no game changes; can start before M5 and G6 merge; branch `claude/phase-2-m6a-playtests-page`)

- [ ] Experiments: a question plus 2-4 named setups, each with a Play link, labelled by its difference from the default ("towns gap 1,600, 4 cars") and an editable base setup (G40)
- [ ] Repo experiments in `content/playtests/*.json`, read-only on the page; your own built on the page (preset, variant dropdowns, `?set=` rows) and saved in the browser; Duplicate, Copy as file and Share link (G41). A shared experiment is saved to the Playtests page of whoever opens it: the Share link carries the experiment in the URL, and opening it (or a Play link from it, or importing its file) adds it to that person's own experiments (Devlin, 2026-10-28)
- [ ] Runs tagged from the Play link (`?exp=<id>&setup=<id>`), so imported runs from other testers land in the right card
- [ ] Experiment card: setups side by side, only the 4-6 numbers its question names, notes per setup, an answer box carried by the notes export and Send to GitHub
- [ ] Session pull on every experiment card: how often a new run starts within 30 s of the summary screen, and which outcome ended each session; every answer box also asks "What would you try next time?", "Did you see a prize or route you left behind?" and "Did you want to go again? Why?" (G45, from the wiki progression review's step 9 priority)
- [ ] Run list split into views: Robbery (default), Boarding (the Phase 1 stats), All; about 7-8 columns each; click a run to expand seed, variants, damage, logs, Watch and notes (G39)
- [ ] Header tidied: export, import and GitHub in one Export menu; filters on one line, version first
- [ ] Rule from now on: a milestone adds its numbers to a view and the expanded run, never as a column everywhere (wiki Playtesting and project memory)

**M6b: Heat drives guards and wanted** (needs M5, PR #46; branch `claude/phase-2-m6b-heat-wanted`)

- [ ] Heat never changes the clock (already true on the line). Delete `heat.heatDrainFactor`, `heat.sources.timeAboardPerSec` and the `no-time-aboard-heat` preset rather than setting them to 0; old logs and saved experiments that name them load with a warning (G34, G35, G55)
- [ ] Heat only rises within a run: it is the record of this robbery, so a clean run stays easier than going in loud. Loot heat `heat.sources.lootTaken` goes from 1 to 2 per item. The heat band edges (a third and two-thirds of max heat) move from the HUD into game config so guards and the HUD share them (G52)
- [ ] `heatGuards` (on by default): heat bands low / mid / high scale every guard on the train. In-car sight range +0 / +2 / +4 tiles (10 / 12 / 14; ledge range and cone angle unchanged), calm-down 4 / 5 / 6 s, searching before giving up 3 / 4 / 5 s, hearing ×1 / ×1.15 / ×1.3, chase 4 / 4.5 / 5 tiles/s, guards walking rounds instead of standing posts +0 / +25% / +50% (rounds need guard rounds, PR #51; added after if it isn't merged) (G34, G49, G53)
- [ ] `guardMemory` (on by default): a guard that goes alert (not just suspicious) remembers you for the rest of the run, for that guard only: in-car sight +5 tiles and hearing ×1.25 on top of the band (15 / 17 / 19 tiles), no change to chase. A lasting red-eye badge marks it (`?remembers=off` hides it); faint cones draw at the real length; the footstep ring stays the base radius (G49, G50, G54)
- [ ] Every number above is config, changeable with `?set=` (G51)
- [ ] Heat roll: at every run end, heat % is the chance of +1 wanted level, extractions included; the roll is seeded from the run so replays match; `outcomePolicy.<outcome>.heatRoll` turns it off per outcome; expired still adds +1 outright (G35, G37)
- [ ] Wanted decays by a `wanted.decay` rule (none, per-day, per-quiet-day; experiment 6 decides, G46), default `wanted.decayPerDay` 1 at each new day; paying it off with bank comes with careers and towns (G36)
- [ ] Debug End day key K (off a run only, a sim command so replays match): the same day end as death today (full health, day +1, the wanted decay rule runs). No stop-gap day logic before G8's day clock: no runs-per-day and no saving the day across reloads (G56)
- [ ] Wanted level does not raise heat or guard alertness; it only adds guards (M5) (G57)
- [ ] Summary screen and Playtests page show heat at end, the roll's chance and whether it hit

**M6c: Tests and the gate** (needs G6, PR #47, and M6b; bumps to 0.2.6; branch `claude/phase-2-m6c-tests-gate`)

- [ ] Loop golden fixed to loot, whistle and extract (it cancels today), plus a short line golden that boards, loots and extracts before the next town; mid-extraction snapshot round trip (G38)
- [ ] Looter bot (loots, whistles, extracts) beside the idle bot; CI runs both over 1,000 loop seeds and 25 line seeds; invariants for heat 0-100 and carry (G38)
- [ ] `tools report --line`: the looter over a few hundred line seeds per spacing preset, on demand, not in CI; reads exported playtest logs too
- [ ] Robbery numbers recorded per run: time aboard, town clock left at boarding, bag fill %, loot value per minute, loot value left on the train when you got off, how it ended, heat at end and the roll
- [ ] Line made long enough for 3+ towns in every spacing preset; presets for each gate experiment (below)
- [ ] The gate shipped as experiment `phase-2-gate` in `content/playtests/`, with a "Phase 2 gate" section on the wiki Playtesting page: the questions, how to play each experiment, and how to customize setups on the page or with `?set=` (G42)
- [ ] Playtest question comment on the PR, one per gate question, plus "Would you pay for the full game after this? What would make you?" (G45); experiment 7's boon pick screen after extraction if it is built (G47)

**The gate questions** (G43). Played in order: experiment 1 first, then 2-6 start from the spacing it picked.

| # | Question | Setups to compare | What the answer sets |
| --- | --- | --- | --- |
| 1 | Which town spacing makes a robbery tense without dragging? | towns-tight (\~1,100 tiles, \~2 min, 3 cars), towns-mid (\~1,600, \~3 min, 4 cars), towns-wide (\~2,200, \~4 min, 6 cars) | Town spacing for G6 |
| 2 | Do you run out of train before the clock, or the clock before the train? | 3, 4, 6 mail cars | Cars per train |
| 3 | Does a 10-weight bag fill at a good moment, and does "full bag, find the next train" feel good? Would +5 carry feel worth buying, or just easier? (progression: stats or options) | carry 6, 10, 15 | Baseline carry, and whether a carry upgrade is worth having |
| 4 | Does the coming town change where and when you board, and can you read the time left? | town clock always shown, only in the last minute | Clock HUD |
| 5 | Can you feel heat in how guards act, and is high heat too harsh? | off (`heatGuards` and `guardMemory` off), bands only (`guardMemory` off), default, harsh (loot heat 3, alert bonus +8 sight and ×1.5 hearing) | Heat band values |
| 6 | Should wanted level go down on its own, and does the roll feel fair? (progression question) | no decay, 1 per day, 1 per quiet day (only after a day where no robbery added wanted), each starting at wanted 3, with the End day key (K) to end days | Wanted decay rule (G46) |
| 7 | Optional, after 1-6. Does a build that grows between trains make the third train feel different from the first? (progression: roguelite career or arcade mastery) | three trains in a row, with or without a pick of 1 of 3 boons between them (+1 carry, quieter steps, faster whistle, as config changes) | Whether to lean toward a career or toward arcade mastery and co-op (G47) |
| 8 | Measured, not asked: how many robberies fit in a 12-minute day at the chosen spacing? | from the run numbers | Trains per day for G8 |

**Pass bar** (G44): no numeric threshold; Devlin judges by playing. It passes when a full robbery on the line (find, board, loot, get off before the town) is fun enough to play three times in a row. If it fails, tune and replay before G7 and the Phase 3 plan start. The answers go into the technical design and G6's town spacing.

## Variants and switches by milestone

Every playtest switch Phase 2 builds, and the milestone whose PR builds it. Variant groups are behaviour choices picked with ?v=group:option. Values are numbers or on/off flags set with ?set=path=value. Presets are named bundles in presets/ picked with ?preset=. Each preset ships in the same PR as the switch it uses, so every milestone preview can be playtested on its own. M6 links them all from the wiki Playtesting page. Defaults come first in each list.

| Switch | Kind | Options (default first) | Question it answers | Milestone |
| --- | --- | --- | --- | --- |
| countdown.scale | Value | 1; medium-run preset sets 4 | Short vs medium run (the phase gate) | M1 |
| loot.densityScale | Value | 1; scales with countdown.scale in the medium-run preset | Does a longer run need more loot | M1 |
| countdown.graceSec | Value | 3 s | How forgiving a close extraction feels | M1 |
| heat.sources.timeAboardPerSec | Value | 0.33 (was 0 with a 0.2 preset until the M1 playtest) | Should lingering aboard raise heat (G26) | M1 |
| heat.boardingResistanceAt | Value | off (hook only until combat) | Guards resisting boarding at high heat (G30) | M1 |
| ?set=path=value override | URL mechanism | any config value, logged in the header | Lets every value above be tested without a preset | M1 |
| medium-run preset | Preset | countdown.scale 4 | Short vs medium run | M1 |
| no-time-aboard-heat preset | Preset | timeAboardPerSec 0 | Lingering heat off | M1 |
| lootCarry | Variant group | limit-and-slowdown, unlimited | Does carry weight make choices interesting (C3) | M2 |
| carry.maxWeight, carry.maxItems, carry.slowdownFrom | Values | 10, 20, 6 | Carry limit tuning (G25) | M2 |
| Train cars count | Value | 3; long-train preset sets 6, with side doors on at most 2 cars and loot density × 0.7 (M2 playtest) | Does a longer train fill a medium run (G2) | M2 |
| verbs.search.searchTimeSec | Value | 1.2 s, with per-item times (letters 0.8 s, large prizes 2.2 s) since the M2 playtest; slow-search scales all by 2.5 | Does slower looting fill a medium run (G2) | M2 |
| Hidden loot | Value (on/off) | on since the M2 playtest (Devlin, 2026-10-14), so stashes can be missed; searching one (`hiddenSearchTimeSec` 1.8 s) reveals the item to grab | Same as above | M2 |
| trainMix | Variant group | mixed (default since Devlin 2026-10-14), map (the map's own trains and trainType), all-mail, mostly-blank | Are blank decoy trains interesting (G17) | M2 |
| Hide train names on arrows | Client option | names hidden (Devlin, 2026-10-14) | Does a mix only work as a guess (G17) | M2 |
| long-train (no countdown change), slow-search presets | Presets | as above | What fills a medium run | M2 |
| doors-both-sides preset | Preset | train picks only layouts with doors on both sides | Restricted doors vs doors everywhere (G21) | M2 |
| guardCatch | Variant group | thrown-off, heat-only | What an alert guard does without combat (G4) | M3 |
| handlingModel | Variant group | arcade-boost, arcade | Is the horse boost worth it (G20) | M3 |
| Boost values | Values | 1.5 s, +40%, 6 s cooldown | Boost tuning | M3 |
| mountSpill | Variant group | random, heaviest, share | What a good (amber) mount costs (G15) | M4 |
| horseArrivalCue | Removed 2026-10-19 | (was visible, visible-timer) | Answered in the M4 playtest: seeing the horse is enough (G11) | M4 |
| Horse delay, alongside, re-whistle, run-off, lane | Values | 5-20 s (sets the spawn distance), 10 s, 5 s, 3 s, 2 tiles | Extraction tension tuning (G12, G24) | M4 |
| Mount meter | Values | 3% perfect, 15% good, 1.85 s | Mount difficulty | M4 |
| wanted.forceLevel (?wanted=) | Value | none; forced runs save nothing | Play any wanted level without grinding (G9) | M5 |
| Reset save (button and ?resetSave=1) | Tool | off | Start fresh while playtesting (G27) | M5 |

Two defaults are my picks where the review didn't name one. guardCatch defaulted to heat-only; after the M3 playtest (2026-10-17) Devlin made thrown-off the default, with a heat-only preset in place of the thrown-off one. Restricted versus all doors is a preset that sets the train's layout list, because G21 said no separate all-doors switch. The full preset list (13, including no-carry-limit, map-trains (was mixed-trains), heat-only (was thrown-off), no-boost, arrival-timer, the spill presets and wanted-3) is in the technical design's Phase 2 starting spec. Existing Phase 1 switches (steering, throttleModel, boardingFailure, collisionDamage, commit.auto) carry over unchanged. (commit.auto was replaced on 2026-10-17 by the commit prompt: `commit.timerSec` and `commit.closeRangeTiles`.)

## Decided values

These are copied from [docs/technical-design.md](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md), which stays the source of truth; changing one means changing that doc first. Values marked placeholder in the design doc are starting points for tuning, not decisions.

| Topic | Value | Source |
| --- | --- | --- |
| Countdown start | At commit, not at boarding | U1, confirmed |
| Countdown length | Train `countdown.baseSec` x `countdown.scale`; mail placeholder 150 s | Configuration, U7 |
| Heat | 0-100; drain rate `1 + heatDrainFactor x heat/100`; time-spent heat 0 and decay 0 by default | U2 |
| Heat sources (placeholders) | shotFired 2, alarmRaised 15, playerSpotted 5, actorKilled 8, lootTaken 1, timeAboardPerSec 0.33 | Systems |
| Grace window | While the horse is alongside and you are within reach of a door on its side; 3 s (G18) | U3 |
| Extraction | One whistle arms the horse; the physical horse is placed behind the train at a seeded 5-20 s catch-up distance and rides up around terrain, visible from behind (timer optional), coming up on the side you are nearest; alongside 10 s, re-whistle 5 s later; the mount meter's perfect mounts clean, good spills loot, fail leaves you aboard to retry (G3, G11, G12, G14, G24) | U4 |
| Cash out | The moment the extraction mount completes | Flags, open items |
| Outcome policy | extracted banks loot, wanted +0; expired loses loot, wanted +1; died and cancelled lose loot, wanted +0 | Run state, U5, U6 |
| Persistence | wantedLevel, bank, lifetimeEarned (never decreases, leaderboard source); browser storage first | C2, confirmed |
| Wanted level | Levels 0-5, extra guards per level from a config table, no decay | U11 |
| Carry | Carry limit and weight slowdown are separate flags, both on by default; max 10 weight units and 20 items, slowdown from 6 units to 50% speed at the max (G25) | C3 |
| Run length | The plain value `countdown.scale` (with `loot.densityScale`) scales countdown and loot density; minute ranges are outcomes, not inputs (U7, G22) | U7 |
| Mail train | Speed and stealth, short run, many small items, light guards, `search` verb with no decoys | Train verbs |
| World mode | Separate map built first; continuous stays supported | U8, confirmed |
| Reference machine | 2019 MacBook Pro, Chrome and Safari; baseline recorded before Phase 2 | Build order |

## Testing and acceptance

Phase 2 is done when a full mail run can be played from commit to banked score on the open line, and the gate experiments pick town spacing and train length (G31-G44).

**Automated, in `npm run check` and CI**

- `applyOutcome` table test covering every outcome and policy field, including that `lifetimeEarned` never decreases
- Golden run on the mail train that loots, whistles and extracts; the hash is stored
- Snapshot round trip in the middle of `extracting`, and with loot carried
- Run generation test: the same seed and run number give the same cars and loot on any machine
- Bots over 1,000 seeds: the idle bot always expires; the scripted looter never breaks heat 0-100 or the carry limit when it is on; no crashes
- Every preset and variant combination resolves in `tools validate`
- Tick-time benchmark (from Phase 1 M5) stays under its threshold with guards and loot on the train
- Save tests: a corrupt or newer-version save is backed up and reset

**By hand, on the PR preview**

- Short and medium runs both reachable from the URL (`?set=countdown.scale=4`)
- The countdown and heat read clearly without the debug overlay
- A close call inside the grace window extracts; one just outside expires
- Wanted level survives a reload and adds guards on the next run
- Frame time on the reference machine stays above 30 fps in Chrome and Safari

**Gate (changed 2026-10-28, G31-G44):** played on the open line as six experiments on the Playtests page (see M6), to pick town spacing, cars per train and baseline carry, and to check heat and wanted. As in Phase 1, there is no numeric threshold: it passes when a full robbery on the line is fun enough to play three times in a row. `tools report --line` and the Playtests page numbers (time aboard, bag fill, loot per minute, how it ended) are support.

## Questions and answers

Every question here was answered on 2026-10-11; the G numbers point to the full decision under Decisions from review.

| ID | Question | Answer |
| --- | --- | --- |
| Q1 | Build the continuous world mode (a physical horse beside the train) in Phase 2? | Partly. The horse is physical in Phase 2, placed behind the train on the whistle (G3, changed); the world-structure test is revisited later |
| Q2 | Add guards in Phase 2, or leave all AI to Phase 3? | Light guards in M3, before extraction: patrol, sight cone, noise, alarm, no combat (G4, G16) |
| Q3 | What happens when a guard catches you before combat exists? | `guardCatch` variant: `heat-only`, or `thrown-off` back onto your horse, stunned (G4, G5) |
| Q4 | Author mail cars in Tiled, or keep generating them in code? | Tiled with `tools build-cars`; Claude generates 3 starter layouts to edit (D6) |
| Q5 | Keep the blank train in the loop beside the mail train? | Every train is a mail train by default; `trainMix` mixes in blank decoys (G17) |
| Q6 | Where can you board the mail train? | Only some cars have side doors, set by each layout's `entryPoints`; a variant limits a train to layouts with doors on both sides (G21) |
| Q7 | Countdown base and scales for short and medium runs | Base 150 s, `countdown.scale` 1 as a plain value; a medium preset sets 4 (G22, G24) |
| Q8 | Horse arrival delay, pace window and re-whistle cooldown | Delay 5-20 s, alongside 10 s, re-whistle 5 s later (G24) |
| Q9 | Mount meter difficulty | Boarding zones (3%, 15%) at the 1.85 s matched sweep; a good mount spills loot (G14, G24) |
| Q10 | Carry limit and slowdown | Max 10 weight units and 20 items; slowdown from 6 units to 50% at the max (G24, G25) |
| Q11 | Temporary heat from time aboard until guards land? | A config value to test: 0 by default, a playtest preset sets 0.2 (G26) |
| Q12 | Does moving cancel a search in progress? | You can slow-walk at 30%; releasing E or moving more than 1.5 tiles away cancels and loses progress (G27) |
| Q13 | Keep the `alpha-flats` map for Phase 2? | Use whichever map the PR #10 map playtest picks; see Q19 |
| Q14 | How do playtesters reset wanted level and bank? | A Reset save button in the debug overlay and `?resetSave=1`, both confirming first (G28) |

**From the ideas list.** These come from [docs/ideas.md](https://github.com/devlinjunker/train-robber/blob/main/docs/ideas.md). Multi-car interiors are already added to M2 as a task. Everything else in that list (cargo and later trains, progression, timetables, 3D, multiplayer, gamepad, procedural tracks) stays out of Phase 2.

| ID | Question | Answer |
| --- | --- | --- |
| Q15 | Build the roof route in Phase 2? | No, Phase 3. Side ladders for boarding straight onto the roof are recorded on the wiki (G29) |
| Q16 | Add the limited horse boost? | Yes, on by default in M3, switchable through `handlingModel` (G20) |
| Q17 | Guards shooting at the rider while boarding at high heat? | Shooting waits for Phase 3; the `heat.boardingResistanceAt` hook (off) lands in M1 (G30) |
| Q18 | Build an in-game panel for switching variants? | No. Ready-made preset links on the wiki Playtesting page instead (G7) |
| Q19 | Grow the map or add a track layout in Phase 2? | Settled by the Phase 1 map playtest in draft PR #10 (big-country is 800 x 400). If it picks a bigger map, the 400 x 200 decided value changes with Devlin's OK before M6 |
| Q20 | Trains that restrict where you can board? | Mail already does (Q6, G21) |

## Decisions from review

Decisions from grilling the plan with Devlin, newest last.

| # | Question | Decision | Date |
| --- | --- | --- | --- |
| G1 | What fills a 10-minute medium run on a 3-car mail train? | Test both: a longer train with more loot (for example 6 cars) and slower looting (longer search, hidden loot) | 2026-10-11 |
| G2 | Should train length and search speed ride along with run length? | Separate knobs, all plain config values (per G22 and G23): `countdown.scale` with `loot.densityScale`, the train's car count (3, or 6 in a preset) and the search time plus a hidden-loot flag. Ready-made presets cover the main combinations, and the design doc's U7 says the same | 2026-10-11 |
| G3 | Real horse or scripted horse for extraction? | Changed 2026-10-11 in the PR #14 review: a horse ignoring rocks looks wrong in the world view, so the Phase 2 horse is physical. It runs off and is removed when you board; the whistle places it behind the train at a seeded distance that takes 5-20 s to close, and it rides up around terrain. Whistling again switches it to your side. (Was: a scripted horse riding a lane, ignoring terrain.) | 2026-10-11 |
| G4 | What happens when a guard spots you, before combat? | Test both as a `guardCatch` variant group: `heat-only` (spotted and alarm raise heat) and `thrown-off` (an alert guard chases you; contact throws you off the train like a failed boarding, costing time and health; changed 2026-10-18: you lose half your carried loot, `ai.thrownOffLootShare`) | 2026-10-11 |
| G5 | Where do you land when thrown off? | Back on your horse beside the train, stunned, as after a failed boarding. Landing on foot and whistling for the horse goes on the wiki Ideas page | 2026-10-11 |
| D6 | How do mail cars get their layouts? | Drawn in Tiled with `tools build-cars` (answers Q4). Claude generates 3 starter mail car layouts as .tmj files for Devlin to edit | 2026-10-11 |
| G7 | How to play through the switches? | Free play, with a few ready-made presets for the main questions (run length, train length, search pace, guard catch), linked from the wiki Playtesting page. Answers Q18: no in-game panel yet | 2026-10-11 |
| G8 | Should wanted level follow you between presets? | One shared save, plus a config option (settable by preset or URL) that sets the wanted level a run uses, so presets can be compared from the same starting level | 2026-10-11 |
| G9 | What does a run with a set wanted level save? | Nothing: it is practice, and leaves wanted level, bank, lifetime earned and the leaderboard untouched. The end-of-run summary says so | 2026-10-11 |
| G10 | Should heat do anything besides speed up the clock? | Only the clock in Phase 2, made obvious: the countdown bar speeds up and shows its drain rate (for example x1.6). Heat levels that change guard behaviour go on the wiki Ideas page | 2026-10-11 |
| G11 | Should you know when the horse will arrive? | You see it coming: the horse appears behind the train and rides up to your car, with hoofbeats when close. A HUD timer is an option on top: horseArrivalCue variant group with visible and visible-timer | 2026-10-11 |
| G12 | Which side of the train does the horse come up on? | The side of the car you are nearest when you whistle | 2026-10-11 |
| G13 | What makes the carry limit a real choice on the mail train? | Mostly small items plus one or two heavy, valuable prizes per train (strongbox, registered mail sack). Items can be dropped to swap, which needs a new drop command | 2026-10-11 |
| G14 | What happens on each mount jump result? | Perfect: clean mount. Good (the amber zone): you land on the horse but spill loot. Fail: you stay on the train, stumble, take the usual failure damage, and can retry while the horse is alongside; after its pace window, re-whistle after the cooldown | 2026-10-11 |
| G15 | What spills on a good mount? | Playtest all three as a mountSpill variant group: random (one item at random, the default, drawn from a seeded stream), heaviest (your heaviest item) and share (a fraction of carried value). Spilled loot is gone for the run | 2026-10-11 |
| G16 | Should guards come before extraction? | Yes. New order: M1 countdown and heat, M2 mail train and loot, M3 light guards, M4 extraction, M5 wanted level and saving, M6 tests and playtest | 2026-10-11 |
| G17 | Which trains run on the map? | Configurable. Default: every train is a mail train. A map or preset can mix in blank trains as empty decoys (per-track trainType from PR #10). A client option hides train type names on the off-screen arrows so a mix stays a guess; names hidden by default (changed from shown by Devlin, 2026-10-14). A trainMix variant group switches mixes: all-mail (default), mixed (about half blank) and mostly-blank; it overrides the map's trainType. Mixed became the default (Devlin, 2026-10-14) | 2026-10-11 |
| G18 | What counts as already escaping when the clock runs out? | The horse is alongside and you are within reach of a door on its side: expiry waits up to the grace window, so you get a last try or two. Updates the wording of U3 in the technical design | 2026-10-11 |
| G19 | How does wanted level come down? | No way down in Phase 2 (Reset save while playtesting). Tracked on the wiki Ideas page and in the technical design as required before progression: a way to lower wanted level, such as a clean getaway or decay | 2026-10-11 |
| G20 | Should the horse get a boost now? | Yes, on by default: a short burst above top speed with a cooldown, built in M3 with the guards. A handlingModel switch (arcade-boost default, arcade without it) turns it off. Answers Q16 | 2026-10-11 |
| G21 | Where can you board the mail train? (Q6, Q20) | Restricted: only some mail car layouts have side doors, set by each layout's `entryPoints` layer in Tiled and drawn on the car's outside in the world view. Where you board and where you mount matter, since the horse comes up on your side and you may need to walk to a car with a door on that side. To compare with doors everywhere, a variant limits the train to layouts with doors on both sides, so at least one starter layout has them; there is no separate all-doors switch | 2026-10-11 |
| G22 | Run length as named options or a number? | A number: drop the runLength variant group; countdown.scale (and loot.densityScale) are plain config values. A generic URL override (for example ?set=countdown.scale=4) sets any config value, recorded in the log header's overrides like variants are. Presets may carry values too. Replaces Q7's multiplier question with starting values | 2026-10-11 |
| G23 | Should other number-like switches become plain numbers? | Yes. trainLength becomes the train's car count, graceWindow becomes countdown.graceSec, and searchPace splits into a search time and a hidden-loot on/off value. Named variant groups stay only for behaviour choices (guardCatch, horseArrivalCue, mountSpill, trainMix, handlingModel) | 2026-10-11 |
| G24 | Starting numbers (Q7-Q10) | Mail countdown base 150 s, countdown.scale 1 (medium preset 4); grace 3 s; 3 cars (preset 6); search 1.2 s (slow preset 3 s with hidden loot; after the M2 playtest, Devlin 2026-10-14: letters 0.8 s, large prizes 2.2 s, slow preset × 2.5, hidden loot on by default); horse delay 5-20 s, alongside 10 s, re-whistle 5 s later; mount meter zones 3% and 15% at the 1.85 s matched sweep; carry 10 weight units with speed down to 50% at the limit; boost 1.5 s at +40% top speed, 6 s cooldown. Carry max: see G25 | 2026-10-11 |
| G25 | Max carry limit | Both: slowdown starts at 6 weight units and ramps to 50% speed at the hard max of 10, and a separate cap of 20 items. Starting weights: letter 0.1, cash bundle 0.2, jewellery pouch 0.3, parcel 0.5, registered mail sack 4, strongbox 6. Pickups that would break either cap are refused | 2026-10-11 |
| G26 | Heat from time aboard (Q11) | A config value to test, not a fixed choice: heat.sources.timeAboardPerSec stays 0 by default, a playtest preset sets 0.2, and the URL override can set any value. M1 playtest (2026-10-13): Devlin wants it on by default at 0.33 with a way to turn it off, so the default is 0.33 and a no-time-aboard-heat preset sets 0 | 2026-10-11, 2026-10-13 |
| G27 | Does moving cancel a search? (Q12) | You can slow-walk while searching (starting at 30% walk speed). Releasing E cancels, and moving more than 1.5 tiles from the loot spot cancels automatically; a cancelled search loses its progress | 2026-10-11 |
| G28 | How do you reset your save? (Q14) | A Reset save button in the debug overlay and ?resetSave=1 in the URL, both confirming before wiping | 2026-10-11 |
| G29 | Build the roof route in Phase 2? (Q15) | Not in Phase 2; it fits Phase 3. Recorded for later: side ladders as entry points beside doors, so you can board straight onto the roof from the horse. Mail car layouts mark roof access so nothing needs redoing | 2026-10-11 |
| G30 | Should high heat make boarding harder later? (Q17) | Add the hook now: heat.boardingResistanceAt (off by default) in M1; the shooting itself comes with combat in Phase 3 | 2026-10-11 |
| G31 | What does the Phase 2 gate decide? (M6 regrill) | How long one train robbery should be and how much train fills it, tested across a range of town spacings, not short vs medium runs. Item weights and carry also bound how long a train can be looted; carry can become a progression stat later (careers) | 2026-10-28 |
| G32 | What should end a good robbery: the clock or the bag? | Both pull: a starting bag fills about when the clock gets tight, and a train holds more than you can carry. A bag filling early is fine: you get off and rob the next train that day. The clock should suddenly matter as the next town nears and shape where you board | 2026-10-28 |
| G33 | Where is the gate played? | On the open line with the next-town clock. Loop maps are for automated tests only and long term are not offered to players. The gate's dial is town spacing, not countdown.scale | 2026-10-28 |
| G34 | What does heat do now? | Heat never changes the clock. It drives guards, by band: alert and calm-down last longer, sight and hearing grow a little, chase gets faster, more guards patrol (shooting waits for Phase 3). Built in M6 with a heatGuards switch | 2026-10-28 |
| G35 | Does heat affect wanted level? | Yes: heat at run end is the % chance of +1 wanted, even on a clean extraction. Time-aboard heat (heat.sources.timeAboardPerSec and its no-time-aboard-heat preset) is removed | 2026-10-28 |
| G36 | How does wanted come back down? (U11 said never) | Decay now: wanted.decayPerDay 1 at each new day. Paying it off with bank comes later with careers and towns | 2026-10-28 |
| G37 | Which outcomes roll on heat? | All of them. Expired still adds +1 outright. Died and cancelled roll too (a cancel that didn't roll would dodge wanted); outcomePolicy.<outcome>.heatRoll turns it off per outcome | 2026-10-28 |
| G38 | Where do the golden runs and bots run? | Loop golden fixed to extract, plus a short line golden. CI: idle and looter bots over 1,000 loop seeds and 25 line seeds. tools report --line runs a few hundred line seeds per preset on demand. The gate answer comes from Devlin's playtest logs | 2026-10-28 |
| G39 | The Playtests page is too busy. How should it be organized? | Experiments as the backbone, plus the run list split into views (Robbery, Boarding, All) with click-to-expand rows. New numbers go into a view, never as a column everywhere | 2026-10-28 |
| G40 | What is an experiment? | A question plus 2-4 named setups, each with a Play link, shown as a diff from default, with an editable base setup and an answer box carried into the notes export | 2026-10-28 |
| G41 | Where do experiments live? | Local plus repo: repo ones in content/playtests/*.json (read-only on the page); your own saved in the browser, with Duplicate, Copy as file and Share link. Opening a shared link, a Play link from it, or its file saves the experiment to that person's Playtests page (Devlin, 2026-10-28) | 2026-10-28 |
| G42 | How does M6 ship? | Three PRs: M6a Playtests page (can start now), M6b heat drives guards and wanted (after M5), M6c tests and the gate (after G6 and M6b, 0.2.6). The gate guide, including how to customize setups, is a section on the wiki Playtesting page | 2026-10-28 |
| G43 | What are the gate questions? | Six experiments played in order, each starting from the spacing experiment 1 picks: town spacing, train length, the bag, reading the clock, heat and guards, wanted roll and decay; plus robberies per 12-minute day, measured for G8 | 2026-10-28 |
| G44 | What counts as passing? | No numeric threshold. A full robbery on the line (find, board, loot, get off before the town) is fun enough to play three times in a row; if not, tune and replay before G7 and the Phase 3 plan | 2026-10-28 |
| G45 | How does M6 measure reasons to keep playing? (progression doc) | Every experiment card shows session pull (a new run within 30 s of the summary, and which outcome ended each session), and every answer box asks "What would you try next time?", "Did you see a prize or route you left behind?" and "Did you want to go again? Why?" (the wiki progression review's step 9 priority). Runs also record the loot value left on the train. The gate comment also asks "Would you pay for the full game after this? What would make you?" | 2026-10-28 |
| G46 | Should wanted level go down on its own? (progression doc open question) | Not settled by the 1 per day default (Devlin). Experiment 6 tests it: no decay, 1 per day, 1 per quiet day (only after a day where no robbery added wanted). Paying it off with bank waits for careers | 2026-10-28 |
| G47 | Roguelite career or arcade mastery? (progression doc open question) | Optional experiment 7 after the six gate experiments: three trains in a row with or without a pick of 1 of 3 boons between them (+1 carry, quieter steps, faster whistle, as config changes). If the third train doesn't feel different, lean toward arcade mastery and co-op | 2026-10-28 |
| G48 | How does the Roadmap show M6? | Row 9 splits into 9a M6a, 9b M6b, 9c M6c and 9d the Phase 2 gate (its own bold row); later step numbers stay the same | 2026-10-28 |
| G49 | Which guards see farther as heat rises? (Devlin's playtest idea) | Both: every guard gets a small sight bump by heat band (heatGuards), and a guard who has noticed you gets a bigger one (guardMemory) | 2026-10-29 |
| G50 | When has a guard noticed you, and for how long? | Once it goes alert (not just suspicious). It remembers you for the rest of the run, that guard only; a new train (Tab) brings fresh guards | 2026-10-29 |
| G51 | What grows, and by how much? | In-car sight range only, not cone angle; ledge range unchanged. Starting values 10 / 12 / 14 tiles by band, +5 for a guard who went alert (15 / 17 / 19). All config, changeable with ?set= | 2026-10-29 |
| G52 | Does heat come back down during a run? | No: heat only rises in a run, the record of the robbery, so a clean run stays easier than going in loud. Loot heat goes from 1 to 2 per item (3 tested in experiment 5). Band edges move into game config | 2026-10-29 |
| G53 | Which other guard changes do heat bands make? | All four from the plan, low / mid / high: calm-down 4 / 5 / 6 s, searching 3 / 4 / 5 s, hearing x1 / x1.15 / x1.3, chase 4 / 4.5 / 5 tiles/s (you run at 8); rounds +0 / +25% / +50% once guard rounds (PR #51) is in. A guard who went alert also hears x1.25 on top; it does not chase faster | 2026-10-29 |
| G54 | How do you tell which guards remember you? | A lasting red-eye badge after a guard's first alert, plus cones drawn at their real length; ?remembers=off hides the badge. The footstep ring stays the base radius | 2026-10-29 |
| G55 | Delete time-aboard heat or keep it at 0? | Delete heat.sources.timeAboardPerSec, heat.heatDrainFactor and the no-time-aboard-heat preset; old logs and experiments that name them load with a warning | 2026-10-29 |
| G56 | When does a day end for wanted decay before G8's day clock? | No stop-gap logic (no runs per day, no saving the day across reloads). A debug End day key (K, off a run only) does what death does to the day: full health, day +1, decay runs. It also tests healing | 2026-10-29 |
| G57 | Does wanted level raise starting heat or alertness? | No. Heat is this robbery's record and wanted only adds guards, so a clean run stays easier and stars don't snowball | 2026-10-29 |

**Wiki Ideas page additions** (pushed to the wiki on 2026-10-11 with a rank per idea, except where marked)

- A real horse that rides the terrain to reach the train after a whistle, and with it the world-structure test (G3)
- Landing on foot when a guard throws you off, then whistling for the horse (G5)
- Heat levels: past thresholds, guards spot you faster, and at full heat every car is on alert (G10)
- Riding back to pick up loot spilled on a good mount (G15)
- Required later: a way for wanted level to come down, such as a clean getaway lowering it by one, or decay over runs or time (G19)
- Side ladders as entry points, so you can board straight onto the roof from the horse (G29)
