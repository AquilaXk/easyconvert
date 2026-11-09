import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { conversionDeadlineMs, syncDeadlineMs } from '@/lib/queue/job-deadline';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { payloadLimitStatus } from '@/lib/api/payload-limit';
import { fileSizeLimitProblem, withinSingleRequest } from '@/lib/api/file-size-limit';
import { validateApiAccess, authErrorHeaders, reserveConversionUnit, withReservedUnit } from '@/lib/api-keys/guard';
import type { ReservedUnit } from '@/lib/api-keys/hand-off';
import { conversionRefusalResponse } from '@/lib/api/conversion-refusal-response';
import { attachmentContentDisposition } from '@/lib/api/content-disposition';
import { loggingOutcomes, type ConversionTrace } from '@/lib/api/conversion-outcome-log';
import { formText, isMultipartBody, readMultipartForm } from '@/lib/api/multipart-body';
import { refusalCodeOf } from '@/lib/refusal-codes';
import { typedFailureProblem } from '@/lib/api/typed-failure-response';
import { codedRefusal, createProblemDetailsResponse } from '@/lib/api/problem-details';
import type { User } from '@/lib/auth/types';
import {
  assertToolInput,
  assertToolUploadMetadata,
  parseToolOptions,
  runWebTool,
  WebToolRefusal,
  type WebTool,
  type WebToolFile,
  type WebToolOutput,
} from '@/lib/tools/web-tools';

const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const MULTIPART_REQUIRED = 'The request body must be multipart/form-data.';

function answerOf(output: WebToolOutput): NextResponse {
  if (output.kind === 'entries') {
    const entries = output.entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      mimeType: entry.mimeType,
      data: entry.buffer.toString('base64'),
    }));
    return NextResponse.json({ success: true, entries });
  }
  return new NextResponse(new Uint8Array(output.buffer), {
    status: 200,
    headers: {
      'Content-Type': output.mimeType,
      'Content-Disposition': attachmentContentDisposition(output.filename),
      'Content-Length': output.buffer.length.toString(),
    },
  });
}

/** The answer for an error a tool run threw: its own refusal, else what the convert routes answer for the same error. */
function toolErrorResponse(error: unknown, instanceUri: string): NextResponse {
  if (error instanceof WebToolRefusal) return codedRefusal(error.status, error.code, error.message);
  const deadlineProblem = deadlineErrorResponse(error, instanceUri);
  if (deadlineProblem) return deadlineProblem;
  const limitStatus = payloadLimitStatus(error);
  if (limitStatus !== null) {
    return createProblemDetailsResponse(limitStatus, error instanceof Error ? error.message : String(error), instanceUri, undefined, undefined, undefined, undefined, { code: refusalCodeOf(error) });
  }
  return typedFailureProblem(error, instanceUri);
}

/** Runs the tool of a request whose unit is reserved; the unit is charged once, and only when the run succeeded. */
async function runTool(req: NextRequest, caller: User, tool: WebTool, unit: ReservedUnit, instanceUri: string, trace: ConversionTrace): Promise<NextResponse> {
  let releaseSlot: (() => void) | undefined;
  // The run that is still going when the answer is sent (a deadline, a disconnect): the slot stays held until it settles.
  let running: Promise<unknown> = Promise.resolve();
  try {
    if (!isMultipartBody(req)) return codedRefusal(HTTP_UNSUPPORTED_MEDIA_TYPE, 'multipart_required', MULTIPART_REQUIRED);
    const slot = await acquireSyncSlot(caller.id, caller.tier);
    if (!slot.granted) return concurrencyLimitResponse(slot.limit, instanceUri);
    releaseSlot = slot.release;

    const body = await readMultipartForm(req);
    if (body.malformed) {
      trace.cause = body.malformed;
      return codedRefusal(400, 'multipart_required', MULTIPART_REQUIRED);
    }
    const uploads = body.form.getAll('files').filter((entry): entry is File => entry instanceof Blob);
    trace.bytes = uploads.reduce((total, file) => total + file.size, 0);
    for (const upload of uploads) {
      const oversize = fileSizeLimitProblem(caller, upload.size, instanceUri);
      if (oversize) return oversize;
    }
    assertToolUploadMetadata(tool, uploads);
    const options = parseToolOptions(tool, formText(body.form, 'options'));
    trace.keepPrivate(uploads.map((upload) => upload.name), {});
    const files: WebToolFile[] = await Promise.all(
      uploads.map(async (upload) => ({ name: upload.name, buffer: Buffer.from(await upload.arrayBuffer()) }))
    );
    assertToolInput(tool, files);

    const source = tool === 'archive-extract' || tool === 'archive-create' ? 'zip' : 'pdf';
    const deadlineMs = syncDeadlineMs(conversionDeadlineMs({ tier: caller.tier, sourceFormat: source, targetFormat: source, inputBytes: trace.bytes }));
    const output = await runUnderDeadline(req, deadlineMs, (limits) => {
      limits.signal.throwIfAborted();
      const work = runWebTool(tool, files, options, limits.signal);
      running = work.catch(() => undefined);
      return work;
    });
    // The answer is built before the unit is committed, so an answer that cannot be built is not charged.
    const answer = answerOf(output);
    await unit.commit();
    return answer;
  } catch (error: unknown) {
    trace.cause = error;
    return toolErrorResponse(error, instanceUri);
  } finally {
    // A caller cannot stack work behind its slots: they come back when the work has ended, not when the answer has gone.
    void running.then(releaseSlot);
  }
}

/** The POST handler of the route of `tool` (`/api/tools/<tool>`), for the route file of that tool. */
export function toolPost(tool: WebTool) {
  return withinSingleRequest(admittingNewFiles(async function POST(req: NextRequest) {
    const instanceUri = req.nextUrl?.pathname || `/api/tools/${tool}`;
    return loggingOutcomes('tools', async (request, trace) => {
      // The caller is authenticated before the body is read: an anonymous one meets the rate limit, as on /api/convert.
      const auth = await validateApiAccess(request, { requiredUnits: 0, requiredScope: 'convert:write', allowAnonymous: true });
      if (!auth.authorized || !auth.user) {
        return createProblemDetailsResponse(auth.status ?? 401, auth.error ?? 'Unauthorized', instanceUri, undefined, auth.problemType, authErrorHeaders(auth));
      }
      const caller = auth.user;
      // One run is one conversion, whatever the number of files it takes.
      const unit = await reserveConversionUnit(caller, 1);
      if (!unit.reserved) return conversionRefusalResponse(unit.refusal, instanceUri);
      return withReservedUnit(unit.reservationId, (reserved) => runTool(request, caller, tool, reserved, instanceUri, trace));
    })(req);
  }));
}
