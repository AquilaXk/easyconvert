// cad-convert: reads a STEP or IGES file with the Open CASCADE data exchange libraries and writes STEP, IGES, binary STL or OBJ.
//
//   cad-convert --from step|iges --to step|iges|stl|obj [--unit mm|cm|m|in] <input> <output>
//
// STEP and IGES are written from the B-rep, not from a mesh, with the colours and names that the document model (XDE)
// carries. STL and OBJ are meshed from the B-rep. Every output is in millimetres: the readers convert the file's length
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
#include <Bnd_Box.hxx>
#include <IGESCAFControl_Reader.hxx>
#include <IGESCAFControl_Writer.hxx>
#include <IGESControl_Controller.hxx>
#include <IGESData_GlobalSection.hxx>
#include <IGESData_IGESModel.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_PrinterOStream.hxx>
#include <Poly_Triangulation.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <STEPControl_Controller.hxx>
#include <STEPControl_StepModelType.hxx>
#include <Standard_Failure.hxx>
#include <Standard_OutOfMemory.hxx>
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
#include <TopoDS_Face.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
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

enum class Format { Step, Iges, Stl, Obj };

bool parseFormat(const std::string& name, Format& out) {
  if (name == "step") out = Format::Step;
  else if (name == "iges") out = Format::Iges;
  else if (name == "stl") out = Format::Stl;
  else if (name == "obj") out = Format::Obj;
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

std::vector<Triangle> meshTriangles(const TopoDS_Shape& shape, const OutputUnit& unit) {
  const double extent = largestExtent(shape);
  if (!(extent > 0.0) || !std::isfinite(extent)) fail(kExitNothing, "no-surfaces", "the model has no extent to mesh");
  BRepMesh_IncrementalMesh mesher(shape, extent * kLinearDeflectionOfExtent, Standard_False, kAngularDeflectionRadians, Standard_False);
  (void)mesher;
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

// Wavefront OBJ: shared vertices are written once, so the triangles of neighbouring faces meet at the same index.
void writeObj(const std::vector<Triangle>& triangles, const std::string& path, const OutputUnit& unit) {
  std::unordered_map<VertexKey, std::uint32_t, VertexKeyHash> index;
  std::vector<VertexKey> vertices;
  std::vector<std::uint32_t> corners;
  corners.reserve(triangles.size() * 3);
  for (const Triangle& triangle : triangles) {
    for (const auto& v : triangle.vertex) {
      const VertexKey key{v[0], v[1], v[2]};
      const auto found = index.emplace(key, static_cast<std::uint32_t>(vertices.size() + 1));
      if (found.second) vertices.push_back(key);
      corners.push_back(found.first->second);
    }
  }
  std::ofstream out(path);
  if (!out) fail(kExitFailed, "write", "the OBJ file cannot be opened for writing");
  out << "# Wavefront OBJ, coordinates in " << unit.label << "\n";
  char line[128];
  for (const VertexKey& v : vertices) {
    std::snprintf(line, sizeof line, "v %.9g %.9g %.9g\n", v.x, v.y, v.z);
    out << line;
  }
  for (std::size_t i = 0; i < corners.size(); i += 3) out << "f " << corners[i] << ' ' << corners[i + 1] << ' ' << corners[i + 2] << '\n';
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
  if (!haveFrom || !haveTo || positional.size() != 2) fail(kExitUsage, "usage", "cad-convert --from step|iges --to step|iges|stl|obj [--unit mm|cm|m|in] <input> <output>");
  if (arguments.from != Format::Step && arguments.from != Format::Iges) fail(kExitUsage, "usage", "--from takes step or iges");
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
    else readIges(arguments.input, doc);
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
    } else if (arguments.to == Format::Iges) {
      writeIges(doc, arguments.output, *arguments.unit);
    } else {
      if (faces == 0) fail(kExitNothing, "no-surfaces", "the file holds curves or points but no surface to mesh");
      const std::vector<Triangle> triangles = meshTriangles(compound, *arguments.unit);
      note(std::to_string(triangles.size()) + " triangle(s)");
      if (arguments.to == Format::Stl) writeStl(triangles, arguments.output, *arguments.unit);
      else writeObj(triangles, arguments.output, *arguments.unit);
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
