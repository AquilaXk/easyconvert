// cad-convert: reads a STEP or IGES file with the Open CASCADE data exchange libraries and writes STEP, IGES, binary STL or OBJ.
//
//   cad-convert --from step|iges|mesh --to step|iges|stl|obj [--unit mm|cm|m|in] <input> <output>
//
// STEP and IGES are written from the B-rep, not from a mesh, with the colours and names that the document model (XDE)
// carries. STL and OBJ are meshed from the B-rep; the OBJ carries the XDE colours as materials in an MTL file next to it (the OBJ names
// the file in an `mtllib` line) that the kernel's OBJ material map writes, and has none when the model holds no colour. `--from mesh` reads the indexed triangle list that the worker writes for an STL or
// OBJ source (see readMesh) and builds a B-rep of planar faces from it, which the kernel's writers then write. Every output is in millimetres: the readers convert the file's length
// unit to millimetres, the STEP and IGES writers are told to write millimetres, and STL and OBJ (which have no unit that
// slicers and viewers read) hold millimetre coordinates. --unit asks for another length unit (centimetre, metre, inch) in
// every output: STEP and IGES are written in it and declare it, STL and OBJ coordinates are scaled to it.
//
// Standard output stays empty. Standard error holds `cad-convert: note: ...` lines, and on failure one
// `cad-convert: error: <code>: <message>` line. The exit status names the kind of failure:
//   0 written   2 usage   3 unreadable input   4 nothing to write (no shapes, no surfaces)   5 transfer, mesh or write failed,
//   or out of memory (the code of the error line is `memory`)
//
// The program links dynamically to the unmodified Open CASCADE libraries (LGPL-2.1 with the exception) and runs as a
// separate process; it builds against Open CASCADE 7.6 to 7.9.

#include <BRepBndLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <Bnd_Box.hxx>
#include <IGESCAFControl_Reader.hxx>
#include <IGESCAFControl_Writer.hxx>
#include <IGESControl_Controller.hxx>
#include <IGESControl_Writer.hxx>
#include <IGESData_GlobalSection.hxx>
#include <IGESData_IGESModel.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_PrinterOStream.hxx>
#include <Poly_Triangulation.hxx>
#include <Precision.hxx>
#include <RWMesh_FaceIterator.hxx>
#include <RWObj_ObjMaterialMap.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <STEPControl_Controller.hxx>
#include <STEPControl_StepModelType.hxx>
#include <Standard_Failure.hxx>
#include <Standard_OutOfMemory.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_HAsciiString.hxx>
#include <TColStd_SequenceOfAsciiString.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDocStd_Document.hxx>
#include <TopAbs_Orientation.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Vertex.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFPrs_DocumentExplorer.hxx>
#include <XCAFPrs_DocumentNode.hxx>
#include <XCAFPrs_Style.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <new>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

constexpr int kExitUsage = 2;
constexpr int kExitUnreadable = 3;
constexpr int kExitNothing = 4;
constexpr int kExitFailed = 5;

// Mesh quality: the chord deviation of a surface from its triangles may be 0.1 percent of the model's largest extent, and
// neighbouring triangles of a curved surface may turn by 0.5 radian (about 29 degrees) at most. In millimetres.
constexpr double kLinearDeflectionOfExtent = 0.001;
constexpr double kAngularDeflectionRadians = 0.5;

// The kernel works in millimetres: the readers convert to them (xstep.cascade.unit), and the output unit is applied on the way out.
constexpr const char* kKernelUnit = "MM";

// A length unit the output can be written in: its name on the command line, its name in the kernel's writer parameters, how many
// of it make one millimetre, and how the headers of STL and OBJ say it.
struct OutputUnit {
  const char* name;
  const char* writerName;
  double perMillimetre;
  const char* label;
};

constexpr OutputUnit kOutputUnits[] = {
    {"mm", "MM", 1.0, "millimetres"},
    {"cm", "CM", 0.1, "centimetres"},
    {"m", "M", 0.001, "metres"},
    {"in", "INCH", 1.0 / 25.4, "inches"},
};

struct Failure {
  int status;
  std::string code;
  std::string message;
};

[[noreturn]] void fail(int status, const char* code, const std::string& message) {
  throw Failure{status, code, message};
}

