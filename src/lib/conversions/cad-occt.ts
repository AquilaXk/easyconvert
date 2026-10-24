import fs from 'node:fs';
import path from 'node:path';
import {
  CpuTaskTimeoutError,
  EngineUnavailableError,
  UnprocessableCadInputError,
  type ConversionOptions,
} from '../types';
import {
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
  cleanupWorkerSandboxDir,
  createWorkerSandboxDir,
  executeSandboxedBinary,
  rethrowSandboxUnavailable,
} from '../../worker/sandbox';
import { prepareIgesForKernel } from './cad-iges-preflight';
import { stageTimeoutMs, type JobDeadlined } from './job-time';
import { resolveBinaryPath } from './pdf-postprocess/utils';
import { createDeflatedZipBuffer } from './zip-writer';

/**
 * STEP and IGES input and output. The in-process engine has no B-rep kernel: `cad-convert` (native/cad-convert, our own
 * small program linked dynamically to the unmodified Open CASCADE libraries, LGPL-2.1 with the exception) reads the file
 * into the document model, writes STEP and IGES from the B-rep itself and meshes STL and OBJ from it, all in
 * millimetres. It runs as a separate process in the worker sandbox with a time, memory, file-size and network limit, and
 * its absence is an error: there is no other path that reads these files.
 *
 * It also writes IGES from a mesh (an STL or OBJ source): the worker parses the mesh, hands the program the indexed triangle
 * list, and the kernel builds a B-rep of planar faces from it as FreeCAD does (native/cad-convert, `--from mesh`), so the IGES file
 * is one the kernel's own reader reads back.
 */

/** Source formats the program reads, by the name it takes. */
const READABLE_SOURCES: Readonly<Record<string, 'step' | 'iges'>> = { step: 'step', stp: 'step', iges: 'iges', igs: 'iges' };
/** Targets the program writes, by the name it takes. */
const WRITABLE_TARGETS: Readonly<Record<string, 'step' | 'iges' | 'stl' | 'obj'>> = { step: 'step', stp: 'step', iges: 'iges', igs: 'iges', stl: 'stl', obj: 'obj' };

/** Media type of each target extension. */
export const OCCT_CONVERTER_MIME: Readonly<Record<string, string>> = {
  step: 'model/step',
  stp: 'model/step',
  iges: 'model/iges',
  igs: 'model/iges',
  stl: 'model/stl',
  obj: 'model/obj',
};

const PROGRAM_NAME = 'cad-convert';
const PROGRAM_PATH_VARIABLE = 'CAD_CONVERT_PATH';
const PROGRAM_CANDIDATES = ['/usr/local/bin/cad-convert', '/usr/bin/cad-convert', '/opt/homebrew/bin/cad-convert'];
/** One model may take this long; the job's own deadline can shorten it. Meshing and writing a large assembly is the slow part. */
const PROGRAM_DEFAULT_TIMEOUT_MS = 120_000;
/** The kernel holds the whole model and its mesh in memory. */
const PROGRAM_MEMORY_LIMIT_MB = 2048;
/** The largest output accepted. */
const PROGRAM_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const PROGRAM_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_OUTPUT_NAME_CHARS = 64;
const DEFAULT_OUTPUT_STEM = 'output';
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9._-]/g;
const MESH_HEADER_BYTES = 8;
const MAX_DETAIL_CHARS = 200;
const SHELL_NOT_EXECUTABLE = 126;
const ZIP_MIME = 'application/zip';
const OUTPUT_TOO_LARGE = 'The model is larger than the CAD converter may write.';
const SHELL_NOT_FOUND = 127;
const UNPRINTABLE = /[^\x20-\x7e]/g;
const ERROR_LINE = /^cad-convert: error: (.*)$/m;
/** The error line of a program that ran out of memory: `memory` is its code. */
const MEMORY_ERROR_LINE = /^cad-convert: error: memory:/m;

/** Length units the program writes in, by the `outputUnit` option; millimetres when the request names none. */
const OUTPUT_UNITS: ReadonlySet<string> = new Set(['mm', 'cm', 'm', 'in']);
const DEFAULT_OUTPUT_UNIT = 'mm';

export type OcctConverterOptions = Pick<ConversionOptions, 'signal' | 'timeoutMs' | 'outputUnit'> &
  JobDeadlined & {
    /** The name an OBJ and its material file are written under (the OBJ names the material file in its `mtllib` line); the file name of the request. */
    outputName?: string;
  };

/** What the program wrote: one model file, or for an OBJ with colours a ZIP of the OBJ and its MTL file. */
export interface OcctOutput {
  buffer: Buffer;
  mimeType: string;
  /** True when the buffer is the ZIP of an OBJ and its MTL file, which the caller names `.zip` instead of by the target. */
  archive: boolean;
}

/**
 * The most triangles of a mesh the program writes to IGES; the program applies the same limit (kMaxMeshTriangles in
 * native/cad-convert/cad-convert.cpp). Every triangle is a trimmed surface of 1.8 KB of text, and this is the most whose file
 * the program reads back within the memory limit below (1.62 GB of 2 GiB; 99,458 triangles take 3.19 GB).
 */
