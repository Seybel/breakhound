// Writes dist/schema.json, the JSON Schema for breakhound.config.json, from the
// BreakhoundConfig type so the two can't drift apart.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const here = dirname(fileURLToPath(import.meta.url));

export function buildSchema() {
  const schema = createGenerator({
    path: join(here, 'src/define.ts'),
    tsconfig: join(here, 'tsconfig.json'),
    type: 'BreakhoundConfig',
    expose: 'none',
    topRef: false,
    skipTypeCheck: true,
  }).createSchema('BreakhoundConfig');
  schema.title = 'breakhound config';
  schema.properties = {
    $schema: { type: 'string', description: 'The JSON Schema this file follows.' },
    ...schema.properties,
  };
  return schema;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(here, 'dist/schema.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(buildSchema(), null, 2)}\n`);
}
