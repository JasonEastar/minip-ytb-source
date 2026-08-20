import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import typescript from 'rollup-plugin-typescript2';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import terser from '@rollup/plugin-terser';
import babel from '@rollup/plugin-babel';

const input = 'src/index.ts';
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const bgUtilsLicense = `MIT License

Copyright (c) 2024 LuanRT

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const externalDeps = [
  'react-native',
  'expo-file-system',
  'expo-file-system/legacy',
  'expo-modules-core',
  'react-native-mmkv',
];

const isExternal = (id) => {
  if (id.startsWith('.') || path.isAbsolute(id)) return false;
  return externalDeps.some((dep) => id === dep || id.startsWith(dep + '/'));
};

const plugins = [
  resolve({ extensions, browser: false, preferBuiltins: true }),
  commonjs(),
  json(),
  typescript({
    tsconfig: 'tsconfig.json',
    useTsconfigDeclarationDir: false,
    clean: true,
    tslib: require.resolve('tslib'),
  }),
  babel({
    babelHelpers: 'bundled',
    extensions,
    include: ['src/**', 'node_modules/**'],
    presets: [
      [
        '@babel/preset-env',
        {
          targets: { ios: '12', android: '21' },
          modules: false,
        },
      ],
    ],
    plugins: [['@babel/plugin-syntax-import-attributes', { deprecatedAssertSyntax: true }]],
  }),
  terser({ format: { comments: false } }),
];

const sourceBundle = {
  input,
  external: isExternal,
  plugins,
  output: {
    file: 'dist/youtube.bundle.js',
    format: 'cjs',
    exports: 'auto',
    sourcemap: false,
  },
};

const poTokenRuntime = {
  input: 'src/po-token-runtime.ts',
  plugins: [
    resolve({ extensions, browser: true, preferBuiltins: false }),
    typescript({
      tsconfig: 'tsconfig.json',
      useTsconfigDeclarationDir: false,
      clean: true,
      tslib: require.resolve('tslib'),
    }),
    terser({ format: { comments: false } }),
    {
      name: 'html-runtime',
      generateBundle(_outputOptions, bundle) {
        const chunk = Object.values(bundle).find((item) => item.type === 'chunk');
        if (!chunk || chunk.type !== 'chunk') throw new Error('PO token runtime chunk missing');
        for (const fileName of Object.keys(bundle)) delete bundle[fileName];
        this.emitFile({
          type: 'asset',
          fileName: 'youtube-po-token.json',
          source: JSON.stringify(
            `<!doctype html><!--\n${bgUtilsLicense}\n--><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script>${chunk.code.replace(/<\/script/gi, '<\\/script')}</script></head><body></body></html>`
          ),
        });
      },
    },
  ],
  output: {
    dir: '../../assets',
    format: 'iife',
  },
};

export default [sourceBundle, poTokenRuntime];
