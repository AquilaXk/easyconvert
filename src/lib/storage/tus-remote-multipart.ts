import fs from 'node:fs';
import { assertNotSpoofedFile } from '../security/file-guard';
import { resolveDeclaredFormat } from './declared-format';
import { storageProvider } from './selected-storage';
import {
  compactTailFromFile,
  readFileSlice,
  uploadFileSlicesInParts,
  writeTailFileAtomic,
  writeTextFileAtomic,
  type RemoteFlushCheckpoint,
} from './tus-fd-io';
import type { TusSession, TusSessionStore } from './tus-engine';

export interface RemoteMultipartContext {
  sessionStore: TusSessionStore;
  partBytes: number;
  maxRedisStagedBytes: number;
  magicProbeBytes: number;
  setLocalTailMarker: (id: string, flushedBytes: number, tailBytes: number) => void;
  deleteLocalTailMarker: (id: string) => void;
  rollbackChunk: (binPath: string, offset: number) => void;
  assertStagedSize: (binPath: string, expectedBytes: number) => Promise<void>;
  recordUpload: (key: string) => Promise<void>;
  persistSession: (session: TusSession, infoPath: string) => Promise<void>;
  createSizeMismatchError: (actual: number, expected: number) => Error;
  isSizeMismatchError: (err: unknown) => err is { stagedBytes: number };
}

function restoreHeaderProbeForTail(savedHeaderProbe: string | undefined, revertedTail: number): string | undefined {
  if (revertedTail <= 0 || !savedHeaderProbe) return undefined;
  const decoded = Buffer.from(savedHeaderProbe, 'base64');
  const sliced = decoded.subarray(0, Math.min(decoded.length, revertedTail));
  return sliced.length > 0 ? sliced.toString('base64') : undefined;
}

function restoreRemoteCheckpoint(session: TusSession, checkpoint: RemoteFlushCheckpoint): void {
  session.remoteParts = [...checkpoint.parts];
  session.remoteFlushedBytes = checkpoint.flushedBytes;
  session.uploadOffset = checkpoint.uploadOffset;
  session.completed = checkpoint.completed;
  session.headerProbeBase64 = checkpoint.headerProbeBase64;
}

async function persistRemoteCheckpoint(
  ctx: RemoteMultipartContext,
  session: TusSession,
  infoPath: string,
  previous: RemoteFlushCheckpoint
): Promise<void> {
  let savedToStore = false;
  try {
    await ctx.sessionStore.saveSession(session);
    savedToStore = true;
    await writeTextFileAtomic(infoPath, JSON.stringify(session, null, 2));
  } catch (err) {
    restoreRemoteCheckpoint(session, previous);
    if (savedToStore) {
      await ctx.sessionStore.saveSession(session).catch(() => undefined);
    }
    throw err;
  }
}

async function resetRemoteTailToCheckpoint(
  ctx: RemoteMultipartContext,
  params: {
    id: string;
    binPath: string;
    checkpoint: RemoteFlushCheckpoint;
    compactedOnDisk: boolean;
    remainingTtl: number;
  }
): Promise<void> {
  const { id, binPath, checkpoint, compactedOnDisk, remainingTtl } = params;
  const committedTailLen = Math.max(0, checkpoint.uploadOffset - checkpoint.flushedBytes);
  if (committedTailLen === 0) {
    ctx.rollbackChunk(binPath, 0);
    ctx.setLocalTailMarker(id, checkpoint.flushedBytes, 0);
    await ctx.sessionStore.deleteStagedBytes?.(id);
    return;
  }
  try {
    if (compactedOnDisk) {
      ctx.rollbackChunk(binPath, committedTailLen);
    } else {
      await compactTailFromFile(binPath, checkpoint.cursor, committedTailLen, ctx.partBytes);
    }
  } catch (err) {
    ctx.deleteLocalTailMarker(id);
    throw err;
  }
  ctx.setLocalTailMarker(id, checkpoint.flushedBytes, committedTailLen);
  if (committedTailLen <= ctx.maxRedisStagedBytes && ctx.sessionStore.replaceStagedTailBytes) {
    const committedTail = await readFileSlice(binPath, 0, committedTailLen);
    await ctx.sessionStore.replaceStagedTailBytes(id, committedTail, remainingTtl);
  } else {
    await ctx.sessionStore.deleteStagedBytes?.(id);
  }
}

async function rewindRemoteSessionToOffset(
  ctx: RemoteMultipartContext,
  session: TusSession,
  infoPath: string,
  binPath: string,
  rollbackBytes: number,
  clientOffset: number
): Promise<void> {
  session.completed = false;
  ctx.rollbackChunk(binPath, rollbackBytes);
  session.uploadOffset = clientOffset;
  await ctx.persistSession(session, infoPath);
}

