cmake_minimum_required(VERSION 3.22)

project(broadify_vcam LANGUAGES CXX)

# C++/WinRT (winrt::implements) requires C++17.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(broadify-vcam SHARED
  raw_frame_client.cpp
  vcam_log.cpp
  media_stream.cpp
  media_source.cpp
  dllmain.cpp
  broadify_vcam.def
)

target_compile_definitions(broadify-vcam PRIVATE
  NOMINMAX
  WIN32_LEAN_AND_MEAN
  UNICODE
  _UNICODE
  _CRT_SECURE_NO_WARNINGS
  _SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS
)

target_link_libraries(broadify-vcam PRIVATE
  mf
  mfplat
  mfreadwrite
  mfsensorgroup
  mfuuid
  ole32
  ws2_32
  advapi32
  runtimeobject
)

set_target_properties(broadify-vcam PROPERTIES
  OUTPUT_NAME "broadify-vcam"
)
