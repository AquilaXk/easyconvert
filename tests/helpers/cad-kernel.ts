import { getOracleToolPath } from './differential-oracle';
import { pythonModuleProblem } from './python-oracle';
import { skipUnless } from './strict-skip';

/**
 * The Open CASCADE program (`cad-convert`, native/cad-convert) that reads STEP and IGES, and trimesh, the independent mesh reader
 * that judges what it writes. A run that is not strict skips the suites that need them when they are absent; under
 * ORACLE_STRICT_MODE=1 the same absence fails the suite by name, so CI cannot pass without having converted a STEP or IGES file. The
 * two are checked apart, so a failure names the one that is missing, and the one that is there but does not import says why.
 * Importing this module points the worker at the program that was found, as CAD_CONVERT_PATH does in a deployment.
 */

const converter = getOracleToolPath('cad-convert');
if (converter !== null) process.env.CAD_CONVERT_PATH ??= converter;

/** True when the program is available (or skipping is not allowed, which throws instead). */
export const haveCadConverter = !skipUnless('cad-convert (native/cad-convert; searched on PATH and in /usr/local/bin)', converter !== null);

const trimeshProblem = pythonModuleProblem('trimesh');

/** True when trimesh imports under the oracles' interpreter (or skipping is not allowed, which throws instead). */
export const haveTrimesh = !skipUnless(`python3 with trimesh${trimeshProblem === null ? '' : ` (${trimeshProblem})`}`, trimeshProblem === null);

/** True when the program and trimesh are both available. */
export const haveCadOracles = haveCadConverter && haveTrimesh;