async function dropRemoteSessionState(
  ctx: RemoteMultipartContext,
  id: string,
  infoPath: string,
  binPath: string
): Promise<void> {
  await ctx.sessionStore.deleteSession(id).catch(() => false);
  await fs.promises.rm(infoPath, { force: true }).catch(() => undefined);
  await fs.promises.rm(binPath, { force: true }).catch(() => undefined);
  ctx.deleteLocalTailMarker(id);
  await ctx.sessionStore.deleteStagedBytes?.(id).catch(() => undefined);
}

async function recoverCompletedRemoteUploadFailure(
  ctx: RemoteMultipartContext,
  params: {
    id: string;
    session: TusSession;
    infoPath: string;
    binPath: string;
    clientOffset: number;
    expectedLocalTailOffset: number;
    savedFlushed: number;
  }
): Promise<void> {
  const { id, session, infoPath, binPath, clientOffset, expectedLocalTailOffset, savedFlushed } = params;
  // S3 consumed `remoteUploadId` and `recordUpload` purged `session.key`. Re-open a fresh multipart session
  // when the full payload still sits in `binPath`; abort any unused reopen if rewind fails, preserving caller error.
  if (savedFlushed === 0) {
    let reinitUploadId: string | undefined;
    try {
      const reinit = await storageProvider.initiateMultipartUpload(
        session.filename,
        session.mimeType,
        session.uploadLength,
        session.ownerUserId,
        ctx.partBytes
      );
      reinitUploadId = reinit.uploadId;
      session.key = reinit.key;
      session.remoteUploadId = reinit.uploadId;
      session.remoteParts = [];
      session.remoteFlushedBytes = 0;
      await rewindRemoteSessionToOffset(ctx, session, infoPath, binPath, expectedLocalTailOffset, clientOffset);
      return;
    } catch {
      if (reinitUploadId) {
        await Promise.resolve(storageProvider.abortMultipartUpload(reinitUploadId)).catch(() => undefined);
      }
    }
  }
  await dropRemoteSessionState(ctx, id, infoPath, binPath);
}

export async function flushIntermediateRemoteMultipartUpload(
  ctx: RemoteMultipartContext,
  params: {
    id: string;
    session: TusSession;
    infoPath: string;
    binPath: string;
    clientOffset: number;
    expectedLocalTailOffset: number;
    initialFlushed: number;
    newTailBytes: number;
    savedHeaderProbe?: string;
  }
): Promise<void> {
  const { id, session, infoPath, binPath, clientOffset, expectedLocalTailOffset, initialFlushed, newTailBytes, savedHeaderProbe } =
    params;
  const remainingTtl = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
  if (newTailBytes < ctx.partBytes) {
    if (newTailBytes > 0 && ctx.sessionStore.syncStagedBytes) {
      try {
        await ctx.sessionStore.syncStagedBytes(id, binPath, expectedLocalTailOffset, newTailBytes, remainingTtl);
      } catch (err) {
        ctx.rollbackChunk(binPath, expectedLocalTailOffset);
        ctx.setLocalTailMarker(id, initialFlushed, expectedLocalTailOffset);
        if (initialFlushed === 0 && clientOffset < ctx.magicProbeBytes) {
          session.headerProbeBase64 = savedHeaderProbe;
        }
        throw err;
      }
    }
    ctx.setLocalTailMarker(id, initialFlushed, newTailBytes);
    return;
  }

  const streamedHeaderProbe = session.headerProbeBase64;
  let checkpoint: RemoteFlushCheckpoint = {
    parts: [...(session.remoteParts ?? [])],
    flushedBytes: initialFlushed,
    uploadOffset: clientOffset,
    cursor: 0,
    completed: false,
    headerProbeBase64: savedHeaderProbe,
  };
  let compactedOnDisk = false;

  try {
    const { parts, cursor: flushedCursor, leftover } = await uploadFileSlicesInParts({
      binPath,
      partSize: ctx.partBytes,
      maxCursor: newTailBytes,
      minSliceBytes: ctx.partBytes,
      initialParts: checkpoint.parts,
      uploadPart: (partNumber, slice) => storageProvider.uploadPart(session.remoteUploadId!, partNumber, slice),
      onShortRead: (actualRead) => ctx.createSizeMismatchError(initialFlushed + actualRead, session.uploadLength),
      onPartUploaded: async (uploadedParts, cursor) => {
        const flushedNow = initialFlushed + cursor;
        const durableOffset = Math.max(clientOffset, flushedNow);
        session.completed = false;
        session.remoteParts = [...uploadedParts];
        session.remoteFlushedBytes = flushedNow;
        session.uploadOffset = durableOffset;
        session.headerProbeBase64 = streamedHeaderProbe;
        await persistRemoteCheckpoint(ctx, session, infoPath, checkpoint);
        checkpoint = {
          parts: [...uploadedParts],
          flushedBytes: flushedNow,
          uploadOffset: durableOffset,
          cursor,
          completed: false,
          headerProbeBase64: session.headerProbeBase64,
        };
      },
    });
    const flushedNow = initialFlushed + flushedCursor;
    await writeTailFileAtomic(binPath, leftover);
    compactedOnDisk = true;
    ctx.setLocalTailMarker(id, flushedNow, leftover.length);
    session.remoteParts = [...parts];
    session.remoteFlushedBytes = flushedNow;
    if (leftover.length === 0 && !ctx.sessionStore.replaceStagedTailBytes) {
      await ctx.sessionStore.deleteStagedBytes?.(id);
    } else {
      await ctx.sessionStore.replaceStagedTailBytes?.(id, leftover, remainingTtl);
    }
  } catch (err) {
    restoreRemoteCheckpoint(session, checkpoint);
    if (checkpoint.cursor === 0 && !compactedOnDisk) {
      ctx.rollbackChunk(binPath, expectedLocalTailOffset);
      ctx.setLocalTailMarker(id, initialFlushed, expectedLocalTailOffset);
    } else {
      await resetRemoteTailToCheckpoint(ctx, {
        id,
        binPath,
        checkpoint,
        compactedOnDisk,
        remainingTtl,
      }).catch(() => undefined);
    }
    throw err;
  }
}