// Running out of memory is told apart from every other failure: the model is too big for the limit the program runs under, which is
// not a fault of the file or of the program.
[[noreturn]] void failOutOfMemory() { fail(kExitFailed, "memory", "the model needs more memory than the program may use"); }

void note(const std::string& text) { std::cerr << "cad-convert: note: " << text << "\n"; }

enum class Format { Step, Iges, Stl, Obj, Mesh };

bool parseFormat(const std::string& name, Format& out) {
  if (name == "step") out = Format::Step;
  else if (name == "iges") out = Format::Iges;
  else if (name == "stl") out = Format::Stl;
  else if (name == "obj") out = Format::Obj;
  else if (name == "mesh") out = Format::Mesh;
  else return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading

void setStaticString(const char* name, const char* value) {
  if (!Interface_Static::SetCVal(name, value)) fail(kExitFailed, "unit", std::string("the parameter ") + name + " cannot be set to " + value);
}

void describeStepUnit(STEPCAFControl_Reader& reader) {
  TColStd_SequenceOfAsciiString lengths, angles, solidAngles;
  reader.ChangeReader().FileUnits(lengths, angles, solidAngles);
  if (lengths.Length() > 0) note(std::string("the file's length unit is ") + lengths.First().ToCString() + "; geometry is converted to millimetres");
  else note("the file declares no length unit; its numbers are read as millimetres");
}

void describeIgesUnit(IGESCAFControl_Reader& reader) {
  Handle(IGESData_IGESModel) model = Handle(IGESData_IGESModel)::DownCast(reader.Model());
  if (model.IsNull()) return;
  const IGESData_GlobalSection& section = model->GlobalSection();
  const Handle(TCollection_HAsciiString) name = section.UnitName();
  const std::string unitName = name.IsNull() ? "" : name->ToCString();
  note(std::string("the file's length unit is flag ") + std::to_string(section.UnitFlag()) + (unitName.empty() ? "" : " (" + unitName + ")") +
       "; geometry is converted to millimetres");
}

void readStep(const std::string& path, Handle(TDocStd_Document)& doc) {
  STEPControl_Controller::Init();
  STEPCAFControl_Reader reader;
  reader.SetColorMode(Standard_True);
  reader.SetNameMode(Standard_True);
  setStaticString("xstep.cascade.unit", kKernelUnit);
  if (reader.ReadFile(path.c_str()) != IFSelect_RetDone) fail(kExitUnreadable, "unreadable", "the file is not a STEP file Open CASCADE can read");
  describeStepUnit(reader);
  if (!reader.Transfer(doc)) fail(kExitNothing, "no-shapes", "the STEP file holds no shape that could be transferred");
}

void readIges(const std::string& path, Handle(TDocStd_Document)& doc) {
  IGESControl_Controller::Init();
  IGESCAFControl_Reader reader;
  reader.SetColorMode(Standard_True);
  reader.SetNameMode(Standard_True);
  setStaticString("xstep.cascade.unit", kKernelUnit);
  if (reader.ReadFile(path.c_str()) != IFSelect_RetDone) fail(kExitUnreadable, "unreadable", "the file is not an IGES file Open CASCADE can read");
  describeIgesUnit(reader);
  if (!reader.Transfer(doc)) fail(kExitNothing, "no-shapes", "the IGES file holds no shape that could be transferred");
}

// ---------------------------------------------------------------------------------------------------------------------
// Mesh input
//
// The worker parses an STL or OBJ source itself and hands the program the result as an indexed triangle list: a little-endian
// uint32 vertex count V, a uint32 triangle count T, V vertices of three float64 and T triangles of three uint32 vertex indices.
// The program checks the sizes against the file before it reads anything.

// The most triangles of a mesh the program writes to IGES: the most whose file the kernel's reader reads back inside the worker's
// 2 GiB of memory. Writing takes 4.3 s and 367 MB for 49,928 triangles (89 MB of IGES text, 1.8 KB a triangle) and reading the file
// back 10.3 s and 1.62 GB; for 99,458 triangles writing takes 8.7 s and 702 MB but reading takes 3.19 GB (Ubuntu 24.04 arm64, Open
// CASCADE 7.6.3). The worker applies the same number before it starts the program (cad-occt.ts, OCCT_MESH_MAX_TRIANGLES).
constexpr std::uint32_t kMaxMeshTriangles = 50000;

int countFaces(const TopoDS_Shape& shape);

struct MeshData {
  std::vector<double> vertices;
  std::vector<std::uint32_t> triangles;
};

MeshData readMesh(const std::string& path) {
  std::ifstream in(path, std::ios::binary | std::ios::ate);
  if (!in) fail(kExitUnreadable, "unreadable", "the mesh file cannot be opened");
  const std::uint64_t size = static_cast<std::uint64_t>(in.tellg());
  in.seekg(0);
  std::uint32_t counts[2];
  if (size < sizeof counts || !in.read(reinterpret_cast<char*>(counts), sizeof counts)) fail(kExitUnreadable, "unreadable", "the mesh file is shorter than its header");
  const std::uint64_t vertexCount = counts[0], triangleCount = counts[1];
  if (triangleCount > kMaxMeshTriangles) fail(kExitFailed, "too-large", "the mesh has " + std::to_string(triangleCount) + " triangles; the most that is written is " + std::to_string(kMaxMeshTriangles));
  if (size != sizeof counts + vertexCount * 3 * sizeof(double) + triangleCount * 3 * sizeof(std::uint32_t)) fail(kExitUnreadable, "unreadable", "the mesh file is not the size its header gives");
  MeshData mesh;
  mesh.vertices.resize(vertexCount * 3);
  mesh.triangles.resize(triangleCount * 3);
  in.read(reinterpret_cast<char*>(mesh.vertices.data()), static_cast<std::streamsize>(mesh.vertices.size() * sizeof(double)));
  in.read(reinterpret_cast<char*>(mesh.triangles.data()), static_cast<std::streamsize>(mesh.triangles.size() * sizeof(std::uint32_t)));
  if (!in) fail(kExitUnreadable, "unreadable", "the mesh file could not be read");
  for (const double value : mesh.vertices) {
    if (!std::isfinite(value)) fail(kExitUnreadable, "unreadable", "the mesh holds a vertex that is not a finite number");
  }
  for (const std::uint32_t index : mesh.triangles) {
    if (index >= vertexCount) fail(kExitUnreadable, "unreadable", "the mesh holds a triangle that names a vertex it does not list");
  }
  return mesh;
}

std::uint64_t edgeKey(std::uint32_t a, std::uint32_t b) { return (static_cast<std::uint64_t>(std::min(a, b)) << 32) | std::max(a, b); }

// Whether the third corner lies on the line through the first two, within the kernel's linear tolerance.
bool isOnALine(const gp_Pnt& a, const gp_Pnt& b, const gp_Pnt& c) {
  const gp_Vec ab(a, b), ac(a, c);
  return ab.Crossed(ac).Magnitude() <= Precision::Confusion() * ab.Magnitude();
}

// A compound of one planar face per triangle, built as FreeCAD's TopoShape::setFaces builds it (src/Mod/Part/App/TopoShape.cpp:3341):
// one vertex per mesh vertex, one edge per pair of neighbouring triangles (the second triangle takes it reversed), a wire of three
// edges and a face of the wire. A triangle with two coincident corners is left out as FreeCAD leaves it out (same file, lines 3419-3421); so
// is a triangle whose corners lie on a line, which the kernel would turn into a face of no area (our addition). FreeCAD sews the faces into a shell afterwards when asked to (sewShape, same file, line 3050); the IGES writer writes each face
// as a trimmed surface whether or not they are sewn, so the sewing, which dominates the run time of a large mesh, is not done.
TopoDS_Compound meshToFaces(const MeshData& mesh, int& skipped) {
  const std::size_t vertexCount = mesh.vertices.size() / 3;
  std::vector<TopoDS_Vertex> vertices(vertexCount);
  std::vector<bool> used(vertexCount, false);
  for (const std::uint32_t index : mesh.triangles) used[index] = true;
  for (std::size_t i = 0; i < vertexCount; ++i) {
    if (used[i]) vertices[i] = BRepBuilderAPI_MakeVertex(gp_Pnt(mesh.vertices[3 * i], mesh.vertices[3 * i + 1], mesh.vertices[3 * i + 2]));
  }
  std::unordered_map<std::uint64_t, TopoDS_Edge> edges;
  edges.reserve(mesh.triangles.size());
  const auto edgeBetween = [&](std::uint32_t from, std::uint32_t to) {
    const auto found = edges.find(edgeKey(from, to));
    TopoDS_Edge edge;
    if (found != edges.end()) {
      edge = found->second;
    } else {
      const std::uint32_t low = std::min(from, to), high = std::max(from, to);
      BRepBuilderAPI_MakeEdge maker(vertices[low], vertices[high]);
      if (maker.IsDone()) edge = maker.Edge();
      edges.emplace(edgeKey(from, to), edge);
    }
    if (!edge.IsNull() && from > to) edge.Reverse();
    return edge;
  };
  BRep_Builder builder;
  TopoDS_Compound compound;
  builder.MakeCompound(compound);
  skipped = 0;
  for (std::size_t t = 0; t < mesh.triangles.size(); t += 3) {
    const std::uint32_t a = mesh.triangles[t], b = mesh.triangles[t + 1], c = mesh.triangles[t + 2];
    const gp_Pnt pa(mesh.vertices[3 * a], mesh.vertices[3 * a + 1], mesh.vertices[3 * a + 2]);
    const gp_Pnt pb(mesh.vertices[3 * b], mesh.vertices[3 * b + 1], mesh.vertices[3 * b + 2]);
    const gp_Pnt pc(mesh.vertices[3 * c], mesh.vertices[3 * c + 1], mesh.vertices[3 * c + 2]);
    if (pa.IsEqual(pb, Precision::Approximation()) || pa.IsEqual(pc, Precision::Approximation()) || isOnALine(pa, pb, pc)) {
      ++skipped;
      continue;
    }
    const TopoDS_Edge ab = edgeBetween(a, b), bc = edgeBetween(b, c), ca = edgeBetween(c, a);
    if (ab.IsNull() || bc.IsNull() || ca.IsNull()) {
      ++skipped;
      continue;
    }
    BRepBuilderAPI_MakeWire wire(ab, bc, ca);
    if (!wire.IsDone()) {
      ++skipped;
      continue;
    }
    BRepBuilderAPI_MakeFace face(wire.Wire());
    if (!face.IsDone()) {
      ++skipped;
      continue;
    }
    builder.Add(compound, face.Face());
  }
  return compound;
}

void readMeshDocument(const std::string& path, Handle(TDocStd_Document)& doc) {
  const MeshData mesh = readMesh(path);
  int skipped = 0;
  const TopoDS_Compound faces = meshToFaces(mesh, skipped);
  if (skipped > 0) note(std::to_string(skipped) + " triangle(s) with coincident or collinear corners are no face and are left out");
  if (countFaces(faces) == 0) fail(kExitNothing, "no-shapes", "the mesh holds no triangle that is a face");
  const Handle(XCAFDoc_ShapeTool) tool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  tool->AddShape(faces, Standard_False);
}

// The shapes nothing else in the document refers to, as one compound with their placements applied.
TopoDS_Compound freeShapes(const Handle(TDocStd_Document)& doc, int& count) {
  const Handle(XCAFDoc_ShapeTool) tool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  TDF_LabelSequence labels;
  tool->GetFreeShapes(labels);
  BRep_Builder builder;
  TopoDS_Compound compound;
  builder.MakeCompound(compound);
  count = 0;
  for (Standard_Integer i = 1; i <= labels.Length(); ++i) {
    const TopoDS_Shape shape = tool->GetShape(labels.Value(i));
    if (shape.IsNull()) continue;
    builder.Add(compound, shape);
    ++count;
  }
  return compound;
}

int countFaces(const TopoDS_Shape& shape) {
  int faces = 0;
  for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) ++faces;
  return faces;
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing B-rep formats

void writeStep(const Handle(TDocStd_Document)& doc, const std::string& path, const OutputUnit& unit) {
  STEPControl_Controller::Init();
  setStaticString("write.step.unit", unit.writerName);
  STEPCAFControl_Writer writer;
  writer.SetColorMode(Standard_True);
  writer.SetNameMode(Standard_True);
  if (!writer.Transfer(doc, STEPControl_AsIs)) fail(kExitFailed, "transfer", "the shapes could not be transferred to a STEP model");
  if (writer.Write(path.c_str()) != IFSelect_RetDone) fail(kExitFailed, "write", "the STEP file could not be written");
}

// The faces of a model built from a mesh, written to IGES one face at a time. IGESControl_Writer::AddShape runs the shape-healing
// sequence over the whole shape it is given, and that run takes time quadratic in the number of faces (ShapeProcess_ShapeContext::
// RecordModification): 9,800 triangles as one compound took 18.7 s, and one by one 0.9 s with a file of the same size to 0.7 percent
// (17.5 MB and 17.4 MB). A mesh has no colours or names, so the document model (IGESCAFControl_Writer) adds nothing here.
void writeIgesFaces(const TopoDS_Shape& faces, const std::string& path, const OutputUnit& unit) {
  IGESControl_Controller::Init();
  setStaticString("write.iges.unit", unit.writerName);
  IGESControl_Writer writer(unit.writerName, 0);
  for (TopExp_Explorer explorer(faces, TopAbs_FACE); explorer.More(); explorer.Next()) {
    if (!writer.AddShape(explorer.Current())) fail(kExitFailed, "transfer", "a face could not be transferred to an IGES model");
  }
  writer.ComputeModel();
  if (!writer.Write(path.c_str())) fail(kExitFailed, "write", "the IGES file could not be written");
}

void writeIges(const Handle(TDocStd_Document)& doc, const std::string& path, const OutputUnit& unit) {
  IGESControl_Controller::Init();
  setStaticString("write.iges.unit", unit.writerName);
  IGESCAFControl_Writer writer;
  writer.SetColorMode(Standard_True);
  writer.SetNameMode(Standard_True);
  if (!writer.Transfer(doc)) fail(kExitFailed, "transfer", "the shapes could not be transferred to an IGES model");
  if (!writer.Write(path.c_str())) fail(kExitFailed, "write", "the IGES file could not be written");
}

// ---------------------------------------------------------------------------------------------------------------------
// Meshing and mesh formats

struct Triangle {
  float vertex[3][3];
};

double largestExtent(const TopoDS_Shape& shape) {
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  if (box.IsVoid()) return 0.0;
  Standard_Real xMin, yMin, zMin, xMax, yMax, zMax;
  box.Get(xMin, yMin, zMin, xMax, yMax, zMax);
  return std::fmax(xMax - xMin, std::fmax(yMax - yMin, zMax - zMin));
}

// Meshes every face of the shape in place: the triangulation is kept on the faces, which the STL reader below and the OBJ writer read.
void meshFaces(const TopoDS_Shape& shape) {
  const double extent = largestExtent(shape);
  if (!(extent > 0.0) || !std::isfinite(extent)) fail(kExitNothing, "no-surfaces", "the model has no extent to mesh");
  BRepMesh_IncrementalMesh mesher(shape, extent * kLinearDeflectionOfExtent, Standard_False, kAngularDeflectionRadians, Standard_False);
  (void)mesher;
}

std::vector<Triangle> meshTriangles(const TopoDS_Shape& shape, const OutputUnit& unit) {
  meshFaces(shape);
  std::vector<Triangle> triangles;
  for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
    const TopoDS_Face face = TopoDS::Face(explorer.Current());
    TopLoc_Location location;
    const Handle(Poly_Triangulation) mesh = BRep_Tool::Triangulation(face, location);
    if (mesh.IsNull()) continue;
    const gp_Trsf placement = location.Transformation();
    const bool reversed = face.Orientation() == TopAbs_REVERSED;
    for (Standard_Integer i = 1; i <= mesh->NbTriangles(); ++i) {
      Standard_Integer a, b, c;
      mesh->Triangle(i).Get(a, b, c);
      if (reversed) std::swap(b, c);
      const Standard_Integer corner[3] = {a, b, c};
      Triangle triangle;
      for (int k = 0; k < 3; ++k) {
        const gp_Pnt point = mesh->Node(corner[k]).Transformed(placement);
        triangle.vertex[k][0] = static_cast<float>(point.X() * unit.perMillimetre);
        triangle.vertex[k][1] = static_cast<float>(point.Y() * unit.perMillimetre);
        triangle.vertex[k][2] = static_cast<float>(point.Z() * unit.perMillimetre);
      }
      triangles.push_back(triangle);
    }
  }
  if (triangles.empty()) fail(kExitNothing, "no-surfaces", "the model has faces, but none could be meshed");
  return triangles;
}

