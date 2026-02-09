{
  "targets": [
    {
      "target_name": "framebus",
      "sources": ["src/framebus-addon.cc"],
      "cflags_cc": ["-std=c++17"],
      "include_dirs": ["include"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS=1"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_CXX_LIBRARY": "libc++"
      }
    }
  ]
}
