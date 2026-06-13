#include "keyer/model_manifest.h"

#include "util/json_utils.h"

#include <fstream>
#include <sstream>

namespace broadify::meeting {
namespace {

std::string readFile(const std::string &path) {
  std::ifstream input(path);
  if (!input) {
    return "";
  }
  std::ostringstream buffer;
  buffer << input.rdbuf();
  return buffer.str();
}

std::string dirnameJoin(const std::string &left, const std::string &right) {
  if (left.empty()) {
    return right;
  }
  const char last = left[left.size() - 1u];
  if (last == '/' || last == '\\') {
    return left + right;
  }
#if defined(_WIN32)
  return left + "\\" + right;
#else
  return left + "/" + right;
#endif
}

std::string findObjectByName(const std::string &manifest, const std::string &modelName) {
  size_t searchPos = 0;
  while (true) {
    const size_t namePos = manifest.find("\"name\"", searchPos);
    if (namePos == std::string::npos) {
      return "";
    }
    const size_t objectStart = manifest.rfind('{', namePos);
    const size_t objectEnd = manifest.find('}', namePos);
    if (objectStart == std::string::npos || objectEnd == std::string::npos || objectEnd <= objectStart) {
      return "";
    }
    const std::string object = manifest.substr(objectStart, objectEnd - objectStart + 1u);
    if (extractStringField(object, "name") == modelName) {
      return object;
    }
    searchPos = objectEnd + 1u;
  }
}

}  // namespace

std::string joinModelPath(const std::string &modelsDir, const std::string &fileName) {
  return dirnameJoin(modelsDir, fileName);
}

ModelManifestEntry findModelManifestEntry(const std::string &modelsDir, const std::string &modelName) {
  const std::string manifest = readFile(dirnameJoin(modelsDir, "manifest.json"));
  const std::string object = findObjectByName(manifest, modelName);
  ModelManifestEntry entry;
  if (object.empty()) {
    return entry;
  }
  entry.name = extractStringField(object, "name");
  entry.file = extractStringField(object, "file");
  entry.sha256 = extractStringField(object, "sha256");
  entry.required = extractBoolField(object, "required", false);
  return entry;
}

}  // namespace broadify::meeting
