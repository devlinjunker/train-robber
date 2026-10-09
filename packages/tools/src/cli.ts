// Phase 0 stub. Subcommands land with their phases.
const [cmd] = process.argv.slice(2);
const known = ['build-maps', 'build-cars', 'sync-car-tileset', 'replay', 'report'];
if (!cmd || !known.includes(cmd)) {
  console.log(`usage: tools <${known.join('|')}>`);
  process.exit(cmd ? 1 : 0);
}
console.log(`tools ${cmd}: not implemented yet`);
