The order Train Robber gets built in, as one sequence: the rest of Phase 2, the outlaw's life (the roguelite turn), the generated-maps steps (the G series), Phase 3, the 3D graphics and multiplayer. Last updated 2026-11-12.

**What changed on 2026-11-12.** The [design and build order review](https://claude.ai/artifact/AVUuNMEaWwgEJfWV6v42pg) (2026-11-11) turned the game into a roguelite: one outlaw's life, loot that only counts once you make camp, and a ticket out of the territory as the way to win. The order now is: clear the open PRs, then stakes, the life and the day clock, then the bounty, a combat test, the camp shop, train traits and picking an outlaw, then **the life gate**, which replaces the Phase 2 gate. Steps that don't make a life more fun yet (G7, G9, trains both ways, riding between trains, more set pieces, the network test and 3D) wait until after that gate.

The design behind it is on its own pages: [A day on the line](A-day-on-the-line) (the world and days that the G series builds), [Multiplayer](Multiplayer) and [Map edges](Map-edges). Ideas that aren't scheduled yet are on [Ideas](Ideas). The [progression roadmap review](Progression-review-by-roadmap) maps open questions to these steps without scheduling new work. The repo has the full detail: the [requirements](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md), the [technical design](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md) and the [phase plans](https://github.com/devlinjunker/train-robber/tree/main/docs/plans).

## Order of work

One line per step, in the order they're planned. Steps marked "alongside" can run at the same time as the step above them. "Plan only" means the plan is written but no code starts until what it waits on is merged and Devlin says go. Gates are playtests that decide whether to go on. Each step's detail is under [Step notes](#step-notes).

| # | Step | Status | Waits on |
|---|---|---|---|
| 1 | Phase 1: riding and boarding | Done; gate passed | |
| 2 | Phase 2 M1–M4: countdown and heat, mail train and loot, guards and boost, extraction | Done ([#16](https://github.com/devlinjunker/train-robber/pull/16), [#17](https://github.com/devlinjunker/train-robber/pull/17), [#28](https://github.com/devlinjunker/train-robber/pull/28), [#29](https://github.com/devlinjunker/train-robber/pull/29)) | |
| 3 | Phase 2 sneaking: crouch and cover, platforms and ledges, roofs | Done ([#33](https://github.com/devlinjunker/train-robber/pull/33), [#35](https://github.com/devlinjunker/train-robber/pull/35), [#36](https://github.com/devlinjunker/train-robber/pull/36)) | |
| 4 | G0–G5: generator, map checks, the open line, chunks, streaming and open line performance | Done ([#31](https://github.com/devlinjunker/train-robber/pull/31), [#34](https://github.com/devlinjunker/train-robber/pull/34), [#38](https://github.com/devlinjunker/train-robber/pull/38), [#40](https://github.com/devlinjunker/train-robber/pull/40), [#42](https://github.com/devlinjunker/train-robber/pull/42)) | |
| 5 | Phase 2 M5: wanted level, saving and score; one health bar per day | Done ([#46](https://github.com/devlinjunker/train-robber/pull/46), v0.2.5; [#45](https://github.com/devlinjunker/train-robber/pull/45)) | |
| 6 | Phase 2 M6a: Playtests page with experiments and run views | Done ([#55](https://github.com/devlinjunker/train-robber/pull/55)) | |
| | **Clear the open PRs, merged in this order** | | |
| 7a | Stop the whistled horse getting stuck | In review ([#62](https://github.com/devlinjunker/train-robber/pull/62)) | |
| 7b | Phase 2 M6b: heat drives guards and wanted | In review ([#58](https://github.com/devlinjunker/train-robber/pull/58)) | |
| 7c | Core loop: harder prizes, distraction rocks, roof hatch, loot at risk | In review ([#68](https://github.com/devlinjunker/train-robber/pull/68)) | |
| 7d | Guards walk between cars | In review ([#51](https://github.com/devlinjunker/train-robber/pull/51)) | |
| 7e | Fall test setup (rock-cut map, fall-test preset) | In review ([#61](https://github.com/devlinjunker/train-robber/pull/61)) | |
| 7f | G6: towns and timetables | In review ([#47](https://github.com/devlinjunker/train-robber/pull/47)) | |
| 7g | G10a: named stretches on the open line | In review ([#69](https://github.com/devlinjunker/train-robber/pull/69)) | |
| 7h | G10b: set pieces (horseshoe bend, grade, canyon cut). No more set piece PRs until after the life gate | In review ([#70](https://github.com/devlinjunker/train-robber/pull/70), on #69) | 7g |
| 7i | Playtest defaults: Playtests page filters in the URL, all-mail trains on | In review ([#80](https://github.com/devlinjunker/train-robber/pull/80)) | |
| | **The outlaw's life** | | |
| 8 | Stakes: loot rides in the saddlebag until you make camp off the line; throw-offs hurt; wanted pays | In review ([#72](https://github.com/devlinjunker/train-robber/pull/72)) | |
| 9 | Roguelite life: permadeath, three tickets out, wanted posters, top lives | In review ([#73](https://github.com/devlinjunker/train-robber/pull/73), on #72) | 8 |
| 10 | G8: the day clock, dusk and the last train, nightfall | In review ([#74](https://github.com/devlinjunker/train-robber/pull/74), on #73) | 9 |
| 11 | Stakes 2: a fast exposed route and a slow safe one off the line | Not started | 7g, 8 |
| 12 | Bounty replaces wanted, with the law changing per bounty tier | Plan only ([plan](https://claude.ai/artifact/92LwMDQ1LrJihgS37h31uy)) | 7b, 7d, 8, 9 |
| 13 | Combat test: one gun, guards shoot back at high heat, mail train only (alongside 12) | Plan only | 7b, 8, 9 |
| 14 | Camp shop: bandages, crowbar, dynamite, conductor's cap | Plan only ([plan](https://claude.ai/artifact/26MXeiHEfxUnTpbJyrXwoi)) | 7c, 8, 9 |
| 15 | Train traits: express, night mail, double guard, locked doors, decoy, payroll chest | Plan only ([plan](https://claude.ai/artifact/4TsmoWkfMzkSgSwQ9hjL1N)) | 12 |
| 16 | Pick an outlaw: 1 of 3 kits, ticket unlocks, a dead outlaw's stash | Plan only ([plan](https://claude.ai/artifact/2jbaFSUeinEx6LK6VafExR)) | 9, 14 |
| 17 | Gate prep (was M6c): tests, presets and the gate experiments (0.2.6) | | 16 |
| 18 | **Gate: the life gate** (replaces the Phase 2 gate). Five outside players each play a life. Do they want to play another outlaw? | | 17 |
| | **After the life gate** | | |
| 19 | Decide the parked PRs: quieter boarding and the boarding plan | Parked as drafts ([#65](https://github.com/devlinjunker/train-robber/pull/65), [#71](https://github.com/devlinjunker/train-robber/pull/71)) | 18 |
| 20 | Phase 3 plan and its review, built on the combat test | No plan yet | 13, 18 |
| 21 | Phase 3: the military payroll train and full combat, and **the Phase 3 gate** | | 20 |
| 22 | Held back until after the life gate, order set there: G7 replays for long runs, G9 finding trains, G14a trains both ways, riding between trains, more set pieces and G10c landmarks, rarer loot, a view cone through windows | | 18 |
| 23 | Network test: two players on one train | | Phase 3 |
| 24 | Graphics upgrade to live 3D | Art plan questions open | Network test |
| 25 | G10 rest: land worth riding, with the first map edges (see [Map edges](Map-edges)) | | 3D |
| 26 | G12: towns as places | | 14 |
| 27 | Phase 4: the passenger hold-up, and its gate | | 21 |
| 28 | Phase 5: the bank train, and its gate (the prototype's last) | | Phase 4 |
| 29 | G13: regions down the line, and telling train types apart | | G10, Phases 3–5 trains |
| 30 | G14b: forks in the line | | G13 |
| 31 | **Gate: choosing a train.** Is choosing between train types fun? | | G13 |
| 32 | G15: the daily day, and **its gate** (do people come back tomorrow, and bring friends?) | | G8, G7 |
| 33 | Full online multiplayer | | Network test |
| 34 | G16: shared world online | | Full multiplayer |
| 35 | After that: cargo and tycoon trains, the later trains, deeper progression | Order not set | |

Versions follow `0.<phase>.<milestone>`: Phase 2 M5 is 0.2.5, the gate prep is 0.2.6, and Phase 3 starts at 0.3.x.

### How the time questions connect

Three things ask about time. **G6 (step 7f):** do town spacing and timetables set a good rhythm on the line? **G8 (step 10):** how long is a day of daylight, and how many robberies fit in it before you must make camp? **The life gate (step 18):** how many days make a good life, and is the ticket out priced right?

The robbery time sets town spacing, and town spacing and the day clock set how many trains fit in a day. Heat no longer shortens any clock: from M6b it changes guard behaviour, and the bounty (step 12) replaces the wanted level as the long-term pressure.

### Why this order

- **Clear the open PRs first.** Ten PRs were open and main hadn't moved since 2026-10-31. Each one in step 7 is small, already built and in review; the life stack is built on top of them.
- **Stakes, life and day clock come next,** as one stack: loot only counts once you make camp, dying ends the outlaw, and dusk gives the day a budget. Together they give a robbery a reason and a cost.
- **The bounty, shop, traits and outlaw pick come before the gate,** because they answer the gate's question: why play another outlaw? The bounty is the score and the difficulty dial, the shop gives money a use within a life, traits make trains differ, and the pick and ticket unlocks give the next outlaw something new.
- **The combat test comes early,** because gunfights may be the fun part and couldn't be tested. It's one gun on the mail train, independent of the bounty PR, and full Phase 3 builds on what it shows.
- **The life gate replaces the Phase 2 gate.** It asks the question that now matters: does a whole life play well enough to start another one? M6c's tests and experiments become its prep.
- **Steps that don't make a life more fun yet wait until after the gate:** G7, G9, trains both ways, riding between trains, more set pieces, the network test and 3D. Their order is set at the gate.
- **Camps (G11a) and careers (G11b) are covered by the life stack.** Making camp anywhere off the line (step 8) replaced seeded camp spots, and the outlaw's life (step 9) replaced the saved career. Camp spots that come from the land stay part of G10.
- **The network test still comes straight after Phase 3,** while combat is fresh, and 3D still comes before the rest of G10, since G10 is mostly art.

## Step notes

### Phase 2: the mail train (steps 2–7)

Phase 2 is the first full run on the mail train.

**M5: wanted level, saving and score** ([#46](https://github.com/devlinjunker/train-robber/pull/46), merged): your progress is saved in the browser between runs; wanted level (0 to 5) puts more guards on the trains; every way a run ends has clear rules for what you keep; a local leaderboard; an end-of-run summary screen. The bounty (step 12) is planned to replace the wanted level.

**One health bar per day** ([#45](https://github.com/devlinjunker/train-robber/pull/45), merged 2026-10-28): health lasts the whole day, death ends the day, and hard crashes hurt even when you're not robbing.

**M6a, the Playtests page** ([#55](https://github.com/devlinjunker/train-robber/pull/55), merged 2026-10-31): experiments (a question plus 2–4 setups, each with a Play button and an answer box), shareable links, and Robbery, Boarding and All run views.

**M6b, heat and wanted** ([#58](https://github.com/devlinjunker/train-robber/pull/58), in review): heat no longer touches the clock. It makes guards sharper, alerted guards remember you, and heat at the end of a robbery is the percent chance of +1 wanted level.

**The rest of step 7:** the horse pathing fix ([#62](https://github.com/devlinjunker/train-robber/pull/62)); the core loop PR ([#68](https://github.com/devlinjunker/train-robber/pull/68): prizes in guarded cars, a noisy prize search, heavy prizes, a thrown distraction rock, a roof hatch, "AT RISK" on the HUD); guards walking between cars ([#51](https://github.com/devlinjunker/train-robber/pull/51)); the fall test setup ([#61](https://github.com/devlinjunker/train-robber/pull/61)); G6 towns ([#47](https://github.com/devlinjunker/train-robber/pull/47)); G10a stretches and G10b set pieces ([#69](https://github.com/devlinjunker/train-robber/pull/69), [#70](https://github.com/devlinjunker/train-robber/pull/70)).

**Gate prep (step 17, was M6c):** golden runs on a loop map and on the line, a looter bot over many seeds, and the gate experiments, now aimed at a whole life rather than one robbery. Version 0.2.6.

**Ideas to look into (not scheduled):** show what you missed and a robbery recap on the summary screen, and loot that causes trouble. See [Progression and replayability](Progression-and-replayability#other-ways-to-make-players-improvise).

### The outlaw's life (steps 8–18)

From the [design and build order review](https://claude.ai/artifact/AVUuNMEaWwgEJfWV6v42pg) and its follow-ups (2026-11-11 and 12).

- **Stakes** ([#72](https://github.com/devlinjunker/train-robber/pull/72)): loot you get off a train rides in your saddlebag until you make camp. Hold C on a stopped horse far enough off the line (farther at higher wanted, closer in cover, never in sight of the train you robbed) to bank it and end the day. Dying loses the saddlebag, a hard crash spills some of it, a guard throwing you off costs health, and loot is worth more at higher wanted.
- **The roguelite life** ([#73](https://github.com/devlinjunker/train-robber/pull/73), preset `roguelite`): one outlaw with a seeded name and face. Dying ends the life and shows their wanted poster; buying a ticket out of the territory at camp ends it alive, in three tiers at rising prices, each its own ending and poster stamp. A poster wall and top lives.
- **G8, the day clock** ([#74](https://github.com/devlinjunker/train-robber/pull/74), [plan](https://claude.ai/artifact/NMP9nKuZKuQGi4WUniyBMi)): a day of daylight, then dusk with a richer, better-guarded last train, then nightfall with a short grace to make camp before you lose half of what you carry.
- **Stakes 2:** a fast exposed route and a slow safe one off the line, using the line's stretches. Asked for 2026-11-12, after #69.
- **Bounty replaces wanted** ([plan](https://claude.ai/artifact/92LwMDQ1LrJihgS37h31uy)): a dollar bounty that only rises as you bank, which is your score, the poster reward and the difficulty dial. The five guard levels become bounty tiers, and the law changes per tier (guard rounds, a walker, a locked prize car, Pinkertons aboard). Cash is a separate wallet.
- **Combat test:** one gun, guards who shoot back at high heat, on the mail train only. It codes after #58, #72 and #73, independent of the bounty PR, and feeds the Phase 3 plan.
- **Camp shop** ([plan](https://claude.ai/artifact/26MXeiHEfxUnTpbJyrXwoi)): spend cash while camped on bandages, a crowbar, dynamite and a conductor's cap. Tools are lost when the outlaw dies.
- **Train traits** ([plan](https://claude.ai/artifact/4TsmoWkfMzkSgSwQ9hjL1N)): each mail train rolls one or two traits (express, night mail, double guard, locked doors, decoy prize car, heavy payroll chest), weighted by bounty tier and readable before you commit. Variety from recombining what's built, not new trains.
- **Pick an outlaw** ([plan](https://claude.ai/artifact/2jbaFSUeinEx6LK6VafExR)): pick 1 of 3 outlaws with different kits; ticket tiers reached open new kits, traits and car layouts (never more power); a dead outlaw's saddlebag is buried somewhere on the next outlaw's line.
- **The life gate:** five outside players each play a life. It passes if they want to start another outlaw, and it sets the day length, the ticket prices and the bounty tiers.

**Parked until after the life gate:** quieter boarding ([#65](https://github.com/devlinjunker/train-robber/pull/65)) and the boarding plan with engine sight, meet-here markers and lookouts ([#71](https://github.com/devlinjunker/train-robber/pull/71)). Both are drafts with no rebases until the gate has been played.

### Generated maps: the G series

The design is on [A day on the line](A-day-on-the-line), from the [procedural maps options doc](https://claude.ai/artifact/7qncafySjNAx8pW92fVcXg).

| Step | What it builds |
|---|---|
| G0 | Decisions written into the requirements and design docs |
| G1 | Generator: seeded track and terrain as a loop (`?map=gen`) |
| G2 | Map checks over hundreds of seeds (built inside G1) |
| G3 | The open line (`?map=line`): a track that can grow forever, open routes, town spots, the town clock |
| G4 | Terrain built in chunks looked up by position; the map's id comes from the seed, generator version and settings |
| G5 | The game builds chunks as you ride instead of all at load: faster loading and much longer lines. Followed by an open line performance pass ([#42](https://github.com/devlinjunker/train-robber/pull/42)) |
| G6 | In review ([#47](https://github.com/devlinjunker/train-robber/pull/47)). Towns and timetables: named towns with buildings, trains on a seeded timetable, and the train clock counting down to the next town. Town spacing comes from the Phase 2 target robbery time, and the cars per train are re-tested against it |
| G7 | After the life gate. Replays and logs that handle 15-minute runs over thousands of tiles |
| G8 | In review ([#74](https://github.com/devlinjunker/train-robber/pull/74)), pulled into the life stack. Day clock: a day of daylight, dusk with a last train, nightfall with a short grace to make camp. Checks that the robbery time fits several trains into the day |
| G9 | After the life gate. Finding trains: smoke on the horizon, whistles, telegraph poles, hearing a train before you see it |
| G10a | Named stretches on the open line (open flats, broken country, timber, river valley, mesa country), a banner and signs, a zoom limit per stretch. In review ([#69](https://github.com/devlinjunker/train-robber/pull/69)); pulled ahead of G7–G9 on 2026-11-10 |
| G10b | Set pieces on the track, three per PR: horseshoe bend, a grade where trains slow, a canyon cut with a rim drop. In review ([#70](https://github.com/devlinjunker/train-robber/pull/70)). Water stop, trestle and tunnel wait until after the life gate |
| G10c | Tall named landmarks to steer by. After the life gate |
| G10 rest | Land worth riding: biomes (including green ground, from the G3 playtest), places where trains slow, hand-made set pieces, pacing along the line, and the first [map edges](Map-edges). Camp spots start coming from the land (shelter, canyons, river bends), so finding a camp becomes a search, and its playtest re-checks that finding a camp is fun |
| G11a | Mostly covered by stakes ([#72](https://github.com/devlinjunker/train-robber/pull/72)): you make camp anywhere far enough off the line instead of riding for seeded spots. The original plan: camps: at dusk you ride for one of 2 or 3 seeded camp spots, each with a trade-off (near the line, far and hidden, near a town, by a slow spot), and the next day starts there. The line gets wide enough for camps 300–800 tiles off it. A bad camp costs a long ride to tomorrow's trains, and not reaching one before dark could cost health. **Open question for its plan:** what exactly does a bad camp cost? Posses finding your camp come later, with the law's reach (G12 and after Phase 3) |
| G11b | Mostly covered by the roguelite life ([#73](https://github.com/devlinjunker/train-robber/pull/73)): one outlaw's life with permadeath replaces a saved career. The original plan: careers: a saved career (day, place on the line, bank, wanted level per region); permadeath as a variant |
| G12 | Towns as places, after the camp shop: fence, outfitter, rumours and timetables to buy, the first upgrades |
| G13 | Regions down the line that change which trains run, and telling train types apart by sight. The spyglass still needs design (see [Ideas](Ideas)) |
| G14a | After the life gate. Passing loops, so trains can run both ways on the line |
| G14b | Forks in the line, leading to different regions |
| G15 | The daily day: a daily seed, a community line, a streak (doubtful, an open question) and wanted poster, a share card. Everyone starts the daily at the same wanted level (yours never carries in); an idea is for the day's seed to set it, so some days the law is out in force |
| G16 | Shared world online: your gang shares one day and camp |

**Ideas to look into (not scheduled):** G6, a guard shift change at towns (needs trains that stop and carry on); G8, what being thrown off costs (end the train, drop the bag by the track, day-long injury); G10, more ways on and off the train (bridge drops, water tower stops, jumping into a river); G11b, a hard final goal for a career, jail, and a lawman who remembers you; G12, rumours that name a prize, leads, horse choice and bail; G13, fog and decoy cars; G14a, jumping across to a passing train. See [Progression and replayability](Progression-and-replayability) and the [roadmap review](Progression-review-by-roadmap).

### Phase 3: the military payroll train and combat (steps 13, 20 and 21)

Phase 3 adds fighting. It starts with the **combat test** (step 13): one gun and guards who shoot back at high heat, on the mail train only, built before the life gate so gunfights can be tried early. The Phase 3 plan builds on what that test shows. Its gate: combat feels good, and the two health models have been compared. There's no Phase 3 plan yet; like Phases 1 and 2, it starts with a plan and a review of its open questions.

- **The military payroll train.** Soldiers as guards and a big payout. It's the train that favours fighting, but sneaking should still work.
- **Full guard AI.** This builds on the Phase 2 guards: they notice you by sight and sound, go from suspicious to alert, and call others, which raises the alarm.
- **Combat.** Aim and fire with the mouse, with bullets that travel and can miss, and a close-range melee attack. Car layouts already mark what blocks sight and shots and how much cover each spot gives.
- **Health.** A real health bar replaces the placeholder. A "downed" variant is tried against it: you get about 6 s to recover, and you lose your loot only if that runs out.
- **Moved here from Phase 2.** Guards shooting at you while you board at high heat, and side ladders onto the roof.
- **Heat and guards.** On the open line the clock no longer speeds up with heat, so heat should change how guards behave instead (from the G3 playtest).

**Open questions for the Phase 3 plan:** ammo limits (the alpha default is unlimited), knocking guards out as well as killing them, healing items as loot, and how to keep sneaking workable on a train built for fighting.

**Ideas to look into for the Phase 3 plan (not scheduled):** a loot bag you can throw to a rider or drop when thrown off (optional and an open question; it may help with the weight limit, but isn't a reason to play); random trouble on the train, answered with normal moves (quick-time prompts as a variant); the train fighting back after the alarm (locked doors, a moved strongbox); workers who walk the train; a thrown distraction and smoke; armoured and decoy cars; scarcity. See [Progression and replayability](Progression-and-replayability#random-trouble-on-the-train-2026-10-29).

### Network test and multiplayer (steps 23, 33 and 34)

Two players on one train over a simple server, with no lobby, straight after Phase 3, and kept working as Phases 4 and 5 add their trains. Full online multiplayer comes later. What's already in place, what's left and the open questions are on [Multiplayer](Multiplayer).

**Ideas to look into (not scheduled):** a friend pinned down on the train, and the gang robbing the prison train to free a jailed friend. See [Progression and replayability](Progression-and-replayability).

### Graphics upgrade (step 24)

The [art plan](https://claude.ai/code/artifact/eeb02aaf-38e7-4bab-ab38-40892d4bad4a) recommends a live 3D world (three.js) with the HUD kept in Pixi. Its questions A1–A6 need a review before work starts. Only the drawing changes, so the step ends with a quick re-check that shots and cover still read clearly in combat.

### Phases 4 and 5 (steps 27 and 28)

- **Phase 4: the passenger hold-up.** Reading passengers by sight, an inspect action, and armed passengers. Gate: judging passengers is a decision, not a chore.
- **Phase 5: the bank train.** Cracking the vault while guards interrupt. Gate: the minigame holds up under time pressure, and each train clearly favours a different playstyle.

**Ideas to look into (not scheduled):** Phase 4, buying a ticket and robbing the train from the inside; Phase 5, a locked car with the key elsewhere on the train. See [Progression and replayability](Progression-and-replayability#bigger-ideas-a-hard-goal-varied-boarding-and-jail-2026-10-29).

### Proposals not yet scheduled

These are written up, but their questions are still open:
- [Progression and replayability](Progression-and-replayability), including the earlier [progression and reasons to play proposal](https://claude.ai/code/artifact/3f07eb5c-ed70-4843-aff0-b629edc4f361)
- More loot and rare finds (tools, consumables and gear), tracked under "Loot and items" on [Ideas](Ideas)
- [Riding between trains](https://claude.ai/artifact/SGRCpgGzu2Mc2QjWdve4ek): setup on the line, finds, trails and stagecoaches, lawmen while wanted (after the life gate)
- Pinkertons, who need guards that ride and fight, so they come with or after Phase 3 combat (see [Map edges](Map-edges))
