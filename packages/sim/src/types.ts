import type { RngState } from './rng';

export type PlayerId = number;

export type Command =
  /**
   * Quantized axes -127..127 in screen sense: x right, y down, so W sends y = -127.
   * Throttle is -y (W accelerates, S brakes). x steers relative to the horse's heading
   * under the heading-relative steering variant and is ignored under screen-relative.
   */
  | { type: 'move'; x: number; y: number }
  /**
   * Screen-relative steering: the world-space direction the horse should turn to face,
   * quantized like `move`. The client maps screen keys to world space, so the sim never
   * sees the screen. 0, 0 keeps the current heading. Ignored under heading-relative steering.
   */
  | { type: 'steer'; x: number; y: number }
  /**
   * E: commit to the train in range when idle (as `startRun` with no id). Aboard, E is held to
   * search a loot slot: the client sends `held: true` on press and `held: false` on release.
   */
  | { type: 'interact'; held: boolean }
  /** Drop carried item `slot` (0 is the first picked up) onto the floor, to swap it for another. */
  | { type: 'drop'; slot: number }
  /** Space: the boarding jump, sampling the meter on this tick. */
  | { type: 'jump' }
  /** Commit to a train; without an id, the nearest one that can be committed to. */
  | { type: 'startRun'; trainId?: string }
  /**
   * Tab: move the commitment to another free train during `approach` (or a failed jump's stun),
   * keeping the run, its timer and health. Without an id, the nearest one `switchTarget` names.
   */
  | { type: 'switchTrain'; trainId?: string }
  /** Esc: end the run in any phase but `ended` and reset to playerSpawn. */
  | { type: 'cancelRun' }
  /** R, while `playtest.quickRetry` is on: end the run and wait on the horse behind the train. */
  | { type: 'quickRetry' }
  /**
   * Playtest only, while `playtest.debugHeatStep` is above 0, so heat can be tried before loot and
   * guards exist. H raises heat by that step (cause `debug`); with `source` (Shift+H sends
   * `alarmRaised`) it raises what that source would, with its cause, as if the event happened.
   */
  | { type: 'debugHeat'; source?: HeatSource }
  /**
   * F, aboard: whistle for the horse (U4). The first whistle starts `extracting` and places the horse
   * behind the train on the player's side; another while it is coming or alongside sends it to the
   * side the player is now nearest.
   */
  | { type: 'whistle' }
  /** Shift, mounted: a burst above top speed for `horse.boost.durationSec`, then a cooldown (handlingModel `arcade-boost`). */
  | { type: 'boost' }
  /**
   * F, on the horse during a run (after a guard threw you off): end the run `cashedOut`, banking
   * what you carry, and close that train's doors (`cashOut` config) so it cannot be committed to.
   */
  | { type: 'cashOut' }
  /**
   * C, aboard: crouch (`on: true`) or stand. Crouching walks at `player.crouch.speedScale`, makes
   * `ai.noise.crouchRadiusTiles` of noise, and hides you behind cover of at least
   * `ai.sight.crouchCoverMin`. The client sends it as a toggle or while C is held (?crouch=).
   */
  | { type: 'crouch'; on: boolean }
  /**
   * E at a ladder (sneaking PR 3): on an end platform within `outside.roof.ladderReachTiles` of a
   * ladder, climb onto that car's roof; on a roof by a ladder at its end, climb down to the platform.
   * Climbing takes `outside.roof.climbSec`. Space on the roof is the gap jump (`jump`).
   */
  | { type: 'climb' };

export interface InputFrame { player: PlayerId; commands: Command[] }

/** `idle` means no run; the others are `RunState.phase`. */
export type RunPhase = 'idle' | 'approach' | 'boarding' | 'aboard' | 'extracting' | 'ended';
/** `caught`: a guard threw you off with nothing left to carry and the train shut its doors (Devlin, PR #46 playtest). */
export type RunOutcome = 'died' | 'cancelled' | 'expired' | 'extracted' | 'cashedOut' | 'caught';
/**
 * What raised heat: an event-based source from `heat.sources`, time spent aboard
 * (`heat.sources.timeAboardPerSec`), or the playtest debug key.
 */
export type HeatCause = 'shotFired' | 'alarmRaised' | 'playerSpotted' | 'actorKilled' | 'lootTaken' | 'timeAboard' | 'debug';
/** Event-based heat sources in `heat.sources` (time aboard is per second instead). */
export type HeatSource = Exclude<HeatCause, 'timeAboard' | 'debug'>;
export type BoardingResult = 'perfect' | 'good' | 'fail';
/** A side of the train, relative to its direction of travel. */
export type TrainSide = 'left' | 'right';
/**
 * The riderless horse during a run (U4): `away` is out of the world, `approaching` rides up after a
 * whistle, `alongside` paces beside the player's car for the pace window, and `leaving` runs off after
 * boarding or drops back after the window, then goes `away`.
 */
