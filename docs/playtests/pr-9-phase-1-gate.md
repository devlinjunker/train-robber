# Playtest: Phase 1 gate (PR #9)

The Phase 1 gate asks: **is riding and boarding fun before any loot exists?** There is no pass mark, so the answers below are the record of your judgement. Fill in each answer under its question, then commit this file to the PR (or paste it back in the thread and Claude will commit it).

- **Build:** https://devlinjunker.github.io/train-robber/pr-preview/pr-9/
- **Date played:**
- **Setup played** (URL, including `?v=` variants and `?seed=` if fixed):
- **Machine and browser:**

## Numbers from the logs

Press L at the end of the session, then run `npm run tools -- report <the events file>` on this branch and paste the output here:

```
(paste the report here)
```

## Questions

### 1. Is riding and boarding fun without loot? (the gate)
Yes, no or almost, and why.

> 

### 2. Catching the train
Starting from the spawn, or from a quick retry about 60 tiles behind, does catching the train feel like it takes the right amount of time? The target is roughly 12 s from 60 tiles behind.

> 

### 3. Matching speed
Is getting to ELIGIBLE (in range and speed matched) and staying there satisfying, too easy or too fiddly? Note which throttle model you used (coast, hold or cruise).

> 

### 4. The meter
Do the sweep speeds (1.85 s matched, 1.3 s mismatched) and band widths (perfect 3%, good 15%) feel fair? About how many jumps did a boarding usually take?

> 

### 5. Failing a jump
Do the stun (1.5 s at half horse speed) and the damage (15 per fail, seven fails to die) feel like a fair cost? Does a failure make you want to try again, or is it frustrating?

> 

### 6. Landing and walking aboard
Do the perfect and good landings feel different enough? Does the good-landing stumble (1.5 s at a third of walking speed) feel right? Does walking the car in the world view work, with the camera following and the occlusion hole?

> 

### 7. Missing the train
If you fall behind or miss it, does waiting for it to come round again (about 80 s per lap) feel acceptable, or does it push you to quick retry every time?

> 

### 8. Steering
Which steering felt better, heading-relative (A/D) or screen-relative (arrow keys)? Did either fight you on the curves or along the train?

> 

### 9. Camera and readability
Was the zoom lock during a run, the look-ahead camera and the edge arrows enough to always know where the train and the doors were? Were the door markers and the TOO FAST / TOO SLOW / MATCHED readout easy to read at a glance?

> 

### 10. Anything broken or confusing
Bugs, surprises, or moments you didn't know what to do. Add the seed or the exported log if you can.

> 

### 11. Changes before Phase 2
What would you tune or change before moving on? Include any value you changed while playing and what you settled on.

> 