export async function completeRemoteMultipartUpload(
  ctx: RemoteMultipartContext,
  params: {
    id: string;
    session: TusSession;
    infoPath: string;
    binPath: string;
    clientOffset: number;
    expectedLocalTailOffset: number;
    initialFlushed: number;
    newTailBytes: number;
    savedHeaderProbe?: string;
  }
): Promise<void> {
  const { id, session, infoPath, binPath, clientOffset, expectedLocalTailOffset, initialFlushed, newTailBytes, savedHeaderProbe } =
    params;
  session.completed = true;
  try {
    await ctx.assertStagedSize(binPath, newTailBytes);
  } catch (err) {
    session.completed = false;
    const actualTail = ctx.isSizeMismatchError(err) ? err.stagedBytes : expectedLocalTailOffset;
    const revertedTail = Math.max(0, Math.min(actualTail, expectedLocalTailOffset));
    session.uploadOffset = initialFlushed + revertedTail;
    if (initialFlushed === 0 && session.uploadOffset < ctx.magicProbeBytes) {
      session.headerProbeBase64 = restoreHeaderProbeForTail(savedHeaderProbe, revertedTail);
    }
    ctx.rollbackChunk(binPath, revertedTail);
    ctx.setLocalTailMarker(id, initialFlushed, revertedTail);
    await ctx.persistSession(session, infoPath);
    throw ctx.createSizeMismatchError(initialFlushed + actualTail, session.uploadLength);
  }

  try {
    const declaredFormat = resolveDeclaredFormat(session.filename, session.mimeType);
    const probeBuffer = session.headerProbeBase64
      ? Buffer.from(session.headerProbeBase64, 'base64')
      : await readFileSlice(binPath, 0, ctx.magicProbeBytes);
    assertNotSpoofedFile(probeBuffer, declaredFormat, session.filename);
  } catch (err) {
    if (initialFlushed === 0 && clientOffset < ctx.magicProbeBytes) {
      session.headerProbeBase64 = savedHeaderProbe;
    }
    await rewindRemoteSessionToOffset(ctx, session, infoPath, binPath, expectedLocalTailOffset, clientOffset);
    throw err;
  }

  const savedParts = [...(session.remoteParts ?? [])];
  const savedFlushed = initialFlushed;
  const streamedHeaderProbe = session.headerProbeBase64;
  let checkpoint: RemoteFlushCheckpoint = {
    parts: [...savedParts],
    flushedBytes: savedFlushed,
    uploadOffset: clientOffset,
    cursor: 0,
    completed: false,
    headerProbeBase64: savedHeaderProbe,
  };
  let remoteCompleted = false;
  let remoteRecorded = false;
  const remainingTtl = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));

  try {
    const { parts } = await uploadFileSlicesInParts({
      binPath,
      partSize: ctx.partBytes,
      maxCursor: newTailBytes,
      minSliceBytes: 1,
      initialParts: savedParts,
      uploadPart: (partNumber, slice) => storageProvider.uploadPart(session.remoteUploadId!, partNumber, slice),
      onShortRead: (actualRead) => ctx.createSizeMismatchError(initialFlushed + actualRead, session.uploadLength),
      onPartUploaded: async (uploadedParts, cursor, isFinalSlice) => {
        if (isFinalSlice) return;
        const flushedNow = savedFlushed + cursor;
        const durableOffset = Math.max(clientOffset, flushedNow);
        session.completed = false;
        session.remoteParts = [...uploadedParts];
        session.remoteFlushedBytes = flushedNow;
        session.uploadOffset = durableOffset;
        session.headerProbeBase64 = streamedHeaderProbe;
        try {
          await persistRemoteCheckpoint(ctx, session, infoPath, checkpoint);
          checkpoint = {
            parts: [...uploadedParts],
            flushedBytes: flushedNow,
            uploadOffset: durableOffset,
            cursor,
            completed: false,
            headerProbeBase64: session.headerProbeBase64,
          };
        } catch {
          // Non-fatal mid-completion: binPath still holds the full tail and final persistSession remains mandatory.
        }
      },
    });
    session.completed = true;
    session.remoteParts = [...parts];
    session.remoteFlushedBytes = session.uploadLength;
    session.uploadOffset = session.uploadLength;
    await storageProvider.completeMultipartUpload(session.remoteUploadId!, parts);
    remoteCompleted = true;
    await ctx.recordUpload(session.key);
    remoteRecorded = true;
    await ctx.persistSession(session, infoPath);
    await fs.promises.rm(binPath, { force: true });
    ctx.deleteLocalTailMarker(id);
    await ctx.sessionStore.deleteStagedBytes?.(id);
  } catch (err) {
    if (remoteRecorded) throw err;
    if (remoteCompleted) {
      if (savedFlushed === 0) session.headerProbeBase64 = savedHeaderProbe;
      await recoverCompletedRemoteUploadFailure(ctx, {
        id,
        session,
        infoPath,
        binPath,
        clientOffset,
        expectedLocalTailOffset,
        savedFlushed,
      });
      throw err;
    }
    restoreRemoteCheckpoint(session, checkpoint);
    if (checkpoint.cursor === 0) {
      await rewindRemoteSessionToOffset(ctx, session, infoPath, binPath, expectedLocalTailOffset, clientOffset);
    } else {
      await resetRemoteTailToCheckpoint(ctx, {
        id,
        binPath,
        checkpoint,
        compactedOnDisk: false,
        remainingTtl,
      }).catch(() => undefined);
      await ctx.persistSession(session, infoPath).catch(() => undefined);
    }
    throw err;
  }
}

