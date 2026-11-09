// Static guarantees on what replay-service and @forexedge/trading-sim may import:
//
//   - replay-service, and every workspace library it ships (followed through the
//     tsconfig path aliases, transitively), never imports @forexedge/kafka or kafkajs:
//     replay prices can't reach forex.ticks or any other topic
//   - trading-sim stays pure: no @nestjs/*, typeorm, @forexedge/kafka, kafkajs, and
//     not the @forexedge/common barrel (which pulls in NestJS); only the
//     @forexedge/common/money file
//
// Scans shipped sources only (*.spec.ts and test helpers are not bundled).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../..');

// Every module specifier a TypeScript/JavaScript source imports, re-exports or requires
export function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((p) => [...source.matchAll(p)].map((m) => m[1]));
}

export interface Rule {
  name: string;
  forbids: (specifier: string) => boolean;
}

const pkg = (name: string) => (s: string) => s === name || s.startsWith(`${name}/`);
export const NO_KAFKA: Rule[] = [
  { name: '@forexedge/kafka', forbids: pkg('@forexedge/kafka') },
  { name: 'kafkajs', forbids: pkg('kafkajs') },
];
export const PURE_SIM: Rule[] = [
  ...NO_KAFKA,
  { name: '@nestjs/*', forbids: (s) => s.startsWith('@nestjs/') },
  { name: 'typeorm', forbids: pkg('typeorm') },
  { name: 'the @forexedge/common barrel', forbids: (s) => s === '@forexedge/common' },
  { name: '@forexedge/database', forbids: pkg('@forexedge/database') },
];

export interface Violation {
  file: string;
  specifier: string;
  rule: string;
}

export function violations(sources: Map<string, string>, rules: Rule[]): Violation[] {
  return [...sources].flatMap(([file, text]) => importSpecifiers(text).flatMap((specifier) =>
    rules.filter((r) => r.forbids(specifier)).map((r) => ({ file, specifier, rule: r.name }))));
}

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|js)$/.test(name) && !/\.spec\.ts$/.test(name) ? [full] : [];
  });
}

// The workspace path aliases (tsconfig.base.json): alias -> a file, or its library's source folder
function aliases(): Map<string, string> {
  const base = JSON.parse(readFileSync(join(REPO_ROOT, 'tsconfig.base.json'), 'utf8'));
  const out = new Map<string, string>();
  for (const [alias, [target]] of Object.entries(base.compilerOptions.paths as Record<string, string[]>)) {
    const file = join(REPO_ROOT, target);
    // A barrel (src/index.ts) stands for its whole library: anything in it can be re-exported
    out.set(alias, /[\\/]src[\\/]index\.ts$/.test(file) ? join(file, '..') : file);
  }
  return out;
}

// The sources a project ships: its own, plus every workspace library it reaches through aliases
export function shippedSources(root: string): Map<string, string> {
  const alias = aliases();
  const sources = new Map<string, string>();
  const pending = [join(REPO_ROOT, root)];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    if (!existsSync(path)) throw new Error(`missing ${path}`);
    for (const file of sourceFiles(path)) {
      if (/[\\/]testing[\\/]/.test(file)) continue; // test-only entry points (@forexedge/database/testing)
      const text = readFileSync(file, 'utf8');
      sources.set(relative(REPO_ROOT, file).replace(/\\/g, '/'), text);
      for (const specifier of importSpecifiers(text)) {
        const target = alias.get(specifier);
        if (target) pending.push(target);
      }
    }
  }
  return sources;
}

describe('the import scanner', () => {
  it('finds every form of import', () => {
    expect(importSpecifiers([
      "import { Kafka } from 'kafkajs';", 'import "kafkajs/x";', "export * from '@forexedge/kafka';",
      "const k = require('kafkajs');", "const m = await import('@forexedge/kafka');",
      "import type { A } from \"@nestjs/common\";",
    ].join('\n'))).toEqual(['kafkajs', '@forexedge/kafka', '@nestjs/common', 'kafkajs/x', 'kafkajs', '@forexedge/kafka']);
  });

  it('fails on a planted Kafka import in the service', () => {
    const planted = new Map([['apps/replay-service/src/planted.ts', "import { Kafka } from 'kafkajs';\nimport { KAFKA_TOPICS } from '@forexedge/kafka';"]]);
    expect(violations(planted, NO_KAFKA).map((v) => v.rule)).toEqual(['kafkajs', '@forexedge/kafka']);
  });

  it('fails on planted framework, ORM and barrel imports in trading-sim, and allows the money file', () => {
    const planted = new Map([['libs/trading-sim/src/lib/planted.ts', [
      "import { Injectable } from '@nestjs/common';", "import { DataSource } from 'typeorm';",
      "import { assertUserId } from '@forexedge/common';", "import { Kafka } from 'kafkajs';",
      "import { marginRequiredUsd } from '@forexedge/common/money';",
    ].join('\n')]]);
    expect(violations(planted, PURE_SIM).map((v) => v.rule))
      .toEqual(['@nestjs/*', 'typeorm', 'the @forexedge/common barrel', 'kafkajs']);
  });
});

describe('replay-service and trading-sim imports', () => {
  it('replay-service ships no Kafka client, directly or through a library', () => {
    const sources = shippedSources('apps/replay-service/src');
    const files = [...sources.keys()];
    expect(files.length).toBeGreaterThan(25);
    // The closure does follow the aliases into the libraries the service uses
    for (const lib of ['libs/common/src/', 'libs/database/src/', 'libs/trading-sim/src/']) {
      expect(files.some((f) => f.startsWith(lib))).toBe(true);
    }
    expect(files.some((f) => f.startsWith('libs/kafka/'))).toBe(false);
    expect(violations(sources, NO_KAFKA)).toEqual([]);
  });

  it('replay-service never names a Kafka topic', () => {
    const own = [...shippedSources('apps/replay-service/src')].filter(([f]) => f.startsWith('apps/replay-service/'));
    expect(own.length).toBeGreaterThan(20);
    expect(own.filter(([, text]) => /forex\.ticks|KAFKA_TOPICS|orders\.lifecycle/.test(text)).map(([f]) => f)).toEqual([]);
  });

  it('trading-sim is pure: only its own files and @forexedge/common/money', () => {
    const sources = shippedSources('libs/trading-sim/src');
    const files = [...sources.keys()].sort();
    expect(files).toEqual(expect.arrayContaining(['libs/common/src/lib/money.ts', 'libs/trading-sim/src/lib/fills.ts']));
    expect(files.filter((f) => !f.startsWith('libs/trading-sim/'))).toEqual(['libs/common/src/lib/money.ts']);
    expect(violations(sources, PURE_SIM)).toEqual([]);
  });

  it('neither package.json declares a Kafka or framework dependency', () => {
    const sim = JSON.parse(readFileSync(join(REPO_ROOT, 'libs/trading-sim/package.json'), 'utf8'));
    expect(Object.keys({ ...sim.dependencies, ...sim.peerDependencies })).toEqual(['tslib']);
  });
});
