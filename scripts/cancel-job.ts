import { parseOperatorCliArgs } from '../src/lib/auth/operator-cli-args';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { cancelSingleGraphJob, cancelSingleQueueJob } from '../src/lib/queue/cancel-work';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { graphScheduler } from '../src/lib/queue/graph';
import { nodeJobCancelRefusal } from '../src/lib/queue/graph/node-jobs';
import { listVisibleWork } from '../src/lib/queue/user-jobs';

/**
 * Operator CLI to inspect and force-cancel stuck or abusive waiting/active jobs or graphs.
 * Reuses the queue and graph cancellation paths (`cancelSingleQueueJob` / `cancelSingleGraphJob`)
 * so quota refunds, input cleanup, and pub/sub cancellation events fire cleanly.
 * Dry-run by default; `--apply` executes cancellations (capped at 200 items per `--user` run).
 */
export const MAX_USER_CANCEL_JOBS = 200;
export const OPERATOR_CANCEL_REASON = 'Cancelled by operator';

export interface CancelTarget {
  kind: 'job' | 'graph';
  id: string;
  state: string;
  label?: string;
}

export interface CancelWorkPlan {
  mode: 'job' | 'user';
  userId?: string;
  email?: string;
  targets: CancelTarget[];
  capped: boolean;
}

export interface CancelWorkOutcome {
  cancelledIds: string[];
  skippedIds: string[];
}

function formatPairLabel(sourceFormat?: string, targetFormat?: string): string | undefined {
  return sourceFormat && targetFormat ? `${sourceFormat}->${targetFormat}` : undefined;
}

/** Builds a dry-run cancellation plan for a single job or graph id. */
export async function planCancelByJob(jobId: string): Promise<CancelWorkPlan | { refusal: string }> {
  const job = await conversionQueue.getJob(jobId);
  if (job) {
    const nodeRefusal = nodeJobCancelRefusal(job.data);
    if (nodeRefusal) {
      return { refusal: `${nodeRefusal.detail} Use --job ${nodeRefusal.graphId} to cancel the graph.` };
    }
    if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
      return { refusal: `Job ${jobId} is in state "${job.state}" and cannot be cancelled.` };
    }
    return {
      mode: 'job',
      targets: [
        {
          kind: 'job',
          id: job.id,
          state: job.state ?? 'waiting',
          label: formatPairLabel(job.data?.sourceFormat, job.data?.targetFormat),
        },
      ],
      capped: false,
    };
  }

  const graph = await graphScheduler.getGraphState(jobId);
  if (!graph) {
    return { refusal: `No job or graph ${jobId}.` };
  }
  if (graph.status !== 'running') {
    return { refusal: `Graph ${jobId} is in state "${graph.status}" and cannot be cancelled.` };
  }
  return {
    mode: 'job',
    targets: [{ kind: 'graph', id: graph.graphId, state: graph.status }],
    capped: false,
  };
}

/** Builds a dry-run cancellation plan for up to `MAX_USER_CANCEL_JOBS` waiting/active jobs and running graphs of one user. */
export async function planCancelByUser(idOrEmail: string): Promise<CancelWorkPlan | { refusal: string }> {
  const user = idOrEmail.includes('@')
    ? await redisUserStore.findByEmail(idOrEmail)
    : await redisUserStore.findById(idOrEmail);
  if (!user) {
    return { refusal: `No account ${idOrEmail}.` };
  }

  const visible = await listVisibleWork(user.id, ['waiting', 'active', 'delayed'], MAX_USER_CANCEL_JOBS);
  const targets: CancelTarget[] = visible.map((item) =>
    item.kind === 'job'
      ? {
          kind: 'job',
          id: item.job.id,
          state: item.job.state ?? 'waiting',
          label: formatPairLabel(item.job.data?.sourceFormat, item.job.data?.targetFormat),
        }
      : {
          kind: 'graph',
          id: item.graph.graphId,
          state: item.graph.status,
        }
  );

  return {
    mode: 'user',
    userId: user.id,
    email: user.email,
    targets,
    capped: visible.length >= MAX_USER_CANCEL_JOBS,
  };
}

/** Applies a cancellation plan, returning cancelled and concurrently skipped IDs. */
export async function applyCancelPlan(
  plan: CancelWorkPlan,
  reason: string = OPERATOR_CANCEL_REASON
): Promise<CancelWorkOutcome> {
  const cancelledIds: string[] = [];
  const skippedIds: string[] = [];

  for (const target of plan.targets) {
    const cancelled =
      target.kind === 'graph'
        ? await cancelSingleGraphJob(target.id, reason)
        : await cancelSingleQueueJob(target.id, reason);
    if (cancelled) {
      cancelledIds.push(target.id);
    } else {
      skippedIds.push(target.id);
    }
  }

  return { cancelledIds, skippedIds };
}

export async function main(argv: readonly string[]): Promise<number> {
  const usage = 'Usage: cancel-job (--job <jobId> | --user <account id or email>) [--apply]';
  const parsed = parseOperatorCliArgs(argv, {
    valueFlags: ['--job', '--user'],
    booleanFlags: ['--apply'],
  });
  if (!parsed.ok) {
    console.error(`${parsed.error}\n${usage}`);
    return 2;
  }

  const jobId = parsed.values.get('--job');
  const idOrEmail = parsed.values.get('--user');
  if (Boolean(jobId) === Boolean(idOrEmail)) {
    console.error(usage);
    return 2;
  }

  const plan = jobId ? await planCancelByJob(jobId) : await planCancelByUser(idOrEmail!);
  if ('refusal' in plan) {
    console.error(plan.refusal);
    return 1;
  }

  if (plan.mode === 'user') {
    console.log(`${plan.email} (${plan.userId}): ${plan.targets.length} active/waiting item(s)`);
  }
  for (const target of plan.targets) {
    console.log(`  ${target.kind} ${target.id} [${target.state}]${target.label ? ` (${target.label})` : ''}`);
  }
  if (plan.capped) {
    console.log(`Notice: reached cap of ${MAX_USER_CANCEL_JOBS} items; run again if more remain.`);
  }
  if (plan.targets.length === 0) {
    console.log('No active or waiting jobs found.');
    return 0;
  }

  if (!parsed.flags.has('--apply')) {
    console.log('Dry run: nothing was cancelled. Run again with --apply to cancel.');
    return 0;
  }

  const outcome = await applyCancelPlan(plan);
  console.log(
    `${new Date().toISOString()} cancel-job: cancelled=${outcome.cancelledIds.length} skipped=${outcome.skippedIds.length}`
  );
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    }
  );
}
