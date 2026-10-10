// Runtime checks for Kafka message contracts. Two consumer bugs (a `spreadPips`
// field and a session `status` field that no producer ever sent) went unnoticed
// because consumers cast JSON.parse output to an interface and read undefined.
// Consumers now parse through these functions, so a mismatch fails loudly.
//
// Rules check the fields a consumer relies on; extra fields are allowed, so a
// producer can add fields without breaking consumers.

export class ContractViolationError extends Error {
  constructor(readonly topic: string, readonly problems: string[]) {
    super(`${topic}: message violates its contract: ${problems.join('; ')}`);
    this.name = 'ContractViolationError';
  }
}

type Scalar = 'string' | 'number' | 'boolean';
export type FieldRule =
  | Scalar
  | `${Scalar}|null`
  | 'iso-date'        // string parseable as a date
  | 'string[]'
  | 'object'
  | 'object[]'
  | readonly string[]; // one of these string values

export type Rules = Record<string, FieldRule>;

function checkField(value: unknown, rule: FieldRule): string | null {
  if (Array.isArray(rule)) {
    return typeof value === 'string' && rule.includes(value) ? null : `expected one of ${rule.join('|')}`;
  }
  switch (rule) {
    case 'iso-date':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : 'expected an ISO-8601 date string';
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : 'expected string[]';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? null : 'expected an object';
    case 'object[]':
      return Array.isArray(value) && value.every((v) => v !== null && typeof v === 'object') ? null : 'expected object[]';
    default: {
      const [type, nullable] = (rule as string).split('|');
      if (nullable && value === null) return null;
      if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : 'expected a finite number';
      return typeof value === type ? null : `expected ${rule}`;
    }
  }
}

export function checkRules(obj: Record<string, unknown>, rules: Rules, prefix = ''): string[] {
  const problems: string[] = [];
  for (const [field, rule] of Object.entries(rules)) {
    if (!(field in obj)) {
      problems.push(`missing "${prefix}${field}"`);
      continue;
    }
    const problem = checkField(obj[field], rule);
    if (problem) problems.push(`"${prefix}${field}" ${problem} (got ${JSON.stringify(obj[field])})`);
  }
  return problems;
}

// Parses a raw message and checks it; `extra` adds topic-specific checks.
export function parseContract<T>(
  topic: string,
  raw: string,
  rules: Rules,
  extra?: (obj: Record<string, unknown>) => string[],
): T {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new ContractViolationError(topic, ['not valid JSON']);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ContractViolationError(topic, ['expected a JSON object']);
  }
  const record = obj as Record<string, unknown>;
  const problems = [...checkRules(record, rules), ...(extra ? extra(record) : [])];
  if (problems.length) throw new ContractViolationError(topic, problems);
  return record as T;
}