export type HorseCallState = 'away' | 'approaching' | 'alongside' | 'leaving';
/** What a good mount spills (mountSpill variant group, G15). */
export type MountSpill = 'random' | 'heaviest' | 'share';
/** What a horse ran into: a train car, or blocked ground (water and the map edge never hurt). */
export type CollisionTarget = 'train' | 'obstacle';
/** Why a `jump` was refused. Out of range is the boarding rule; a speed mismatch only speeds up the meter. */
export type JumpRejection = 'too far' | 'no run' | 'stunned' | 'aboard' | 'doors closed';
/** Why a mount jump (Space while extracting) was refused. */
export type MountRejection = 'no horse' | 'not at a door' | 'horse too far';
/** Why a whistle was refused. */
export type WhistleRejection = 'not aboard' | 'cooling down' | 'horse coming';
export type CommitRejection = 'run active' | 'no such train' | 'train taken' | 'doors closed' | 'out of range' | 'no train in range';
/** Why a `switchTrain` was refused; `aboard` also covers a run that has ended. */
export type SwitchRejection = 'no run' | 'aboard' | 'already committed' | 'no such train' | 'train taken' | 'doors closed' | 'out of range' | 'no train in range';
/** Why a climb was refused. */
export type ClimbRejection = 'no ladder' | 'busy';
/** `on the roof`: a drop up on a roof, mid-jump or on a ladder. */
export type RejectReason = JumpRejection | MountRejection | WhistleRejection | CommitRejection | SwitchRejection | ClimbRejection | 'standing still' | 'on the roof' | 'disabled' | 'nothing to interact with' | 'nothing to drop' | 'not aboard' | 'not mounted' | 'cooling down' | 'nothing to cash out';
/** Why a finished search did not take its item: either carry cap would break. */
export type LootRefusal = 'too heavy' | 'too many items';