export const OCCT_MESH_MAX_TRIANGLES = 50_000;

/** An indexed triangle mesh in millimetres, as the worker's STL and OBJ readers produce it. */
export interface IndexedMesh {
  vertices: ReadonlyArray<readonly [number, number, number]>;
  faces: ReadonlyArray<readonly [number, number, number]>;
}

/** Whether the program reads a file of this extension. */
export function isOcctSource(format: string): boolean {
  return Object.hasOwn(READABLE_SOURCES, format);
}

function programBinary(): string {
  const binary = resolveBinaryPath(PROGRAM_PATH_VARIABLE, PROGRAM_CANDIDATES, PROGRAM_NAME);
  if (binary === null) {
    throw new EngineUnavailableError(PROGRAM_NAME, 'cad-convert (Open CASCADE) is not installed or not in PATH');
  }
  return binary;
}

/** The error line the program printed, with the scratch directory and every unprintable character removed. */
function diagnostic(stderr: string, sandboxDir: string): string {
  const line = ERROR_LINE.exec(stderr.replaceAll(sandboxDir, '<tmp>'))?.[1];
  if (line === undefined) return '';
  return ` (${line.replace(UNPRINTABLE, '?').slice(0, MAX_DETAIL_CHARS)})`;
}

function toProgramError(error: unknown, sandboxDir: string, timeoutMs: number): unknown {
  rethrowSandboxUnavailable(error);
  if (error instanceof SandboxedTimeoutError) return new CpuTaskTimeoutError('CAD converter', timeoutMs);
  // The sandbox reports a signal SIGSEGV or SIGKILL of a memory-limited process as a memory error: running out of the limit
  // and crashing on a damaged file look the same to it, and the message says both.
  if (error instanceof SandboxedMemoryLimitError) return new UnprocessableCadInputError('The CAD converter ran out of memory or crashed on this model.');
  if (error instanceof SandboxedBufferLimitError) {
    // The sandbox reports a file that grew past its size limit (SIGXFSZ) with the same error as too much diagnostic output; the limit tells them apart.
    if (error.limitBytes === PROGRAM_MAX_OUTPUT_BYTES) return new UnprocessableCadInputError(OUTPUT_TOO_LARGE);
    return new UnprocessableCadInputError('The CAD converter printed more diagnostics than the limit allows: the file is damaged.');
  }
  if (error instanceof SandboxedProcessError) {
    if (error.exitCode === SHELL_NOT_FOUND || error.exitCode === SHELL_NOT_EXECUTABLE) {
      return new EngineUnavailableError(PROGRAM_NAME, 'cad-convert (Open CASCADE) could not be started');
    }
    if (MEMORY_ERROR_LINE.test(error.stderr)) {
      return new UnprocessableCadInputError(`The CAD converter ran out of memory: the model needs more than the ${PROGRAM_MEMORY_LIMIT_MB} MB it may use.`);
    }
    const how = error.signal ? `was stopped by ${error.signal}` : `exited with status ${error.exitCode}`;
    return new UnprocessableCadInputError(`The CAD converter could not convert this model: it ${how}${diagnostic(error.stderr, sandboxDir)}.`);
  }
  return error;
}

/** The mesh in the program's input form: vertex and triangle counts, the vertices as float64, the triangles as uint32 indices. */
function meshFile(mesh: IndexedMesh): Buffer {
  const file = Buffer.alloc(MESH_HEADER_BYTES + mesh.vertices.length * 3 * 8 + mesh.faces.length * 3 * 4);
  file.writeUInt32LE(mesh.vertices.length, 0);
  file.writeUInt32LE(mesh.faces.length, 4);
  let at = MESH_HEADER_BYTES;
  for (const vertex of mesh.vertices) for (const value of vertex) at = file.writeDoubleLE(value, at);
  for (const face of mesh.faces) for (const index of face) at = file.writeUInt32LE(index, at);
  return file;
}

/** The name the files of an OBJ are written under: the request's file name with everything a material file name should not hold replaced. */
function outputStem(name: string | undefined): string {
  const safe = (name ?? DEFAULT_OUTPUT_STEM).replace(UNSAFE_NAME_CHARS, '_').replace(/^\.+/, '_').slice(0, MAX_OUTPUT_NAME_CHARS);
  return safe === '' ? DEFAULT_OUTPUT_STEM : safe;
}

interface KernelJob {
  from: 'step' | 'iges' | 'mesh';
  to: 'step' | 'iges' | 'stl' | 'obj';
  /** The file the program reads, and the extensions the files are written under (the ones the request names). */
  input: Buffer;
  inputExtension: string;
  outputExtension: string;
  unit: string;
  options: OcctConverterOptions;
}

