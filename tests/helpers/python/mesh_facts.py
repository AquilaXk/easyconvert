"""Facts of a mesh file (STL or OBJ) read by trimesh, an independent mesh library: triangle count, surface area, bounding box."""
import json
import sys

import trimesh

path = sys.argv[1]
mesh = trimesh.load(path, force="mesh")
unmerged = trimesh.load(path, force="mesh", process=False)
print(
    json.dumps(
        {
            "triangles": int(len(mesh.faces)),
            "area": float(mesh.area),
            "min": [float(v) for v in mesh.bounds[0]],
            "max": [float(v) for v in mesh.bounds[1]],
            "watertight": bool(mesh.is_watertight),
            "unmergedVertices": int(len(unmerged.vertices)),
        }
    )
)