export type SimEvent =
  /** `countdownSec` is the run's whole countdown (null with `countdown.enabled` off). */
  /** `resumed`: the commit picked up a run cancelled in place on this train (clock, heat, health and meter carried over). */
  /** `wantedLevel` is the level the run uses; `practice` marks a run at `wanted.forceLevel`, which saves nothing (G9). */
  | { type: 'RunStarted'; tick: number; player: PlayerId; runNumber: number; trainId: string; countdownSec: number | null; wantedLevel: number; day: number; resumed?: true; practice?: true }
  | { type: 'RunPhaseChanged'; tick: number; player: PlayerId; from: RunPhase; to: RunPhase }
  /** The run's committed train changed; the run itself, its start tick and health carry on. */
  | { type: 'TrainSwitched'; tick: number; player: PlayerId; from: string; to: string }
  | { type: 'CommandRejected'; tick: number; player: PlayerId; command: Command['type']; reason: RejectReason }
  /** `meter` is the sampled position, 0 to 1. */
  /** `target` is where the jump went (absent in logs from before issue #60: a door). */
  | { type: 'BoardingAttempt'; tick: number; player: PlayerId; result: BoardingResult; attempt: number; meter: number; target?: BoardingTargetKind }
  | { type: 'DamageDealt'; tick: number; target: PlayerId; amount: number; health: number; cause: 'boarding' | 'mount' }
  /** An alert guard caught the player (guardCatch `thrown-off`): the failed-boarding damage. */
  | { type: 'DamageDealt'; tick: number; target: PlayerId; amount: number; health: number; cause: 'thrownOff' }
  /** A trackside rock knocked the player off a ledge: the same failed-boarding damage as being thrown off. */
  | { type: 'DamageDealt'; tick: number; target: PlayerId; amount: number; health: number; cause: 'fell' }
  /** Running into or scraping a train, or running into blocked ground; `impact` is the speed the horse lost, tiles/s. */
  | { type: 'DamageDealt'; tick: number; target: PlayerId; amount: number; health: number; cause: 'collision'; against: CollisionTarget; kind: 'crash' | 'scrape'; impact: number }
  /** Every heat gain, after clamping to `heat.maxHeat`: `heat` is the new value, `delta` what was actually added. */
  | { type: 'HeatChanged'; tick: number; heat: number; delta: number; cause: HeatCause }
  /** Health ran out (`health.scope: day`): the day ends; `onRun` when a run was on (it also ends `died`). */
  | { type: 'DayEnded'; tick: number; player: PlayerId; day: number; cause: 'died'; onRun: boolean }
  /** A new day at full health, back at the spawn. */
  | { type: 'DayStarted'; tick: number; player: PlayerId; day: number; health: number }
  /**
   * `retry` marks a quick retry, which ends the run as a cancel. `countdownLeftSec` is the time
   * left on the clock (kept for cancels too, so cancelling to dodge expiry is measurable, U6;
   * null with the countdown off) and `heat` the heat at the end. `cashOut` is the loot value banked
   * (a cash-out on F), else 0. `endOfLine`: on an open line, the committed train reached the end of
   * the line (the run expires there). `practice`: a `wanted.forceLevel` run, so `cashOut` is what the
   * outcome would have banked, but nothing was saved (G9).
   */
  | { type: 'RunEnded'; tick: number; player: PlayerId; outcome: RunOutcome; durationTicks: number; boardingAttempts: number; retry: boolean; countdownLeftSec: number | null; heat: number; cashOut: number; endOfLine?: true; practice?: true }
  /**
   * A whistle placed the horse behind the train: `delaySec` was drawn from the horse stream, and the
   * horse starts delay x closing speed back from the player's place in the train (at least a few
   * tiles behind the last car); `distanceTiles` is how far behind the last car. `whistle` counts the run's whistles.
   */
  | { type: 'HorseWhistled'; tick: number; player: PlayerId; side: TrainSide; delaySec: number; distanceTiles: number; whistle: number }
  /** The horse reached the lane beside the player's car; the pace window starts. */
  | { type: 'HorseArrived'; tick: number; player: PlayerId; side: TrainSide; paceWindowSec: number }
  /** The pace window ran out and the horse drops back; a whistle works again after `cooldownSec`. */
  | { type: 'HorseDeparted'; tick: number; player: PlayerId; cooldownSec: number }
  /** A whistle while it was coming or alongside sent the horse to the other side. */
  | { type: 'HorseSideChanged'; tick: number; player: PlayerId; from: TrainSide; to: TrainSide }
  /** The horse cannot reach the player's car (no way round the terrain, or stuck); it keeps trying. */
  | { type: 'HorseBlocked'; tick: number; player: PlayerId; reason: 'no path' | 'stuck' }
  /** Space beside the alongside horse; `meter` is the sampled position, 0 to 1. */
  | { type: 'MountAttempt'; tick: number; player: PlayerId; result: BoardingResult; attempt: number; meter: number }
  /** A good mount spilled loot (mountSpill): the items lost, and the value lost with them. */
  | { type: 'LootSpilled'; tick: number; player: PlayerId; items: string[]; value: number; rule: MountSpill }
  /**
   * Emitted at every run end, changed or not (phase 2 M5): the host saves `after`. `outcome` is how
   * the run ended. `practice`: a `wanted.forceLevel` run, so `after` equals `before` and nothing is saved.
   */
  | { type: 'PersistentChanged'; tick: number; outcome: RunOutcome; before: PersistentState; after: PersistentState; practice?: true }
  /** A search finished and the item was taken. `car` is the car index in the train, `loot` the loot id. */
  | { type: 'LootPickedUp'; tick: number; player: PlayerId; item: string; value: number; weight: number; car: number; loot: number }
  /** A search finished but taking the item would break a carry cap, so it stays. */
  | { type: 'LootRefused'; tick: number; player: PlayerId; item: string; reason: LootRefusal; loot: number }
  | { type: 'LootRevealed'; tick: number; player: PlayerId; item: string; car: number; loot: number }
  /** Carried items lost off the train (thrown off by a guard, or a fall): gone, not left in the car. */
  | { type: 'LootLost'; tick: number; player: PlayerId; item: string; value: number; weight: number; cause: 'thrownOff' | 'fell' }
  | { type: 'LootDropped'; tick: number; player: PlayerId; item: string; value: number; weight: number; car: number; loot: number }
  /** Releasing E or moving off the slot loses the search's progress (`progress` 0 to 1). */
  | { type: 'SearchCancelled'; tick: number; player: PlayerId; loot: number; reason: 'released' | 'moved away'; progress: number }
  /** A guard's awareness changed: `sight` or `noise` raised it, `calm` let it drop after a while with no sign of the player. */
  | { type: 'GuardStateChanged'; tick: number; guard: number; from: GuardAwareness; to: GuardAwareness; cause: 'sight' | 'noise' | 'calm' }
  /** An alert guard went `ai.loseSightSec` without seeing or hearing the player: it stops chasing and searches where they were last seen. */
  | { type: 'GuardLostTrack'; tick: number; guard: number }
  /** A guard saw the player (once per guard until it calms back to unaware); raises `playerSpotted` heat. */
  | { type: 'PlayerSpotted'; tick: number; player: PlayerId; guard: number; car: number }
  /** An alert guard caught the player and threw them off the train (guardCatch `thrown-off`). */
  | { type: 'ThrownOff'; tick: number; player: PlayerId; guard: number; car: number }
  /** A trackside rock knocked the player off a ledge of car `car`: they land on the horse as if thrown off. */
  | { type: 'FellOff'; tick: number; player: PlayerId; car: number; cause: FallCause }
  /** The player finished climbing a ladder of car `car`'s `end`, onto its roof or down to its platform (sneaking PR 3). */
  | { type: 'Climbed'; tick: number; player: PlayerId; car: number; end: CarEnd; to: 'roof' | 'deck'; side?: 'left' | 'right' }
  /** Space on a roof: a jump of `distanceTiles` (speed x air time plus the push) from car `car`'s roof. */
  | { type: 'RoofJumped'; tick: number; player: PlayerId; car: number; distanceTiles: number }
  /**
   * A jump or a walk off a roof's end came down on car `car`: on a roof, or short onto a platform or
   * the coupling below (a loud, staggering drop). Off the train is `FellOff` instead.
   */
  | { type: 'RoofLanded'; tick: number; player: PlayerId; car: number; on: 'roof' | 'platform' | 'coupling' | 'ledge'; jumped: boolean }
  /** A curve threw the player off balance on the roof, sliding toward side `dir` (+1 right, -1 left in the car frame); `push` is the lateral pull that did it, tiles/s². */
  | { type: 'RoofSlipped'; tick: number; player: PlayerId; car: number; dir: 1 | -1; push: number }
  /** The player leaned into the curve long enough to get their balance back. */
  | { type: 'RoofRecovered'; tick: number; player: PlayerId; car: number }
  /** A guard started up (`roof`) or down (`deck`) a ladder of car `car`. */
  | { type: 'GuardClimbing'; tick: number; guard: number; car: number; to: 'roof' | 'deck' }
  /** A guard on a roof slipped on a curve (`outside.roof.slip.guards`); it slides outward and catches itself. */
  | { type: 'GuardSlipped'; tick: number; guard: number; car: number; dir: 1 | -1 }
  /** A guard on a roof jumped the gap toward car `toCar` (`outside.roof.guardJump`); `short` lands it on the platform instead. */
  | { type: 'GuardJumped'; tick: number; guard: number; car: number; toCar: number; short: boolean }
  | { type: 'HorseBoosted'; tick: number; player: PlayerId };

