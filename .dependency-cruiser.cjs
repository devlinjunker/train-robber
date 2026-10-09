// Dependency rules from docs/technical-design.md ("Dependency rules").
// Run with `npm run deps`; part of `npm run check` and CI.
module.exports = {
  forbidden: [
    {
      name: 'sim-is-standalone',
      comment: 'packages/sim must not import the renderer, game, tools or any other workspace package.',
      severity: 'error',
      from: { path: '^packages/sim/src' },
      to: { path: '^(apps/|packages/(?!sim/))|(^|node_modules/)(pixi\\.js|three)(/|$)' },
    },
    {
      name: 'sim-no-node-builtins',
      comment: 'The sim runs in the browser and on a server; it does no I/O.',
      severity: 'error',
      from: { path: '^packages/sim/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'config-no-renderer-game-tools',
      severity: 'error',
      from: { path: '^packages/config/src' },
      to: { path: '^(apps/|packages/(tools|client)/)|(^|node_modules/)(pixi\\.js|three)(/|$)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)dist/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    combinedDependencies: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default', 'types'] },
  },
};