void normalOf(const Triangle& t, float out[3]) {
  const float ux = t.vertex[1][0] - t.vertex[0][0], uy = t.vertex[1][1] - t.vertex[0][1], uz = t.vertex[1][2] - t.vertex[0][2];
  const float vx = t.vertex[2][0] - t.vertex[0][0], vy = t.vertex[2][1] - t.vertex[0][1], vz = t.vertex[2][2] - t.vertex[0][2];
  float nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const float length = std::sqrt(nx * nx + ny * ny + nz * nz);
  if (length > 0.0f) {
    nx /= length;
    ny /= length;
    nz /= length;
  }
  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
}

// Binary STL: an 80-byte header, the triangle count, then per triangle a normal, three vertices and a 16-bit attribute.
// The header names the unit, because the format has none.
void writeStl(const std::vector<Triangle>& triangles, const std::string& path, const OutputUnit& unit) {
  std::ofstream out(path, std::ios::binary);
  if (!out) fail(kExitFailed, "write", "the STL file cannot be opened for writing");
  char header[80] = {};
  std::snprintf(header, sizeof header, "binary STL, coordinates in %s", unit.label);
  out.write(header, sizeof header);
  const std::uint32_t count = static_cast<std::uint32_t>(triangles.size());
  out.write(reinterpret_cast<const char*>(&count), sizeof count);
  for (const Triangle& triangle : triangles) {
    float normal[3];
    normalOf(triangle, normal);
    const std::uint16_t attribute = 0;
    out.write(reinterpret_cast<const char*>(normal), sizeof normal);
    out.write(reinterpret_cast<const char*>(triangle.vertex), sizeof triangle.vertex);
    out.write(reinterpret_cast<const char*>(&attribute), sizeof attribute);
  }
  if (!out) fail(kExitFailed, "write", "the STL file could not be written");
}

