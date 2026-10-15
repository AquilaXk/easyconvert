"""Float32 to IEEE 754 binary16 oracle for the EXR writer tests.

Reads little-endian float32 values from the file named by argv[1] and writes the little-endian uint16 bit
patterns numpy's astype(float16) produces for them (round to nearest, ties to even, subnormals, overflow to
infinity) to stdout. numpy does the conversion; nothing here comes from the code under test.
"""
import sys

import numpy as np

values = np.fromfile(sys.argv[1], dtype="<f4")
sys.stdout.buffer.write(values.astype("<f2").view("<u2").astype("<u2").tobytes())
