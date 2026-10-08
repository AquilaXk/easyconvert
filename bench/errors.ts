/** Typed failures of the quality benchmark harness; the runner maps each to a message and a non-zero exit. */

export class BenchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A reference tool a row needs is not installed, and ORACLE_STRICT_MODE=1 forbids skipping the row. */
export class MissingToolError extends BenchError {
  readonly tools: readonly string[];
  constructor(tools: readonly string[], context: string) {
    super(`ORACLE_STRICT_MODE=1 requires ${tools.join(', ')} for ${context}, which ${tools.length === 1 ? 'is' : 'are'} not installed`);
    this.tools = tools;
  }
}

/** A reference tool exited non-zero, timed out or printed output the harness cannot read. */
export class ToolRunError extends BenchError {}

/** The inputs of a Bjontegaard computation are not four or more finite, distinct rate-quality points. */
export class BdRateInputError extends BenchError {}

/** A report or baseline file does not match its schema. */
export class ReportSchemaError extends BenchError {}

/** A command-line argument is unknown, malformed or out of range. */
export class BenchArgumentError extends BenchError {}

/** A conversion produced output the independent decoders reject, or output that is not the lossless round trip. */
export class OutputIntegrityError extends BenchError {}