struct VertexKey {
  float x, y, z;
  bool operator==(const VertexKey& other) const { return x == other.x && y == other.y && z == other.z; }
};

struct VertexKeyHash {
  std::size_t operator()(const VertexKey& key) const {
    std::uint32_t bits[3];
    std::memcpy(bits, &key, sizeof bits);
    std::size_t hash = bits[0];
    hash = hash * 1000003u ^ bits[1];
    hash = hash * 1000003u ^ bits[2];
    return hash;
  }
};

// One triangle of the OBJ: its corners as indices of the shared vertex list, and the material of its face (-1 for a face with no colour).
struct ObjTriangle {
  std::uint32_t corner[3];
  int material;
};

// The path of the material file beside an OBJ: the OBJ's name with its extension replaced (as the kernel's OBJ writer names it, RWObj_CafWriter.cxx:160).
std::string materialPathOf(const std::string& objPath) {
  const std::size_t dot = objPath.find_last_of('.');
  const std::size_t slash = objPath.find_last_of('/');
  const std::size_t stem = (dot == std::string::npos || (slash != std::string::npos && dot < slash)) ? objPath.size() : dot;
  return objPath.substr(0, stem) + ".mtl";
}

// Wavefront OBJ from the document model, with the colours of its faces as materials. The faces are visited as the kernel's own OBJ writer
// visits them (RWObj_CafWriter.cxx, Perform and writeShape): the leaf nodes of the document with their placements and styles, and for
// every face the style it ends up with (RWMesh_FaceIterator), a material named and defined in the MTL file by the kernel's material map
// (RWObj_ObjMaterialMap, as RWObj_CafWriter.cxx:301-310 does). The body is not the kernel's: its writer repeats the vertices of every
// face and writes normals and texture coordinates, which makes the vertices of neighbouring faces unequal for a reader (an OBJ of a closed
// solid no longer reads as closed); here vertices are shared, there are no normals, and the faces of one material come together after
// the faces with none, because OBJ has no way to end a material. A model with no colour has no MTL file and no `mtllib` line.
void writeObj(const Handle(TDocStd_Document)& doc, const std::string& path, const OutputUnit& unit) {
  const std::string materialPath = materialPathOf(path);
  const std::string materialName = materialPath.substr(materialPath.find_last_of('/') == std::string::npos ? 0 : materialPath.find_last_of('/') + 1);
  std::unique_ptr<RWObj_ObjMaterialMap> materials;
  std::vector<std::string> materialNames;
  std::unordered_map<std::string, int> materialIndex;
  std::unordered_map<VertexKey, std::uint32_t, VertexKeyHash> index;
  std::vector<VertexKey> vertices;
  std::vector<ObjTriangle> triangles;

  TDF_LabelSequence roots;
  XCAFDoc_DocumentTool::ShapeTool(doc->Main())->GetFreeShapes(roots);
  for (XCAFPrs_DocumentExplorer explorer(doc, roots, XCAFPrs_DocumentExplorerFlags_OnlyLeafNodes); explorer.More(); explorer.Next()) {
    const XCAFPrs_DocumentNode& node = explorer.Current();
    for (RWMesh_FaceIterator face(node.RefLabel, node.Location, true, node.Style); face.More(); face.Next()) {
      if (face.IsEmptyMesh()) continue;
      int material = -1;
      if (face.HasFaceColor()) {
        if (!materials) materials = std::make_unique<RWObj_ObjMaterialMap>(TCollection_AsciiString(materialPath.c_str()));
        const std::string name = materials->AddMaterial(face.FaceStyle()).ToCString();
        const auto found = materialIndex.emplace(name, static_cast<int>(materialNames.size()));
        if (found.second) materialNames.push_back(name);
        material = found.first->second;
      }
      for (Standard_Integer i = face.ElemLower(); i <= face.ElemUpper(); ++i) {
        const Poly_Triangle triangle = face.TriangleOriented(i);
        ObjTriangle entry{{0, 0, 0}, material};
        for (int k = 0; k < 3; ++k) {
          const gp_Pnt point = face.NodeTransformed(triangle(k + 1));
          const VertexKey key{static_cast<float>(point.X() * unit.perMillimetre), static_cast<float>(point.Y() * unit.perMillimetre),
                              static_cast<float>(point.Z() * unit.perMillimetre)};
          const auto added = index.emplace(key, static_cast<std::uint32_t>(vertices.size() + 1));
          if (added.second) vertices.push_back(key);
          entry.corner[k] = added.first->second;
        }
        triangles.push_back(entry);
      }
    }
  }
  materials.reset();  // closes the MTL file
  if (triangles.empty()) fail(kExitNothing, "no-surfaces", "the model has faces, but none could be meshed");
  std::stable_sort(triangles.begin(), triangles.end(), [](const ObjTriangle& a, const ObjTriangle& b) { return a.material < b.material; });

  std::ofstream out(path);
  if (!out) fail(kExitFailed, "write", "the OBJ file cannot be opened for writing");
  out << "# Wavefront OBJ, coordinates in " << unit.label << "\n";
  if (!materialNames.empty()) out << "mtllib " << materialName << "\n";
  char line[128];
  for (const VertexKey& v : vertices) {
    std::snprintf(line, sizeof line, "v %.9g %.9g %.9g\n", v.x, v.y, v.z);
    out << line;
  }
  int active = -1;
  for (const ObjTriangle& triangle : triangles) {
    if (triangle.material != active) {
      active = triangle.material;
      out << "usemtl " << materialNames[static_cast<std::size_t>(active)] << '\n';
    }
    out << "f " << triangle.corner[0] << ' ' << triangle.corner[1] << ' ' << triangle.corner[2] << '\n';
  }
  out.flush();
  if (!out) fail(kExitFailed, "write", "the OBJ file could not be written");
}

