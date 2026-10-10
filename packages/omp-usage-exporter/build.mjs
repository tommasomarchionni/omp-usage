// Bundles the CLI into a single ESM file. The internal protocol workspace is
// inlined; runtime dependencies (native better-sqlite3 and friends) stay
// external and are installed from npm.
import { build } from 'esbuild';
import { chmodSync, readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});

rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  define: { __OMP_USAGE_EXPORTER_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning',
});
chmodSync(new URL('./dist/cli.js', import.meta.url), 0o755);
