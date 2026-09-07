export type D1Row = Record<string, unknown>;

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T extends D1Row = D1Row>(): Promise<T | null>;
  all<T extends D1Row = D1Row>(): Promise<{ results: T[]; success: boolean; meta?: Record<string, unknown> }>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<Array<{ success: boolean; meta?: Record<string, unknown> }>>;
}

export async function first<T extends D1Row>(db: D1Database, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

export async function all<T extends D1Row>(db: D1Database, query: string, ...values: unknown[]): Promise<T[]> {
  const result = await db.prepare(query).bind(...values).all<T>();
  return result.results;
}

export async function batch(db: D1Database, statements: Array<{ query: string; values?: unknown[] }>): Promise<void> {
  await db.batch(statements.map(({ query, values = [] }) => db.prepare(query).bind(...values)));
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
