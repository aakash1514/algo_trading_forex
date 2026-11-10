import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// Every Kafka client takes its broker from KAFKA_BROKER. A broker written into the code works on a
// laptop and silently never connects in a container, where localhost is the container itself
// (order-service's orders.lifecycle producer did this until step 7).
const ROOT = join(__dirname, '../../../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : [];
  });
}

describe('Kafka broker configuration', () => {
  it('no Kafka client hard-codes its broker list', () => {
    const files = [
      ...readdirSync(join(ROOT, 'apps')).flatMap((app) => {
        const src = join(ROOT, 'apps', app, 'src');
        try { return sourceFiles(src); } catch { return []; }
      }),
      ...sourceFiles(join(ROOT, 'libs')),
    ];
    expect(files.length).toBeGreaterThan(100); // an empty scan must fail, never pass
    const literal = /brokers\s*:\s*\[\s*['"`]/;
    const offenders = files.filter((f) => literal.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