/** Runs the program in its sandbox and returns the model file it wrote and, for an OBJ with colours, the MTL file beside it. */
async function runKernel(job: KernelJob): Promise<{ model: Buffer; materials: Buffer | null; stem: string }> {
  const binary = programBinary();
  const timeoutMs = stageTimeoutMs(job.options, PROGRAM_DEFAULT_TIMEOUT_MS);
  const stem = job.to === 'obj' ? outputStem(job.options.outputName) : DEFAULT_OUTPUT_STEM;
  const sandboxDir = createWorkerSandboxDir();
  try {
    const inputPath = path.join(sandboxDir, `input.${job.inputExtension}`);
    const outputPath = path.join(sandboxDir, `${stem}.${job.outputExtension}`);
    const materialsPath = path.join(sandboxDir, `${stem}.mtl`);
    fs.writeFileSync(inputPath, job.input, { mode: 0o600 });
    try {
      await executeSandboxedBinary(binary, ['--from', job.from, '--to', job.to, '--unit', job.unit, inputPath, outputPath], {
        cwd: sandboxDir,
        timeoutMs,
        maxBuffer: PROGRAM_MAX_DIAGNOSTIC_BYTES,
        maxFileSize: PROGRAM_MAX_OUTPUT_BYTES,
        memoryLimitMb: PROGRAM_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: job.options.signal,
      });
    } catch (error) {
      throw toProgramError(error, sandboxDir, timeoutMs);
    }
    if (!fs.existsSync(outputPath)) {
      throw new UnprocessableCadInputError('The CAD converter wrote no model from this file.');
    }
    const size = fs.statSync(outputPath).size;
    if (size === 0) throw new UnprocessableCadInputError('The CAD converter wrote an empty file.');
    if (size >= PROGRAM_MAX_OUTPUT_BYTES) throw new UnprocessableCadInputError(OUTPUT_TOO_LARGE);
    const materials = job.to === 'obj' && fs.existsSync(materialsPath) ? fs.readFileSync(materialsPath) : null;
    return { model: fs.readFileSync(outputPath), materials, stem };
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}

function validOutputUnit(options: OcctConverterOptions): string {
  const unit = options.outputUnit ?? DEFAULT_OUTPUT_UNIT;
  if (!OUTPUT_UNITS.has(unit)) {
    throw new UnprocessableCadInputError(`The output unit '${unit}' is not one of mm, cm, m and in.`);
  }
  return unit;
}

/**
 * Converts a STEP or IGES file to STEP, IGES, binary STL or OBJ. An OBJ of a model that has colours comes as a ZIP of the OBJ and
 * the MTL file that holds them, as the kernel's OBJ writer writes the two files; one without colours is the OBJ alone. Fails with
 * a typed 422 for a file the kernel cannot read, an IGES file whose Terminate line disagrees with its records (checked before
 * the program runs, see cad-iges-preflight.ts), a model with nothing to write and a program that crashes or runs out of memory,
 * a typed timeout when it overruns its time, and an engine-unavailable error (503, retried on another worker) when the program is
 * missing. Never returns an estimate: a failed conversion is an error.
 */
export async function convertCadWithOcct(input: Buffer, sourceFormat: string, targetFormat: string, options: OcctConverterOptions = {}): Promise<OcctOutput> {
  const from = READABLE_SOURCES[sourceFormat];
  const to = WRITABLE_TARGETS[targetFormat];
  if (from === undefined || to === undefined) {
    throw new UnprocessableCadInputError(`The CAD converter does not convert .${sourceFormat} to .${targetFormat}.`);
  }
  const unit = validOutputUnit(options);
  const kernelInput = from === 'iges' ? prepareIgesForKernel(input) : input;
  const { model, materials, stem } = await runKernel({ from, to, input: kernelInput, inputExtension: sourceFormat, outputExtension: targetFormat, unit, options });
  if (materials === null) return { buffer: model, mimeType: OCCT_CONVERTER_MIME[to], archive: false };
  const buffer = await createDeflatedZipBuffer([
    { name: `${stem}.obj`, data: model },
    { name: `${stem}.mtl`, data: materials },
  ]);
  return { buffer, mimeType: ZIP_MIME, archive: true };
}

/**
 * Writes a mesh (an STL or OBJ source) as IGES through the kernel. The mesh is in millimetres, the unit of the IGES file. A mesh
 * with more triangles than OCCT_MESH_MAX_TRIANGLES is refused before the program starts, with its size and the limit named.
 */
export async function convertMeshToIgesWithOcct(mesh: IndexedMesh, options: OcctConverterOptions = {}): Promise<OcctOutput> {
  if (mesh.faces.length > OCCT_MESH_MAX_TRIANGLES) {
    throw new UnprocessableCadInputError(
      `The mesh has ${mesh.faces.length.toLocaleString('en-US')} triangles; the IGES file takes at most ${OCCT_MESH_MAX_TRIANGLES.toLocaleString('en-US')}, because every triangle is a trimmed surface of its own.`
    );
  }
  const { model } = await runKernel({ from: 'mesh', to: 'iges', input: meshFile(mesh), inputExtension: 'mesh', outputExtension: 'iges', unit: DEFAULT_OUTPUT_UNIT, options });
  return { buffer: model, mimeType: OCCT_CONVERTER_MIME.iges, archive: false };
}
