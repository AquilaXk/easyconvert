import { loadConfig } from './index';

/**
 * The worker's start-up configuration check. The worker entry imports this module before anything else, so
 * ES module evaluation order runs it before any other module connects to a queue, a store or a storage backend:
 * a bad production configuration throws a ConfigurationError here and the process exits non-zero.
 */
export const workerConfig = loadConfig(process.env, { role: 'worker' });
