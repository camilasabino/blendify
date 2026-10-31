import { Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { CoordinationUnavailableError } from '@/domain/errors/coordination-unavailable.error';
import { RedisConnection } from './redis-connection';

export { sanitizeRedisUrl } from './redis-connection';

export const DELETE_IF_VALUE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export const RENEW_IF_VALUE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

function fieldsMatchScript(firstConditionArg: number): string {
  return `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, current = pcall(cjson.decode, raw)
if not ok then return 0 end
for i = ${firstConditionArg}, #ARGV, 2 do
  local node = current
  for part in string.gmatch(ARGV[i], '[^.]+') do
    if type(node) ~= 'table' then
      node = nil
      break
    end
    node = node[part]
  end
  if node ~= ARGV[i + 1] then return 0 end
end
`;
}

export const SET_JSON_IF_FIELDS_SCRIPT = `${fieldsMatchScript(3)}
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`;

export const DELETE_IF_FIELDS_SCRIPT = `${fieldsMatchScript(1)}
redis.call('DEL', KEYS[1])
return 1
`;

export type CoordinationFallback = 'memory' | 'fail-closed';

export interface CacheWriteOptions {
  coordination?: boolean;
}

/**
 * JSON cache backed by Redis (AOF-persisted via docker-compose).
 * Falls back to process memory if Redis is unreachable so local tests
 * and brief outages do not break the API. Coordination writes (claims and
 * conditional state transitions that guard external side effects) never
 * fall back under the fail-closed policy: mixing Redis and process memory
 * would let two requests both believe they own the same operation.
 */
@Injectable()
export class RedisCacheService {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly memory = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  constructor(
    private readonly connection: RedisConnection,
    private readonly coordinationFallback: CoordinationFallback = 'memory',
  ) {}

  async getJson<T>(
    key: string,
    options: CacheWriteOptions = {},
  ): Promise<T | null> {
    const client = this.clientFor(key, options);
    try {
      if (client) {
        const raw = await client.get(key);
        if (raw == null) {
          return null;
        }
        return JSON.parse(raw) as T;
      }
    } catch (error) {
      this.failIfCoordinated(error, options);
      this.logger.warn(
        `Redis get failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const cached = this.memory.get(key);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    try {
      return JSON.parse(cached.value) as T;
    } catch {
      this.memory.delete(key);
      return null;
    }
  }

  async setJson(
    key: string,
    value: unknown,
    ttlMs: number,
    options: CacheWriteOptions = {},
  ): Promise<void> {
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    const encoded = JSON.stringify(value);
    const client = this.clientFor(key, options);

    try {
      if (client) {
        await client.set(key, encoded, 'EX', ttlSec);
        return;
      }
    } catch (error) {
      this.failIfCoordinated(error, options);
      this.logger.warn(
        `Redis set failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.memory.set(key, {
      value: encoded,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async setIfAbsent(
    key: string,
    value: string,
    ttlMs: number,
    options: CacheWriteOptions = {},
  ): Promise<boolean> {
    const ttl = Math.max(1, Math.ceil(ttlMs));
    const client = this.clientFor(key, options);

    try {
      if (client) {
        return (await client.set(key, value, 'PX', ttl, 'NX')) === 'OK';
      }
    } catch (error) {
      this.failIfCoordinated(error, options);
      this.logger.warn(
        `Redis set-if-absent failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (this.liveMemoryEntry(key)) {
      return false;
    }
    this.memory.set(key, { value, expiresAt: Date.now() + ttl });
    return true;
  }

  async exists(key: string, options: CacheWriteOptions = {}): Promise<boolean> {
    const client = this.clientFor(key, options);

    try {
      if (client) {
        return (await client.exists(key)) > 0;
      }
    } catch (error) {
      this.failIfCoordinated(error, options);
      this.logger.warn(
        `Redis exists failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return this.liveMemoryEntry(key) !== null;
  }

  async deleteIfValue(key: string, value: string): Promise<void> {
    if (this.liveMemoryEntry(key)?.value === value) {
      this.memory.delete(key);
    }
    const client = this.connection.readyClient();

    try {
      if (client) {
        await client.eval(DELETE_IF_VALUE_SCRIPT, 1, key, value);
      }
    } catch (error) {
      this.logger.warn(
        `Redis delete-if-value failed for ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async renewIfValue(
    key: string,
    value: string,
    ttlMs: number,
    options: CacheWriteOptions = {},
  ): Promise<boolean> {
    const ttl = Math.max(1, Math.ceil(ttlMs));
    const client = this.clientFor(key, options);

    if (client) {
      return (
        (await this.evalScript(
          client,
          options,
          RENEW_IF_VALUE_SCRIPT,
          key,
          value,
          ttl,
        )) === 1
      );
    }

    const entry = this.liveMemoryEntry(key);
    if (entry?.value !== value) {
      return false;
    }
    entry.expiresAt = Date.now() + ttl;
    return true;
  }

  async setJsonIfFields(
    key: string,
    value: unknown,
    ttlMs: number,
    expected: Record<string, string>,
    options: CacheWriteOptions = {},
  ): Promise<boolean> {
    const ttl = Math.max(1, Math.ceil(ttlMs));
    const encoded = JSON.stringify(value);
    const client = this.clientFor(key, options);

    if (client) {
      return (
        (await this.evalScript(
          client,
          options,
          SET_JSON_IF_FIELDS_SCRIPT,
          key,
          encoded,
          ttl,
          ...Object.entries(expected).flat(),
        )) === 1
      );
    }

    const entry = this.liveMemoryEntry(key);
    if (!entry || !memoryFieldsMatch(entry.value, expected)) {
      return false;
    }
    this.memory.set(key, { value: encoded, expiresAt: Date.now() + ttl });
    return true;
  }

  async deleteIfFields(
    key: string,
    expected: Record<string, string>,
    options: CacheWriteOptions = {},
  ): Promise<boolean> {
    const client = this.clientFor(key, options);

    if (client) {
      return (
        (await this.evalScript(
          client,
          options,
          DELETE_IF_FIELDS_SCRIPT,
          key,
          ...Object.entries(expected).flat(),
        )) === 1
      );
    }

    const entry = this.liveMemoryEntry(key);
    if (!entry || !memoryFieldsMatch(entry.value, expected)) {
      return false;
    }
    this.memory.delete(key);
    return true;
  }

  private clientFor(key: string, options: CacheWriteOptions): Redis | null {
    const client = this.connection.readyClient();
    if (client || !options.coordination) {
      return client;
    }
    if (this.coordinationFallback === 'fail-closed') {
      throw new CoordinationUnavailableError();
    }
    this.logger.warn(
      `Redis unavailable; coordinating ${key} in process memory (non-production only)`,
    );
    return null;
  }

  private async evalScript(
    client: Redis,
    options: CacheWriteOptions,
    script: string,
    key: string,
    ...args: (string | number)[]
  ): Promise<number> {
    try {
      return Number(await client.eval(script, 1, key, ...args));
    } catch (error) {
      this.failIfCoordinated(error, options);
      throw error;
    }
  }

  private failIfCoordinated(error: unknown, options: CacheWriteOptions): void {
    if (options.coordination && this.coordinationFallback === 'fail-closed') {
      throw new CoordinationUnavailableError({ cause: error });
    }
  }

  private liveMemoryEntry(
    key: string,
  ): { value: string; expiresAt: number } | null {
    const entry = this.memory.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry;
  }
}

function memoryFieldsMatch(
  raw: string,
  expected: Record<string, string>,
): boolean {
  let current: unknown;
  try {
    current = JSON.parse(raw);
  } catch {
    return false;
  }

  return Object.entries(expected).every(([path, value]) => {
    let node: unknown = current;
    for (const part of path.split('.')) {
      node =
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined;
    }
    return node === value;
  });
}