export type GuardAwareness = 'unaware' | 'suspicious' | 'alert';
/** What knocked a player off the train: a trackside rock on a ledge, a bad roof jump, or a slip on a curve. */
export type FallCause = 'rock' | 'jump' | 'slip';
/** A car's front or rear end, where its end platform and ladder are. */
export type CarEnd = 'front' | 'rear';

/** Where a jump from the horse lands: a side door, an end platform, or a side ladder up to the roof (issue #60). */
export type BoardingTargetKind = 'door' | 'platform' | 'ladder';

/**
 * A guard aboard the committed train (phase 2 M3: perception, no combat). Positions are in its
 * car's frame like the player's; `fx, fy` is its unit facing in that frame (+x toward the rear,
 * +y toward the right side), turned at `ai.turnRateDegPerSec`.
 */
export interface GuardState {
  id: number;
  car: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  state: GuardAwareness;
  /** The spawn: its car, the cell centre, and the facing a guard without a patrol keeps on watch. */
  post: { car: number; x: number; y: number; fx: number; fy: number };
  /** Patrol route name in the post car's template, or null to stand watch. */
  patrol: string | null;
  /** The route cell it walks toward, and which way along the route it is going. */
  waypoint: number;
  dir: 1 | -1;
  /** Ticks left of the pause at a route end. */
  waitTicks: number;
  /** Ticks of seeing the player while suspicious, toward `ai.alertAfterTicks`. */
  sightTicks: number;
  /** Ticks since it last saw or heard the player, toward calming down. */
  calmTicks: number;
  /**
   * Ticks an alert guard has gone without seeing or hearing the player. At `ai.loseSightTicks` it
   * gives up the chase: still alert, it walks to where it last knew the player was and looks round.
   */
  lostTicks: number;
  /** Where it last saw or heard the player (car frame; `roof` when they were on the roof), or null. */
  lastKnown: { car: number; x: number; y: number; roof: boolean } | null;
  /** Up on a car's roof (car `car`, at x, y on it); false on the deck: inside, a platform, a ledge or the coupling. */
  roof: boolean;
  /** Climbing a ladder of car `car`'s `end`: ticks left, then it is at the other end of it. */
  climb: { ticks: number; car: number; end: CarEnd } | null;
  /** Set once it has spotted the player since it was last unaware, so the heat comes once per sighting. */
  spotted: boolean;
  /** Slipping on a roof on a curve: sliding toward side `dir` for `ticks` more, then it has caught itself; `cooldown` ticks before the next. */
  slip: { dir: 1 | -1; ticks: number } | null;
  slipCooldownTicks: number;
  /** Jumping the gap between roofs (`outside.roof.guardJump`): train x from and to over `total` ticks, landing on car `toCar`'s roof or short on the platform. */
  jump: { ticks: number; total: number; fromLx: number; toLx: number; toRoof: boolean; toCar: number } | null;
}

export interface PersistentState { wantedLevel: number; bank: number; lifetimeEarned: number }

/** The boarding meter: a marker sweeping back and forth over a track from 0 to 1. */
export interface MeterState {
  /**
   * How far through one back-and-forth the marker is, 0 to 1. It advances by 1 / period each
   * tick in boarding range (slower when speed matched) and is 0 out of range.
   */
  phase: number;
  /** Centre of the good zone (the perfect zone sits in its middle), re-rolled after each jump. */
  zoneCentre: number;
}

export interface PlayerRunState {
  meter: MeterState;
  boardingAttempts: number;
  /** Ticks of good-landing stumble left; walk speed is scaled while above 0. */
  stumbleTicks: number;
  /** Item ids carried, in pickup order; a `drop` slot indexes this. */
  carried: string[];
  /** The search in progress: which loot and how many ticks E has been held on it. */
  search: { loot: number; ticks: number } | null;
  /** Set when a search ends (taken, refused or moved away) while E is still held; cleared on release. */
  searchLatched: boolean;
  /** Crouching aboard (C): slower, quieter, hidden behind cover. Cleared on leaving the train. */
  crouched: boolean;
  /**
   * Climbing a ladder of car `car`'s `end` (sneaking PR 3): ticks left, then on the roof (`to: 'roof'`)
   * or the platform. With `side`, it is that side's ladder up the car's long wall (`outside.roof.sideLadder`),
   * reached by jumping from the horse: always up, to the roof.
   */
  climb: { ticks: number; car: number; end: CarEnd; to: 'roof' | 'deck'; side?: 'left' | 'right' } | null;
  /** In the air after a roof jump: ticks left, and the step per tick in the takeoff car's frame. */
  air: { ticks: number; vx: number; vy: number } | null;
  /** Slipping on a roof on a curve: sliding toward side `dir` (car-frame y) until leaned against for `outside.roof.slip.leanSec`. */
  slip: { dir: 1 | -1; leanTicks: number } | null;
  /** Ticks after a recovered slip before another can start. */
  slipCooldownTicks: number;
  /** Ticks left of the thud of a roof landing, heard `outside.roof.noise.landRadiusTiles` away. */
  thudTicks: number;
}

/** A loot item lying in the committed train: placed by run generation, or dropped by a player. */
export interface LootState {
  id: number;
  /** Car index in the train, and the cell centre in that car's frame. */
  car: number;
  x: number;
  y: number;
  item: string;
  /** On a slot tagged hidden and not yet searched: drawn as a plain stash; searching it reveals the item and clears this. */
  hidden: boolean;
  taken: boolean;
}

