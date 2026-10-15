/**
 * Minimal Dockerfile reader for tests that assert on the structure of an image definition instead of searching
 * its text (a phrase in a comment would satisfy a text search). It follows the reference grammar for what the
 * tests need: comment lines are dropped, a trailing backslash continues an instruction, `FROM image AS name`
 * opens a stage, and the exec form of an instruction is a JSON array.
 */

export interface DockerInstruction {
  /** Upper-cased instruction keyword (FROM, RUN, USER, ENTRYPOINT, ...). */
  keyword: string;
  /** Everything after the keyword, continuation lines joined by single spaces. */
  argument: string;
  /** Zero-based position among all instructions, so ordering inside a stage can be asserted. */
  index: number;
}

export interface DockerStage {
  /** The `AS` name, lower-cased; empty for an unnamed stage. */
  name: string;
  baseImage: string;
  instructions: DockerInstruction[];
}

export function parseDockerfile(text: string): DockerStage[] {
  const logicalLines: string[] = [];
  let pending = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    if (line === '' && pending === '') continue;
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    logicalLines.push(`${pending}${line}`.trim());
    pending = '';
  }
  if (pending.trim() !== '') logicalLines.push(pending.trim());

  const stages: DockerStage[] = [];
  logicalLines.forEach((logical, index) => {
    const split = logical.search(/\s/);
    const keyword = (split === -1 ? logical : logical.slice(0, split)).toUpperCase();
    const argument = split === -1 ? '' : logical.slice(split).trim();
    if (keyword === 'FROM') {
      const parts = argument.split(/\s+/).filter((part) => !part.startsWith('--'));
      const asIndex = parts.findIndex((part) => part.toUpperCase() === 'AS');
      stages.push({
        name: asIndex === -1 ? '' : (parts[asIndex + 1] ?? '').toLowerCase(),
        baseImage: parts[0] ?? '',
        instructions: [{ keyword, argument, index }],
      });
      return;
    }
    stages[stages.length - 1]?.instructions.push({ keyword, argument, index });
  });
  return stages;
}

/** The exec-form (JSON array) arguments of an instruction such as ENTRYPOINT ["/usr/bin/tini", "-g", "--"]. */
export function execForm(instruction: DockerInstruction): string[] {
  const parsed: unknown = JSON.parse(instruction.argument);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${instruction.keyword} is not in exec form: ${instruction.argument}`);
  }
  return parsed;
}
