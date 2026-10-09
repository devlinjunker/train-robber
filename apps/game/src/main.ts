import { Application, Graphics, Text } from 'pixi.js';
import { createSim, TICK_RATE } from '@train-robber/sim';

const STEP_MS = 1000 / TICK_RATE;
const MAX_CATCHUP = 5;
const TILE = 24;

const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));

async function boot() {
  const app = new Application();
  await app.init({ resizeTo: window, background: '#2b3a2b', antialias: true });
  document.body.appendChild(app.canvas);

  const sim = createSim({ seed: 1, playerIds: [1] });
  const player = new Graphics().circle(0, 0, 8).fill(0xffd34d);
  const overlay = new Text({ text: '', style: { fill: '#ffffff', fontSize: 12, fontFamily: 'monospace' } });
  overlay.position.set(8, 8);
  app.stage.addChild(player, overlay);

  let acc = 0, last = performance.now(), fps = 0;
  app.ticker.add(() => {
    const now = performance.now();
    acc += now - last; last = now;
    let steps = 0;
    while (acc >= STEP_MS && steps < MAX_CATCHUP) {
      const x = (keys.has('KeyD') ? 127 : 0) - (keys.has('KeyA') ? 127 : 0);
      const y = (keys.has('KeyS') ? 127 : 0) - (keys.has('KeyW') ? 127 : 0);
      sim.step([{ player: 1, commands: [{ type: 'move', x, y }] }]);
      acc -= STEP_MS; steps++;
    }
    if (steps === MAX_CATCHUP) acc = 0;
    const s = sim.snapshot();
    const p = s.players[0]!;
    player.position.set(app.screen.width / 2 + p.x * TILE, app.screen.height / 2 + p.y * TILE);
    fps = fps * 0.9 + app.ticker.FPS * 0.1;
    overlay.text = `tick ${s.tick}  fps ${fps.toFixed(0)}  hash ${sim.hash()}\nWASD to move`;
  });
}
void boot();
