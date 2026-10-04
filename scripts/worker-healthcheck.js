#!/usr/bin/env node

/**
 * EasyConvert Worker Healthcheck Script
 *
 * Verifies:
 * 1. Worker heartbeat file vitality (/tmp/worker-heartbeat.json)
 * 2. Redis broker connectivity when REDIS_HOST is configured
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE || path.join('/tmp', 'worker-heartbeat.json');
const MAX_STALE_MS = Number.parseInt(process.env.WORKER_HEARTBEAT_MAX_STALE_MS || '35000', 10);
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT || '6379', 10);

async function checkRedisConnectivity(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Redis connection timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    socket.connect(port, host, () => {
      // Send Redis PING command
      socket.write('*1\r\n$4\r\nPING\r\n');
    });

    socket.on('data', (data) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.end();
        if (data.toString().includes('PONG')) {
          resolve(true);
        } else {
          reject(new Error(`Unexpected Redis response: ${data.toString()}`));
        }
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function runHealthcheck() {
  // 1. Check local heartbeat vitality
  if (!fs.existsSync(HEARTBEAT_FILE)) {
    console.error(`[Healthcheck] Failure: Heartbeat file not found at ${HEARTBEAT_FILE}`);
    process.exit(1);
  }

  let heartbeat;
  try {
    const raw = fs.readFileSync(HEARTBEAT_FILE, 'utf-8');
    heartbeat = JSON.parse(raw);
  } catch (err) {
    console.error(`[Healthcheck] Failure: Unable to parse heartbeat file:`, err);
    process.exit(1);
  }

  const ageMs = Date.now() - (heartbeat.timestamp || 0);
  if (ageMs > MAX_STALE_MS) {
    console.error(`[Healthcheck] Failure: Heartbeat is stale (age: ${ageMs}ms > max: ${MAX_STALE_MS}ms)`);
    process.exit(1);
  }

  if (heartbeat.status === 'draining' || heartbeat.status === 'stopped') {
    console.error(`[Healthcheck] Failure: Worker status is '${heartbeat.status}'`);
    process.exit(1);
  }

  // 2. Check Redis broker connectivity if configured
  if (REDIS_HOST && process.env.CHECK_REDIS !== 'false') {
    try {
      await checkRedisConnectivity(REDIS_HOST, REDIS_PORT);
    } catch (err) {
      console.error(`[Healthcheck] Failure: Redis connectivity check failed:`, err.message);
      process.exit(1);
    }
  }

  console.log(`[Healthcheck] Healthy. Worker PID ${heartbeat.pid}, active jobs: ${heartbeat.activeJobs || 0}, age: ${ageMs}ms.`);
  process.exit(0);
}

module.exports = { checkRedisConnectivity, runHealthcheck };

if (require.main === module) {
  runHealthcheck().catch((err) => {
    console.error('[Healthcheck] Unexpected error:', err);
    process.exit(1);
  });
}
