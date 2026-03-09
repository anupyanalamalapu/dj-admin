declare module "pg" {
  export class Pool {
    constructor(options?: Record<string, unknown>);
    connect(): Promise<{
      query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
      release(): void;
    }>;
  }
}
