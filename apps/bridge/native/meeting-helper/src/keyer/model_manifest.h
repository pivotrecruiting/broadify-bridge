#pragma once

#include <string>

namespace broadify::meeting {

struct ModelManifestEntry {
  std::string name;
  std::string file;
  std::string sha256;
  // Optional companion file for two-file model formats (OpenVINO IR:
  // .xml + .bin). Empty when the manifest entry does not declare one.
  std::string binFile;
  std::string binSha256;
  bool required = false;
};

ModelManifestEntry findModelManifestEntry(const std::string &modelsDir, const std::string &modelName);
std::string joinModelPath(const std::string &modelsDir, const std::string &fileName);

}  // namespace broadify::meeting