export interface RunState {
  runNumber: number;
  startedTick: number;
  /** The committed (pinned) train. */
  trainId: string;
  phase: Exclude<RunPhase, 'idle'>;
  /**
   * Seconds left on the clock: the train's `countdown.baseSec` x `countdown.scale` at commit,
   * drained each tick at `1 + heatDrainFactor x heat/100` while `clockRunning` (U1, U2).
   */
  countdownSec: number;
  /** The whole countdown the run started with, for the HUD's bar. */
  countdownTotalSec: number;
  /** False until the clock starts: at commit, or on boarding with `countdown.startsAt: boarding`. */
  clockRunning: boolean;
  /**
   * On an open line with `countdown.lineClock: town`: the town id (or `end`) the clock counts down
   * to. The clock is then the train's time to reach it and heat does not speed it up.
   */
  clockTo?: string;
  /** Ticks expiry has waited in the grace window so far (U3), up to `countdown.graceTicks`. */
  graceTicks: number;
  /** Times a guard threw the player off this run; each adds `wanted.perThrowOff` at the run's end. */
  thrownOffs: number;
  /** 0 to `heat.maxHeat`; only raiseHeat changes it. */
  heat: number;
  /** Time-aboard heat not yet added: it builds up per tick and is raised a whole point at a time, so each gain is one event. */
  pendingHeat: number;
  /** Integer keys only, so key order is stable. */
  players: Record<PlayerId, PlayerRunState>;
  /** Loot in the committed train, by ascending id. */
  loot: LootState[];
  nextLootId: number;
  /** Guards aboard the committed train, by ascending id. */
  guards: GuardState[];
  /** The riderless horse while the player is aboard (U4). */
  horse: HorseCall;
}

/** The extraction horse's state, in the run so a snapshot resumes it mid-extraction. */
export interface HorseCall {
  state: HorseCallState;
  /** The side of the train it rides up on. */
  side: TrainSide;
  /** Ticks left before a `leaving` horse is removed; ticks in the pace window while `alongside`. */
  ticks: number;
  /** Ticks before another whistle works, after the pace window ends. */
  cooldownTicks: number;
  whistles: number;
  /** Tick of the last whistle and the delay it drew, for the optional HUD timer. */
  whistleTick: number;
  delaySec: number;
  /** Set while it cannot reach the player's car; the HUD says so. */
  blocked: 'no path' | 'stuck' | null;
  /** Closest it has got to its target since it last made progress, and the ticks since then. */
  bestDistance: number;
  stuckTicks: number;
  /** Coarse path cells (row-major index on the `extraction.pathCellTiles` grid) toward the target; empty to ride straight there. */
  path: number[];
  /** Ticks until the path is planned again. */
  replanTicks: number;
  /** Mount jumps made this run. */
  mountAttempts: number;
}

/**
 * Where a player is. `world` while mounted, with x and y following the horse; `car:<trainId>:<index>`
 * aboard, with x along the car's cells (0 at the front) and y across them (0 on the left side).
 */
export interface Placement {
  frame: string;
  x: number;
  y: number;
  layer: 'ground' | 'interior' | 'roof';
}

/** What an in-place cancel keeps for a later commit to the same train. */
export interface ResumeRun {
  trainId: string;
  startedTick: number;
  countdownSec: number;
  countdownTotalSec: number;
  clockRunning: boolean;
  clockTo?: string;
  graceTicks: number;
  heat: number;
  pendingHeat: number;
  health: number;
  meter: MeterState;
  boardingAttempts: number;
}

export interface PlayerState {
  id: PlayerId;
  /** The horse this player rides; every player starts mounted in phase 1. */
  horseId: number;
  /** Latest intents. Commands only arrive when they change, so they persist here. */
  move: { x: number; y: number };
  steer: { x: number; y: number };
  /** E is held (search). */
  interactHeld: boolean;
  placement: Placement;
  /**
   * The commit prompt's timer: the train it asks about (to commit while idle, or to switch to
   * during a run with `commit.promptSwitch`) and how many ticks the rider has stayed in range of it.
   * Null when no such train is in range.
   */
  commitTimer: { trainId: string; ticks: number } | null;
  /** The train an in-place cancel or an extraction just left: only E commits to it until the rider leaves its commit range. */
  commitHold: string | null;
  /**
   * Runs cancelled in place, one per train: committing to that train again picks up where it
   * left off, so Esc cannot reset the clock or reroll the meter. Cleared when a run ends any other way (Esc aboard, quick retry, escape, death, expiry).
   */
  resumeRuns: ResumeRun[];
  /**
   * Health. With `health.scope: day` (the default) it lasts the whole day: runs don't refill it and
   * dying starts a new day at full health. With `run` each commit refills it, as before.
   */
  health: number;
  /** The day number, from 1; dying ends the day (`DayEnded`) and starts the next. */
  day: number;
  /** Ticks before another collision can hurt, so one crash costs health once. */
  hitCooldownTicks: number;
  /** What the last hit cost; inside the cooldown only a harder hit costs more, and only the difference. */
  lastHitDamage: number;
}

export interface HorseState {
  id: number;
  x: number;
  y: number;
  /** Unit heading; turned by the per-tick rotation constants, never by angle. */
  hx: number;
  hy: number;
  /** Tiles per second along the heading, 0 to `horse.maxSpeed`. */
  speed: number;
  /** Target speed for the cruise throttle model, tiles per second. */
  cruiseTarget: number;
  /** Ticks of stun left after a failed jump: no steering or throttle, speed held. */
  stunTicks: number;
  /** Ticks left of a boost (handlingModel `arcade-boost`), then ticks of cooldown before the next. */
  boostTicks: number;
  boostCooldownTicks: number;
  /**
   * `physical` rides the map, ridden or riderless (running off after boarding, or called by the
   * whistle). `away` is out of the world: not simulated and not drawn (U4).
   */
  mode: 'physical' | 'away';
}