// ---------------------------------------------------------------------------------------------------------------------

struct Arguments {
  Format from = Format::Step;
  Format to = Format::Stl;
  const OutputUnit* unit = &kOutputUnits[0];
  std::string input;
  std::string output;
};

Arguments parseArguments(int argc, char** argv) {
  Arguments arguments;
  bool haveFrom = false, haveTo = false;
  std::vector<std::string> positional;
  for (int i = 1; i < argc; ++i) {
    const std::string argument = argv[i];
    if ((argument == "--from" || argument == "--to") && i + 1 < argc) {
      Format format;
      if (!parseFormat(argv[++i], format)) fail(kExitUsage, "usage", "unknown format " + std::string(argv[i]));
      if (argument == "--from") {
        arguments.from = format;
        haveFrom = true;
      } else {
        arguments.to = format;
        haveTo = true;
      }
    } else if (argument == "--unit" && i + 1 < argc) {
      const std::string name = argv[++i];
      const OutputUnit* found = nullptr;
      for (const OutputUnit& candidate : kOutputUnits) {
        if (name == candidate.name) found = &candidate;
      }
      if (found == nullptr) fail(kExitUsage, "usage", "unknown unit " + name + " (mm, cm, m or in)");
      arguments.unit = found;
    } else {
      positional.push_back(argument);
    }
  }
  if (!haveFrom || !haveTo || positional.size() != 2) fail(kExitUsage, "usage", "cad-convert --from step|iges|mesh --to step|iges|stl|obj [--unit mm|cm|m|in] <input> <output>");
  if (arguments.from == Format::Stl || arguments.from == Format::Obj) fail(kExitUsage, "usage", "--from takes step, iges or mesh");
  if (arguments.to == Format::Mesh) fail(kExitUsage, "usage", "--to takes step, iges, stl or obj");
  arguments.input = positional[0];
  arguments.output = positional[1];
  return arguments;
}

