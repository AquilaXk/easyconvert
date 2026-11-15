import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders, reserveConversionUnit } from '@/lib/api-keys/guard';
import { isMultipartBody, readMultipartForm, formText } from '@/lib/api/multipart-body';
import { codedRefusal, createProblemDetailsResponse } from '@/lib/api/problem-details';
import { storageProvider as s3Storage } from '@/lib/storage';
import { sanitizeNodeOutputFilename } from '@/lib/queue/graph/node-jobs';
import { generateJobId } from '@/lib/queue/bullmq-engine';
import { WEB_TOOLS, type WebTool } from '@/lib/tools/tool-names';
import { parseToolOptions, runWebTool, type WebToolFile } from '@/lib/tools/web-tools';
import { saveRetainedResult } from '@/lib/storage/retention-service';

export const dynamic = 'force-dynamic';

export interface ToolJobState {
  id: string;
  userId: string;
  tool: WebTool;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  result?: { name: string; size: number; url: string; key?: string };
  error?: string;
  createdAt: number;
}

export const toolJobStore = new Map<string, ToolJobState>();

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/tools/jobs';
  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write', allowAnonymous: true });
  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(auth.status ?? 401, auth.error ?? 'Unauthorized', instanceUri, undefined, auth.problemType, authErrorHeaders(auth));
  }
  const caller = auth.user;
  const unit = await reserveConversionUnit(caller, 1);
  if (!unit.reserved) return codedRefusal(402, 'credits_exhausted', 'Conversion credit limit reached.');

  if (!isMultipartBody(req)) {
    await unit.rollback();
    return codedRefusal(415, 'multipart_required', 'The request body must be multipart/form-data.');
  }

  const body = await readMultipartForm(req);
  if (body.malformed) {
    await unit.rollback();
    return codedRefusal(400, 'multipart_required', 'Invalid multipart request.');
  }

  const rawTool = formText(body.form, 'tool') || 'merge';
  const toolName = rawTool as WebTool;
  if (!WEB_TOOLS.includes(toolName)) {
    await unit.rollback();
    return codedRefusal(400, 'unsupported_tool', `Unsupported tool: "${rawTool}".`);
  }

  const rawOptions = formText(body.form, 'options');
  const options = parseToolOptions(toolName, rawOptions);
  const uploads = body.form.getAll('files').filter((entry): entry is File => entry instanceof Blob);

  if (uploads.length === 0) {
    await unit.rollback();
    return codedRefusal(400, 'file_required', 'Missing required "files" in multipart request.');
  }

  const jobId = generateJobId();
  const jobState: ToolJobState = {
    id: jobId,
    userId: caller.id,
    tool: toolName,
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
  };
  toolJobStore.set(jobId, jobState);

  const files: WebToolFile[] = await Promise.all(
    uploads.map(async (file) => ({
      name: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
    }))
  );

  void (async () => {
    try {
      jobState.status = 'running';
      jobState.progress = 25;
      const output = await runWebTool(toolName, files, options);
      jobState.progress = 75;
      if (output.kind === 'file') {
        const safeName = sanitizeNodeOutputFilename(output.filename, 'output.bin');
        const storageKey = `conversions/${caller.id}/${Date.now()}_${safeName}`;
        await saveRetainedResult(s3Storage, storageKey, output.buffer, output.mimeType, safeName);
        jobState.result = {
          name: output.filename,
          size: output.buffer.length,
          key: storageKey,
          url: `/api/storage/file/${encodeURIComponent(storageKey)}`,
        };
      }
      jobState.status = 'completed';
      jobState.progress = 100;
      await unit.commit({ from: toolName, base: 1, processingMs: Date.now() - jobState.createdAt });
    } catch (err: unknown) {
      jobState.status = 'failed';
      jobState.error = err instanceof Error ? err.message : String(err);
      await unit.rollback();
    }
  })();

  return NextResponse.json({ success: true, id: jobId, status: 'queued' }, { status: 201 });
}
