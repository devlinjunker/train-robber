import { defineConfig } from 'vite';

// Two pages: the game, and the Playtests history that reads the same IndexedDB.
export default defineConfig({
  build: { rollupOptions: { input: { main: 'index.html', playtests: 'playtests.html' } } },
});
