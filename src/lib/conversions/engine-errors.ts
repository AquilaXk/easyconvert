import type { ConversionRefusalCode } from '../refusal-codes';
import { ConversionFailedError } from '../types';

/**
 * A request named an engine that does not convert this pair (or no engine of that id): the pair's engines are listed in
 * `engines`. The request is understood and cannot be served as asked, so the routes answer 422 and the answer carries the list.
 */
export class EngineNotOfferedError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'engine_not_offered';
  readonly status = 422;
  /** The ids of the engines that convert the pair, the default first. */
  readonly engines: readonly string[];
  constructor(message: string, engines: readonly string[]) {
    super(message);
    this.name = 'EngineNotOfferedError';
    this.engines = engines;
  }
  get problemExtensions(): Record<string, unknown> {
    return { engines: this.engines };
  }
}

/** A request named a version of an engine other than the one installed (one version of each engine is pinned in the image). */
export class EngineVersionNotOfferedError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'engine_version_unavailable';
  readonly status = 422;
  readonly engine: string;
  /** The version installed, absent when the program does not report one. */
  readonly installedVersion: string | undefined;
  constructor(message: string, engine: string, installedVersion: string | undefined) {
    super(message);
    this.name = 'EngineVersionNotOfferedError';
    this.engine = engine;
    this.installedVersion = installedVersion;
  }
  get problemExtensions(): Record<string, unknown> {
    return { engine: this.engine, ...(this.installedVersion === undefined ? {} : { installedVersion: this.installedVersion }) };
  }
}