export interface TrainState {
  /** Instance id, the `trainId` that `startRun` will name. */
  id: string;
  /** Key into `config.trains`. */
  type: string;
  /** The route it runs on, when the map placed it; otherwise the one its config names. */
  route?: string;
  /** Distance of the engine's front along its route, wrapped. */
  d: number;
  /** Set when a run commits to this train (M3); the scheduler never replaces a pinned train. */
  pinnedBy: PlayerId | null;
  /**
   * Car template ids, engine first. Picked from the train type's layouts by the seed and the next
   * run number, so the train a run commits to has the layouts of that run's seed; re-picked for
   * every free train when a run ends.
   */
  cars: string[];
  /** Set by a cash-out: no commit or switch to this train until `untilTick` (null: never). */
  doorsClosed?: { untilTick: number | null };
}

export interface WorldState {
  trains: TrainState[];
  horses: HorseState[];
}

export type Steering = 'screen' | 'heading';
/** guardCatch variant group: `heat-only` guards only raise heat; `thrown-off` alert guards chase and throw the player off. */
export type GuardCatch = 'heat-only' | 'thrown-off';
export type ThrottleModel = 'hold' | 'coast' | 'cruise';

/**
 * The resolved config values the sim reads. `@train-robber/config`'s ResolvedConfig
 * satisfies this structurally, so the sim does not depend on the config package.
 */