void run(const Arguments& arguments) {
  Handle(XCAFApp_Application) application = XCAFApp_Application::GetApplication();
  Handle(TDocStd_Document) doc;
  application->NewDocument("MDTV-XCAF", doc);
  try {
    if (arguments.from == Format::Step) readStep(arguments.input, doc);
    else if (arguments.from == Format::Iges) readIges(arguments.input, doc);
    else readMeshDocument(arguments.input, doc);
  } catch (const Standard_Failure& error) {
    if (error.IsKind(STANDARD_TYPE(Standard_OutOfMemory))) failOutOfMemory();
    fail(kExitUnreadable, "unreadable", std::string("Open CASCADE failed while reading: ") + error.GetMessageString());
  }

  int shapes = 0;
  const TopoDS_Compound compound = freeShapes(doc, shapes);
  if (shapes == 0) fail(kExitNothing, "no-shapes", "the file holds no shape");
  const int faces = countFaces(compound);
  note(std::string("the result is written in ") + arguments.unit->label);
  note(std::to_string(shapes) + " shape(s), " + std::to_string(faces) + " face(s)");

  try {
    if (arguments.to == Format::Step) {
      writeStep(doc, arguments.output, *arguments.unit);
    } else if (arguments.to == Format::Iges && arguments.from == Format::Mesh) {
      writeIgesFaces(compound, arguments.output, *arguments.unit);
    } else if (arguments.to == Format::Iges) {
      writeIges(doc, arguments.output, *arguments.unit);
    } else {
      if (faces == 0) fail(kExitNothing, "no-surfaces", "the file holds curves or points but no surface to mesh");
      if (arguments.to == Format::Stl) {
        const std::vector<Triangle> triangles = meshTriangles(compound, *arguments.unit);
        note(std::to_string(triangles.size()) + " triangle(s)");
        writeStl(triangles, arguments.output, *arguments.unit);
      } else {
        meshFaces(compound);
        writeObj(doc, arguments.output, *arguments.unit);
      }
    }
  } catch (const Standard_Failure& error) {
    if (error.IsKind(STANDARD_TYPE(Standard_OutOfMemory))) failOutOfMemory();
    fail(kExitFailed, "failed", std::string("Open CASCADE failed while writing: ") + error.GetMessageString());
  }
}

}  // namespace

int main(int argc, char** argv) {
  // The kernel's own console messages go to standard output; the program reports through its own lines instead.
  Message::DefaultMessenger()->RemovePrinters(STANDARD_TYPE(Message_PrinterOStream));
  try {
    run(parseArguments(argc, argv));
    return 0;
  } catch (const Failure& failure) {
    std::cerr << "cad-convert: error: " << failure.code << ": " << failure.message << "\n";
    return failure.status;
  } catch (const std::bad_alloc&) {
    std::cerr << "cad-convert: error: memory: the model needs more memory than the program may use\n";
    return kExitFailed;
  } catch (const Standard_Failure& error) {
    std::cerr << "cad-convert: error: failed: " << error.GetMessageString() << "\n";
    return kExitFailed;
  }
}
