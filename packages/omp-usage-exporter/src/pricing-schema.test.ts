import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parsePricingFile, PricingFileSchema } from './pricing.js';

const SCHEMA = fileURLToPath(
  new URL('../../../examples/pricing/pricing.schema.json', import.meta.url)
);
const EXAMPLE = fileURLToPath(new URL('../../../examples/pricing/pricing.json', import.meta.url));

function generate(): string {
  const schema = z.toJSONSchema(PricingFileSchema, { target: 'draft-2020-12', io: 'input' });
  return (
    JSON.stringify(
      {
        ...schema,
        $id: 'https://raw.githubusercontent.com/tommasomarchionni/omp-usage/main/examples/pricing/pricing.schema.json',
        title: 'omp-usage-exporter pricing file',
      },
      null,
      2
    ) + '\n'
  );
}

describe('pricing file JSON Schema', () => {
  it('is in sync with the zod schema (UPDATE_SCHEMA=1 to regenerate)', () => {
    const generated = generate();
    if (process.env['UPDATE_SCHEMA'] === '1') writeFileSync(SCHEMA, generated);
    expect(readFileSync(SCHEMA, 'utf8')).toBe(generated);
  });

  it('accepts the shipped example', () => {
    expect(() => parsePricingFile(readFileSync(EXAMPLE, 'utf8'), EXAMPLE)).not.toThrow();
  });
});