export interface SimConfig {
  hash: string;
  values: {
    sim: { tickRateHz: number };
    player: { speedTilesPerTick: number; crouch: { speedScale: number } };
    world: { mode: 'separate' | 'continuous' };
    /**
     * `auto`: an idle player commits as soon as a train is in range, with no key press.
     * `switchRangeTiles`: how close another train must be to switch the commitment to it with Tab.
     * `autoSwitch`: during a run, riding `autoSwitchMarginTiles` closer to another free train within
     * `rangeTiles` than to the committed one switches to it, with no key press.
     */
    commit: { rangeTiles: number; timerSec?: number | null; switchTimerSec?: number | null; closeRangeTiles?: number | null; promptSwitch: boolean; cancelInPlace: boolean; switchRangeTiles: number; autoSwitch: boolean; autoSwitchMarginTiles: number };
    boarding: {
      rangeTiles: number;
      speedToleranceTilesPerSec: number;
      meter: { sweepPeriodTicks: number; matchedSweepPeriodTicks: number; zoneWidths: readonly [number, number] };
      failure: { stunTicks: number; damageFraction: number; horseSpeedScale: number };
      landing: { stumbleTicks: number; stumbleSpeedScale: number; goodStumbleInTiles: number };
      targets: { doors: boolean; platforms: boolean; sideLadders: boolean };
      doorPeek: { enabled: boolean; rangeTiles: number; coneHalfAngleDeg: number; coneCos: number; sightTiles: number };
    };
    /** `scope`: `day` keeps one health bar until you die, `run` refills it at every commit. */
    health: { max: number; scope: 'day' | 'run' };
    /**
     * Running into a train or blocked ground. On a run, from `minImpactTilesPerSec`; off a run (day
     * scope only), only from `offRunMinImpactTilesPerSec`, with no scrapes.
     */
    collision: { damageFraction: number; obstacleDamageFraction: number; scrapeDamageFraction: number; minImpactTilesPerSec: number; fullImpactTilesPerSec: number; offRunMinImpactTilesPerSec: number; cooldownTicks: number };
    playtest: { quickRetry: boolean; quickRetryGapTiles: number; debugHeatStep: number; edgeGuards: boolean };
    /** The whistle, the riderless horse and the mount jump (U4, G3, G11, G12, G14, G15, G24). */
    extraction: {
      /** Arrival delay range, seconds; the horse starts delay x (horse.maxSpeed - train speed) behind the last car. */
      arrivalDelaySec: readonly [number, number];
      paceWindowTicks: number;
      rewhistleCooldownTicks: number;
      laneOffsetTiles: number;
      /** How long the horse drops back after the pace window before it is removed. */
      dropBackTicks: number;
      /** Within this of its lane point beside the player's car, the horse counts as arrived. */
      alongsideRangeTiles: number;
      /** The horse must be this close to the door for a mount jump. */
      mountRangeTiles: number;
      /** The player must stand this close to a side door (on the horse's side) to mount, or for grace. */
      doorReachTiles: number;
      meter: { sweepPeriodTicks: number; zoneWidths: readonly [number, number] };
      mountSpill: MountSpill;
      /** Share of carried value a good mount loses under `mountSpill: share`. */
      spillShare: number;
      /** Size of the coarse grid the horse paths around blocked and water tiles on. */
      pathCellTiles: number;
      /** No progress toward its target for this long and the horse counts as stuck. */
      stuckTicks: number;
      /** Farther than this from its lane point (off screen), the riderless horse ignores rocks and water; 0 never. */
      passThroughBeyondTiles: number;
      /** How long a good mount stuns the horse. */
      goodMountStunTicks: number;
    };
    countdown: { enabled: boolean; startsAt: 'commit' | 'boarding'; scale: number; graceTicks: number; lineClock?: 'town' | 'fixed' };
    heat: {
      maxHeat: number;
      heatDrainFactor: number;
      sources: { shotFired: number; alarmRaised: number; playerSpotted: number; actorKilled: number; lootTaken: number; timeAboardPerTick: number };
      /** Off when null or absent. */
      boardingResistanceAt?: number | null;
    };
    /** Wanted level 0 to `maxLevel` (phase 2 M5). `forceLevel` set: practice runs at that level that save nothing. */
    wanted: { maxLevel: number; guardBonus: readonly number[]; forceLevel?: number | null; perThrowOff: number };
    outcomePolicy: {
      died: { bankRunLoot: boolean; wantedDelta: number; bankLossFraction: number; reset: readonly ('wantedLevel' | 'bank' | 'lifetimeEarned' | 'upgrades')[] };
      cancelled: { bankRunLoot: boolean; wantedDelta: number };
      expired: { bankRunLoot: boolean; wantedDelta: number };
      extracted: { bankRunLoot: boolean; wantedDelta: number };
      cashedOut: { bankRunLoot: boolean; wantedDelta: number };
      caught: { bankRunLoot: boolean; wantedDelta: number };
    };
    /**
     * F on the horse mid-run: end the run and bank the loot. With `closeDoors` a cash-out shuts that
     * train's doors, and with `closeDoorsOnThrownOff` being thrown off does; a shut train cannot be
     * boarded, committed or switched to for `doorsReopenTicks` (0: never).
     */
    cashOut: { enabled: boolean; closeDoors: boolean; closeDoorsOnThrownOff: boolean; shutDoorsEndRun: boolean; doorsReopenTicks: number };
    horse: {
      /** Tiles per second. */
      maxSpeed: number;
      /** Tiles per second squared. */
      accel: number;
      brake: number;
      dragTilesPerSec2: number;
      cruiseTargetRateTilesPerSec2: number;
      slowZoneSpeedScale: number;
      waterSpeedScale: number;
      turnRateCosPerTick: number;
      turnRateSinPerTick: number;
      steering: Steering;
      throttleModel: ThrottleModel;
      /** After boarding the riderless horse runs off for this long, then leaves the world. */
      runOffTicks: number;
      /** handlingModel `arcade-boost`: a burst to `topSpeedScale` x maxSpeed for `durationTicks`, then `cooldownTicks`. */
      boost: { enabled: boolean; durationTicks: number; cooldownTicks: number; topSpeedScale: number; accelTilesPerSec2: number };
    };
    /** Light guards (phase 2 M3): patrol, sight, noise and awareness; `guardCatch` is what an alert guard does. */
    ai: {
      guardCatch: GuardCatch;
      patrolSpeedTilesPerTick: number;
      patrolPauseTicks: number;
      chaseSpeedTilesPerTick: number;
      turnRateCosPerTick: number;
      turnRateSinPerTick: number;
      sight: { rangeTiles: number; ledgeRangeTiles: number; coneCos: number; crouchCoverMin: number };
      /** `searchRadiusTiles`: how far searching loot (holding E on a slot, hidden or not) carries, crouched or not. */
      /** `stumbleRadiusTiles`: how far the stumble after a good landing carries, moving or not (Devlin, 2026-10-20: loud, like running). */
      noise: { walkRadiusTiles: number; runRadiusTiles: number; crouchRadiusTiles: number; searchRadiusTiles: number; stumbleRadiusTiles: number };
      alertAfterTicks: number;
      calmTicks: number;
      alertCalmTicks: number;
      loseSightTicks: number;
      catchRangeTiles: number;
      thrownOffLootShare: number;
      fellLootShare: number;
      suspiciousStepOutside: boolean;
      suspiciousApproach: boolean;
    };
    /**
     * Outside the cars (sneaking PR 2): an end platform `platformDepthTiles` deep at each end of every
     * car, a `couplingGapTiles` gap between platforms crossed on a `gangwayWidthTiles` coupling plate,
     * and side ledges `ledgeWidthTiles` wide along both long sides (walkable while `ledges` is on).
     * Platforms and the gangway cap walking at `platformSpeedTilesPerTick`, ledges at
     * `ledgeSpeedTilesPerTick`; footsteps on a platform carry `platformNoise` times as far; moving on a ledge carries `ledgeNoiseRadiusTiles`, at any pace.
     * On a ledge, blocked ground (rocks) within `scrape.glanceTiles` outward of the player scrapes
     * them; blocked ground under them knocks them off (`scrape.knockOff`), a fall like thrown-off.
     */
    outside: {
      ledges: boolean;
      platformDepthTiles: number;
      couplingGapTiles: number;
      gangwayWidthTiles: number;
      ledgeWidthTiles: number;
      seeThroughDoorways: boolean;
      platformSpeedTilesPerTick: number;
      ledgeSpeedTilesPerTick: number;
      platformNoise: number;
      ledgeNoiseRadiusTiles: number;
      scrape: { glanceTiles: number; knockOff: boolean; closeDoors: boolean };
      /** The roof (sneaking PR 3): see `RoofConfig`. */
      roof: RoofConfig;
    };
    trains: Readonly<Record<string, TrainDef>>;
    trainMix: { mode: 'map' | 'all-mail' | 'mixed' | 'mostly-blank'; mailTrain: string; blankTrain: string; trainCount: number; blankShare: number };
    carry: { limitEnabled: boolean; slowdownEnabled: boolean; maxWeight: number; maxItems: number; slowdownFromWeight: number; minSpeedScale: number };
    verbs: { search: { searchTimeTicks: number; hiddenSearchTimeTicks: number; timeScale: number; walkSpeedScale: number; cancelRangeTiles: number; reachTiles: number; hiddenLoot: boolean } };
    /** Scales every train's loot density (a balance knob, like countdown.scale). */
    loot: { densityScale: number };
    cellTypes: readonly CellTypeDef[];
    items: Readonly<Record<string, ItemDef>>;
    lootTables: Readonly<Record<string, LootTableDef>>;
    carTemplates: Readonly<Record<string, CarTemplateDef>>;
  };
}