export async function rollbackIncompleteRemoteChunk(
  ctx: RemoteMultipartContext,
  params: {
    id: string;
    session: TusSession;
    binPath: string;
    clientOffset: number;
    sessionSaved: boolean;
    savedHeaderProbe?: string;
  }
): Promise<void> {
  const { id, session, binPath, clientOffset, sessionSaved, savedHeaderProbe } = params;
  const committedFlushed = session.remoteFlushedBytes ?? 0;
  const fallbackOffset = Math.max(clientOffset, committedFlushed);
  session.uploadOffset = fallbackOffset;
  const committedTailLen = Math.max(0, fallbackOffset - committedFlushed);
  if (committedFlushed === 0 && fallbackOffset < ctx.magicProbeBytes) {
    session.headerProbeBase64 = savedHeaderProbe;
  }
  if (sessionSaved) {
    await ctx.sessionStore.saveSession(session).catch(() => undefined);
  }
  ctx.rollbackChunk(binPath, committedTailLen);
  ctx.setLocalTailMarker(id, committedFlushed, committedTailLen);
  if (committedTailLen === 0) {
    await ctx.sessionStore.deleteStagedBytes?.(id).catch(() => undefined);
    return;
  }
  if (committedTailLen <= ctx.maxRedisStagedBytes && ctx.sessionStore.replaceStagedTailBytes) {
    const remainingTtl = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
    const committedTail = await readFileSlice(binPath, 0, committedTailLen).catch(() => null);
    if (committedTail) {
      await ctx.sessionStore.replaceStagedTailBytes(id, committedTail, remainingTtl).catch(() => undefined);
    }
  } else {
    await ctx.sessionStore.deleteStagedBytes?.(id).catch(() => undefined);
  }
}
