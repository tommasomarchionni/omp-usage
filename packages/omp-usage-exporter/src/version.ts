declare const __OMP_USAGE_EXPORTER_VERSION__: string | undefined;

/** Injected by the esbuild bundle; falls back to "0.0.0-dev" under tests. */
export const VERSION: string =
  typeof __OMP_USAGE_EXPORTER_VERSION__ === 'string' ? __OMP_USAGE_EXPORTER_VERSION__ : '0.0.0-dev';
