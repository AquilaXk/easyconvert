import { getOracleToolPath } from './differential-oracle';
import { pythonModuleAvailable } from './python-oracle';
import { skipUnless } from './strict-skip';

/**
 * The Open CASCADE program (`cad-convert`, native/cad-convert) that reads STEP and IGES, and trimesh, the independent mesh reader
 * that judges what it writes. A run that is not strict skips the suites that need them when they are absent; under
 * ORACLE_STRICT_MODE=1 the same absence fails the suite by name, so CI cannot pass without having converted a STEP or IGES file.
 * Importing this module points the worker at the program that was found, as CAD_CONVERT_PATH does in a deployment.
 */

const converter = getOracleToolPath('cad-convert');
if (converter !== null) process.env.CAD_CONVERT_PATH ??= converter;

/** True when the program is available (or skipping is not allowed, which throws instead). */
export const haveCadConverter = !skipUnless('cad-convert (native/cad-convert)', converter !== null);

/** True when the program and trimesh are available. */
export const haveCadOracles = !skipUnless('cad-convert (native/cad-convert) and python3 with trimesh', converter !== null && pythonModuleAvailable('trimesh'));
