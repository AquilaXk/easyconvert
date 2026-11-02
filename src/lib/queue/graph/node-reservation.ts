import { redisKeyStore } from '../../api-keys/redis-key-store';
import { graphNodeReservedUnits, isChargedPerOutput, isGraphOperation } from '../../jobs/graph-operations';
import { ConversionFailedError } from '../../types';
import type { ConversionRefusalCode } from '../../refusal-codes';
import { graphScheduler } from './scheduler';

/**
 * A graph node with more inputs than its graph reserved conversions for, when the day of its owner has too few left for
 * the rest (docs/policy-decisions.md, entry 15). A retry finds the same count, so the node fails at once, before any work.
 */
export class NodeQuotaExceededError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'quota_exceeded';
  readonly status = 429;
  constructor(message: string) {
    super(message);
    this.name = 'NodeQuotaExceededError';
  }
}

/**
 * Before a node charged per output does any work, holds a conversion for each input file beyond those its graph reserved
 * for it (docs/policy-decisions.md, entry 15). A graph reserves one for each input a node declares, but an input can hold
 * several files (an unpacked archive), so the node extends the graph's reservation by the difference, under the owner's
 * daily limit, and fails with `quota_exceeded`, final, when they do not fit. The extension is the node's own, so a retry
 * holds the same units again instead of adding them. A graph that reserved nothing is not metered.
 */
export async function holdUnitsForInputs(
  graphId: string,
  nodeId: string,
  node: { op?: string; input?: string | string[] },
  inputCount: () => Promise<number>
): Promise<void> {
  // An operation the executor does not know is refused by the executor itself, as unsupported.
  if (node.op === undefined || !isGraphOperation(node.op) || !isChargedPerOutput(node.op)) return;
  const files = await inputCount();
  const extra = files - graphNodeReservedUnits(node);
  if (extra <= 0) return;
  const reservationId = (await graphScheduler.getGraphState(graphId))?.reservationId;
  if (!reservationId) return;
  const held = await redisKeyStore.extendQuota(reservationId, nodeId, extra);
  if (!held.extended) {
    throw new NodeQuotaExceededError(
      `Node "${nodeId}" received ${files} files, ${extra} more than its job reserved conversions for, and ${held.remaining} ${held.remaining === 1 ? 'is' : 'are'} left today.`
    );
  }
}
