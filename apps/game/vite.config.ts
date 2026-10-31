import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// The commit this build is from, shown on the Playtests page. CI sets VITE_BUILD_SHA (a PR's head
// commit, not the merge ref it checks out); a local build asks git.
if (!process.env.VITE_BUILD_SHA) {
  try { process.env.VITE_BUILD_SHA = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no git: no sha */ }
}

// Two pages: the game, and the Playtests history that reads the same IndexedDB.
export default defineConfig({
  build: { rollupOptions: { input: { main: 'index.html', playtests: 'playtests.html' } } },
});
