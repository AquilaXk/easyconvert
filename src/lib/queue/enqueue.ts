import type { ConversionJobData, ConversionJobResult } from '../types';
import type { IStorageBackend } from '../storage/oci-storage';
import { withInputHeld } from '../storage/retention-service';
import { generateJobId, type IQueueEngine, type Job, type JobOptions } from './bullmq-engine';
import { sealJobDataSecrets } from './option-secrets';
import { conversionDeadlineMs, tierMaxDeadlineMs } from './job-deadline';
import { tierForOwner } from './owner-tier';
import { foundOrUnknown, type ReservedUnit } from '../api-keys/hand-off';

/**
 * The one way a conversion job reaches a queue. The job's wall-clock deadline is computed here from the owner's
 * tier and the input, and set as the queue job's `timeout`; the options type has no `timeout`, so a caller can
 * neither omit the deadline nor choose its own. A test scans the source tree for any other `.add(` on a
 * conversion queue (tests/job-deadline-enqueue-sites.test.ts).
 */

/** What the deadline depends on besides the job's formats. */
export interface JobDeadlineOwner {
  /** Tier of the job's owner; an unknown or missing tier is the free tier. */
  tier?: string;
  /** Size of the input in bytes as the server knows it (never a client-declared size); missing means unknown. */
  inputBytes?: number;
  /**
   * Latest time the job may still be running, as an absolute time. A graph node gets the end of its graph's
   * deadline, so a graph never runs longer than the maximum of its tier, whatever its node count.
   */
  notAfter?: number;
}

export type ConversionJobOptions = Omit<JobOptions, 'timeout'>;

/**
 * Puts a conversion job on `queue` with the deadline of its tier and input as the job timeout. The open password of a
 * protected input is sealed under the job id first, so the stored job never holds it (see option-secrets). An input
 * that is an earlier result is held for the job from here until the job ends (see `withInputHeld`).
 */
export async function enqueueConversionJob(
  queue: IQueueEngine<ConversionJobData, ConversionJobResult>,
  name: string,
  data: ConversionJobData,
  opts: ConversionJobOptions,
  owner: JobDeadlineOwner
): Promise<Job<ConversionJobData, ConversionJobResult>> {
  const jobId = opts.jobId ?? generateJobId();
  return withInputHeld(data.storageKey, jobId, () => {
    const job = preparedConversionJob(data, { ...opts, jobId }, owner);
    return queue.add(name, job.data, job.opts);
  });
}

/** The job `opts.jobId` as the queue stores it: its password sealed, and the deadline of its tier and input as its timeout. */
function preparedConversionJob(
  data: Omit<ConversionJobData, 'reservationId'>,
  opts: ConversionJobOptions & { jobId: string },
  owner: JobDeadlineOwner
): { data: ConversionJobData; opts: JobOptions } {
  const timeout = conversionDeadlineMs({
    tier: owner.tier,
    sourceFormat: data.sourceFormat,
    targetFormat: data.targetFormat,
    inputBytes: owner.inputBytes,
  });
  return {
    data: sealJobDataSecrets(data, opts.jobId),
    opts: { ...opts, timeout, ...(owner.notAfter === undefined ? {} : { deadlineAt: owner.notAfter }) },
  };
}

/**
 * Queues a conversion job that takes over the reservation of `unit` (`ReservedUnit.handOff`). The job is sealed and given
 * its deadline first, so a refusal there gives the unit back at once and only the queue write can have an unknown outcome.
 * The job id is chosen before the job is queued, so a job that an enqueue stored before it failed is found by that id, and
 * the request answers it instead of giving its unit back while it runs. The input is held for the job across the enqueue and
 * that lookup, so a job found there keeps its hold; any other failure gives the hold up, and a job stored late takes it
 * again when a worker takes the job.
 */
export async function handOffConversionJob(
  unit: ReservedUnit,
  queue: IQueueEngine<ConversionJobData, ConversionJobResult>,
  data: Omit<ConversionJobData, 'reservationId'>,
  opts: ConversionJobOptions,
  owner: JobDeadlineOwner
): Promise<Job<ConversionJobData, ConversionJobResult>> {
  const jobId = opts.jobId ?? generateJobId();
  const job = preparedConversionJob(data, { ...opts, jobId }, owner);
  return withInputHeld(data.storageKey, jobId, () =>
    unit.handOff({
      start: (reservationId) => queue.add('convert', { ...job.data, reservationId }, job.opts),
      recover: async () => foundOrUnknown(await queue.getJob(jobId)),
    })
  );
}

/** Byte length of a base64 payload without decoding it. */
function base64ByteLength(encoded: string): number {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
}

/**
 * Size of a job's input as the server knows it: the stored object's size, or the length of the inline payload.
 * The `fileSize` a client declares is not used when the input is stored, because the client chooses it. Returns
 * undefined when the object cannot be sized, which gives the job the maximum deadline of its tier.
 */
export async function trustedInputBytes(
  input: { storageKey?: string; inputBufferBase64?: string },
  storage: IStorageBackend
): Promise<number | undefined> {
  if (input.storageKey) {
    const stat = await storage.stat(input.storageKey);
    return stat?.size;
  }
  if (input.inputBufferBase64) return base64ByteLength(input.inputBufferBase64);
  return undefined;
}

/**
 * The timeout of a job that reaches a worker without one (queued before deadlines existed): the maximum of its
 * owner's tier, so no job runs unbounded.
 */
export async function legacyJobTimeoutMs(job: { data: Pick<ConversionJobData, 'userId'> }): Promise<number> {
  return tierMaxDeadlineMs(await tierForOwner(job.data.userId));
}
