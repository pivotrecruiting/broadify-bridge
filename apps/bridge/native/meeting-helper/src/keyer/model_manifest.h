#pragma once

#include <string>

namespace broadify::meeting {

struct ModelManifestEntry {
  std::string name;
  std::string file;
  std::string sha256;
  bool required = false;
};

ModelManifestEntry findModelManifestEntry(const std::string &modelsDir, const std::string &modelName);
std::string joinModelPath(const std::string &modelsDir, const std::string &fileName);

}  // namespace broadify::meeting
