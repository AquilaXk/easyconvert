import Redis, { type RedisOptions } from 'ioredis';

/**
 * Unified Redis connection factory supporting Standalone, Sentinel, and Cluster topologies.
 *
 * Reference:
 * - `Stirling-Tools/Stirling-PDF` (`ClusterConfig.java:40-46`, architectural topology validation):
 *   distributed Valkey/Redis deployments require explicit `standalone | sentinel | cluster` mode
 *   selection with fail-closed endpoint validation before constructing clients.
 * - `ioredis` (`Redis` and `Redis.Cluster`, MIT): native Sentinel (`{ sentinels, name }`) and
 *   Cluster (`new Redis.Cluster(seedNodes, { redisOptions })`) drivers.
 */

export type RedisTopologyMode = 'standalone' | 'sentinel' | 'cluster';

export interface HostPortEndpoint {
  host: string;
  port: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const HOST_PORT_PATTERN = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;

export function parseHostPortEndpoints(raw: string, variableName: string): HostPortEndpoint[] {
  const tokens = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(`${variableName} must contain at least one host:port endpoint.`);
  }
  return tokens.map((token) => {
    const match = HOST_PORT_PATTERN.exec(token);
    if (!match) {
      throw new Error(`Invalid endpoint "${token}" in ${variableName}; expected host:port.`);
    }
    const rawHost = match[1];
    const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid TCP port in ${variableName}: "${token}".`);
    }
    return { host, port };
  });
}

export function resolveRedisMode(env: Env = process.env): RedisTopologyMode {
  const raw = env.REDIS_MODE?.trim();
  if (!raw || raw === 'standalone') return 'standalone';
  if (raw === 'sentinel' || raw === 'cluster') return raw;
  throw new Error(`Unsupported REDIS_MODE "${raw}"; expected standalone, sentinel, or cluster.`);
}

export function hasConfiguredRedis(env: Env = process.env): boolean {
  const mode = resolveRedisMode(env);
  if (mode === 'sentinel' || mode === 'cluster') return true;
  return Boolean(env.REDIS_URL?.trim() || env.REDIS_HOST?.trim());
}

export function createConfiguredRedisClient(baseOptions: RedisOptions = {}, env: Env = process.env): Redis {
  const mode = resolveRedisMode(env);
  const password = env.REDIS_PASSWORD?.trim() || undefined;
  const tlsEnabled = env.REDIS_TLS?.trim().toLowerCase() === 'true';

  if (mode === 'sentinel') {
    const sentinelsRaw = env.REDIS_SENTINELS?.trim();
    const sentinelName = env.REDIS_SENTINEL_NAME?.trim();
    if (!sentinelsRaw) {
      throw new Error('REDIS_SENTINELS is required when REDIS_MODE is sentinel.');
    }
    if (!sentinelName) {
      throw new Error('REDIS_SENTINEL_NAME is required when REDIS_MODE is sentinel.');
    }
    const sentinels = parseHostPortEndpoints(sentinelsRaw, 'REDIS_SENTINELS');
    const sentinelPassword = env.REDIS_SENTINEL_PASSWORD?.trim() || undefined;
    return new Redis({
      ...baseOptions,
      sentinels,
      name: sentinelName,
      ...(password !== undefined ? { password } : {}),
      ...(sentinelPassword !== undefined ? { sentinelPassword } : {}),
      ...(tlsEnabled ? { tls: {}, sentinelTLS: {} } : {}),
    });
  }

  if (mode === 'cluster') {
    const clusterRaw = env.REDIS_CLUSTER_NODES?.trim();
    if (!clusterRaw) {
      throw new Error('REDIS_CLUSTER_NODES is required when REDIS_MODE is cluster.');
    }
    const nodes = parseHostPortEndpoints(clusterRaw, 'REDIS_CLUSTER_NODES');
    const ClusterCtor = (Redis as unknown as { Cluster?: typeof Redis.Cluster }).Cluster;
    if (typeof ClusterCtor !== 'function') {
      throw new Error('ioredis Cluster constructor is unavailable in this runtime.');
    }
    return new ClusterCtor(nodes, {
      enableReadyCheck: true,
      enableOfflineQueue: baseOptions.enableOfflineQueue ?? false,
      redisOptions: {
        ...baseOptions,
        ...(password !== undefined ? { password } : {}),
        ...(tlsEnabled ? { tls: {} } : {}),
      },
    }) as unknown as Redis;
  }

  const url = env.REDIS_URL?.trim();
  if (url) {
    return new Redis(url, baseOptions);
  }

  const host = env.REDIS_HOST?.trim() || '127.0.0.1';
  const port = Number(env.REDIS_PORT || 6379);
  return new Redis({
    ...baseOptions,
    host,
    port,
    ...(password !== undefined ? { password } : {}),
    ...(tlsEnabled ? { tls: {} } : {}),
  });
}
