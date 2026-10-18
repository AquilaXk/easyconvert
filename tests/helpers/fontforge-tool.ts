import { getOracleToolPath } from './differential-oracle';
import { pythonModuleProblem } from './python-oracle';
import { skipUnless } from './strict-skip';

/**
 * FontForge (`fontforge`, the fontforge-nox package), which the worker runs as a separate program to read PostScript Type 1 fonts,
 * and fontTools, the independent font library that judges what it wrote. A run that is not strict skips the suites that need them
 * when they are absent; under ORACLE_STRICT_MODE=1 the same absence fails the suite by name, so CI cannot pass without having
 * converted a Type 1 font. Importing this module points the worker at the program that was found, as FONTFORGE_PATH does in a deployment.
 */

const program = getOracleToolPath('fontforge');
if (program !== null) process.env.FONTFORGE_PATH ??= program;

/** True when FontForge is available (or skipping is not allowed, which throws instead). */
export const haveFontForge = !skipUnless('fontforge (fontforge-nox; searched on PATH and in /usr/local/bin)', program !== null);

const fontToolsProblem = pythonModuleProblem('fontTools');

/** True when fontTools imports under the oracles' interpreter (or skipping is not allowed, which throws instead). */
export const haveFontTools = !skipUnless(`python3 with fontTools${fontToolsProblem === null ? '' : ` (${fontToolsProblem})`}`, fontToolsProblem === null);

/** True when FontForge and fontTools are both available. */
export const haveType1Oracles = haveFontForge && haveFontTools;
