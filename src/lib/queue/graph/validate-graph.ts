import type { GraphNode, NodeId } from './types';

// Graph validation has one implementation, shared by the API and the queue scheduler.
export {
  validateJobGraph as validateGraph,
  assertValidJobGraph as assertValidGraph,
  JobGraphValidationError as GraphValidationError,
} from '@/lib/jobs/graph';

export function getNodeInputs(node: GraphNode): NodeId[] {
  if ('input' in node && node.input) {
    if (Array.isArray(node.input)) {
      return node.input;
    }
    return [node.input];
  }
  return [];
}