/**
 * Walking on the roofs (sneaking PR 3). With `enabled`, a ladder stands on the end platform at each
 * `ladderEnds` end of every car, at row `ladderRow`; E within `ladderReachTiles` of it climbs for
 * `climbTicks`. Roofs walk at `speedTilesPerTick` running (walking is half; crouched is that times
 * `player.crouch.speedScale`). Footsteps on a roof carry `noise.*` to guards in the car below and on
 * roofs. A guard inside never sees the roof; one on a platform, the coupling or a ledge sees you within
 * `edgeSeenTiles` (crouched `crouchEdgeSeenTiles`) of the roof edge over them. With `guardsClimb`,
 * guards that heard or saw you up there climb up after you. Space jumps: `jump.airTicks` in the air
 * at your speed, plus `jump.pushTiles`; short of a roof you drop to the platform (stumbling for
 * `dropStumbleTicks`) or off the train. On a curve the pull (train speed² x curvature, tiles/s²)
 * times your share of top roof speed past `slip.thresholdTilesPerSec2` starts a slip: you slide
 * toward the outside at `slip.slideTilesPerTick` until you lean into the curve for `slip.leanTicks`.
 */
export interface RoofConfig {
  enabled: boolean;
  ladderEnds: 'both' | 'front' | 'rear';
  ladderCarShare: number;
  ladderRow: number;
  ladderReachTiles: number;
  climbTicks: number;
  sideLadder: { end: CarEnd; fromEndTiles: number };
  speedTilesPerTick: number;
  noise: { walkRadiusTiles: number; runRadiusTiles: number; crouchRadiusTiles: number; landRadiusTiles: number; landTicks: number };
  edgeSeenTiles: number;
  crouchEdgeSeenTiles: number;
  guardSightTiles: number;
  guardsClimb: boolean;
  guardJump: { enabled: boolean; shortShare: number };
  dropStumbleTicks: number;
  jump: { airTicks: number; pushTiles: number; liftTiles: number };
  fallAlert: { enabled: boolean; cars: number; checkTicks: number };
  slip: { enabled: boolean; thresholdTilesPerSec2: number; slideTilesPerTick: number; leanTicks: number; cooldownTicks: number; guards: boolean; guardCatchTicks: number };
}

export interface TrainDef {
  route: string;
  speedTilesPerTick: number;
  engine: string;
  carType: string;
  carCount: number;
  layouts?: readonly string[];
  caboose?: string;
  requireSideDoors: 'both' | 'one' | 'off';
  /** At most this many of the train's cars get side doors (the long-train preset sets 2). */
  maxSideDoorCars?: number;
  /** The run's countdown is baseSec x countdown.scale, copied into the run at commit. */
  countdown: { baseSec: number };
  loot?: { table: string; density: number };
  /** Guards placed on the layouts' guard spawns at commit: `base`, plus the wanted level bonus from M5. */
  guards?: { base?: number; perCar?: number; perWantedLevel?: number };
  verbs: readonly string[];
}

export interface CellTypeDef { id: string; blocksMove: boolean; blocksSight: boolean; cover: number; noise?: number; opensOnInteract?: boolean; colour: string }
export interface ItemDef { name: string; value: number; weight: number; category: string; slotTags: readonly string[]; searchTimeTicks?: number }
export interface LootTableDef {
  items: readonly { item: string; weight: number }[];
  prizes?: { count: readonly [number, number]; items: readonly { item: string; weight: number }[] };
}
/** A car layout as `tools build-cars` writes it; cells are [col, row], col 0 at the front and row 0 on the left. */
export interface CarTemplateDef {
  carType: string;
  size: { cols: number; rows: number };
  legend: readonly string[];
  cells: readonly (readonly [number, number])[];
  entryPoints: readonly { id: string; side: 'left' | 'right' | 'front' | 'rear'; cell: readonly [number, number] }[];
  lootSlots: readonly { cell: readonly [number, number]; tags: readonly string[] }[];
  guardSpawns: readonly { cell: readonly [number, number]; facing: string; patrol?: string }[];
  /** Patrol routes by name: the cells a guard walks, in order. */
  patrols: Readonly<Record<string, readonly (readonly [number, number])[]>>;
}

export interface GameState {
  tick: number;
  seed: string;
  /** Snapshots store the config hash, not the config; restoring needs the same config. */
  configHash: string;
  /** Likewise for the map: its id and a hash of what the sim reads from it. */
  mapId: string;
  mapHash: string;
  /** Runs started so far; run seeds derive from the seed and this count. */
  runCount: number;
  /** Trains spawned so far; instance ids derive from it. */
  trainCount: number;
  rng: RngState;
  persistent: PersistentState;
  run: RunState | null;
  world: WorldState;
  players: PlayerState[];
}

export interface TickResult { tick: number; events: SimEvent[] }
