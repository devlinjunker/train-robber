import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const bannedMath = ['sin','cos','tan','asin','acos','atan','atan2','exp','log','log2','log10','pow','random','hypot','cbrt','sinh','cosh','tanh'];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  { files: ['apps/game/**/*.ts'], languageOptions: { globals: globals.browser } },
  { files: ['packages/tools/**/*.ts'], languageOptions: { globals: globals.node } },
  { files: ['**/*.cjs'], languageOptions: { globals: globals.node, sourceType: 'commonjs' } },
  ...tseslint.configs.recommended,
  {
    // Determinism rules: the sim must not touch time, DOM, randomness or transcendental Math.
    files: ['packages/sim/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', 'window', 'document', 'performance', 'requestAnimationFrame', 'setTimeout', 'setInterval', 'localStorage'],
      'no-restricted-properties': ['error',
        ...bannedMath.map((p) => ({ object: 'Math', property: p, message: 'Banned in sim: not deterministic across engines. Use precomputed constants.' })),
        { object: 'Date', property: 'now', message: 'Banned in sim: time comes from the tick counter.' },
      ],
      'no-restricted-syntax': ['error',
        { selector: "NewExpression[callee.name='Date']", message: 'Banned in sim.' },
        { selector: "ImportDeclaration[source.value=/pixi|three|^@train-robber\\/(game|tools)/]", message: 'sim must not depend on renderer, game or tools.' },
      ],
    },
  },
);
