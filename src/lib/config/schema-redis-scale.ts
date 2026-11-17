import type { VariableSpec } from './schema';

const BOTH = ['web', 'worker'] as const;
const WEB = ['web'] as const;
const REDIS_MODES = ['standalone', 'sentinel', 'cluster'] as const;
const WEB_EXECUTION_MODES = ['hybrid', 'queue-only'] as const;

export const REDIS_SCALE_ENTRIES = [
  {
    name: 'REDIS_MODE',
    area: 'queue',
    description: 'Redis topology mode (`standalone`, `sentinel`, or `cluster`).',
    kind: { type: 'enum', values: REDIS_MODES, caseInsensitive: false },
    default: 'standalone',
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'REDIS_SENTINELS',
    area: 'queue',
    description: 'Comma-separated `host:port` list of Redis Sentinel endpoints, required when `REDIS_MODE` is `sentinel`.',
    kind: { type: 'string' },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'REDIS_SENTINEL_NAME',
    area: 'queue',
    description: 'Redis Sentinel master group name (for example `mymaster`), required when `REDIS_MODE` is `sentinel`.',
    kind: { type: 'string', maxLength: 256 },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'REDIS_SENTINEL_PASSWORD',
    area: 'queue',
    description: 'Password used to authenticate with Redis Sentinel nodes when Sentinel ACLs require one.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'REDIS_CLUSTER_NODES',
    area: 'queue',
    description: 'Comma-separated `host:port` list of Redis Cluster seed nodes, required when `REDIS_MODE` is `cluster`.',
    kind: { type: 'string' },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'REDIS_PASSWORD',
    area: 'queue',
    description: 'Redis server password used when connecting via `REDIS_HOST`, `REDIS_SENTINELS`, or `REDIS_CLUSTER_NODES`.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'REDIS_TLS',
    area: 'queue',
    description: 'Enable TLS when connecting to Redis via `REDIS_HOST`, `REDIS_SENTINELS`, or `REDIS_CLUSTER_NODES`.',
    kind: { type: 'boolean' },
    default: false,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'WEB_EXECUTION_MODE',
    area: 'queue',
    description:
      'How the web server runs conversion and tool requests: `hybrid` runs short synchronous requests in-process and queues async `/api/tools/jobs` whenever a live worker is present; `queue-only` dispatches every conversion and tool request to the Redis worker fleet with zero in-process engine execution.',
    kind: { type: 'enum', values: WEB_EXECUTION_MODES, caseInsensitive: false },
    default: 'hybrid',
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
] as const satisfies readonly VariableSpec[];
