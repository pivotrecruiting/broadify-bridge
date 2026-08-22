cmake_minimum_required(VERSION 3.22)

project(broadify_vcam LANGUAGES CXX)

execute_process(
  COMMAND git rev-parse --short=12 HEAD
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.."
  OUTPUT_VARIABLE BROADIFY_BUILD_GIT_SHA
  OUTPUT_STRIP_TRAILING_WHITESPACE
  ERROR_QUIET
)
if(BROADIFY_BUILD_GIT_SHA STREQUAL "")
  set(BROADIFY_BUILD_GIT_SHA "unknown")
endif()
string(TIMESTAMP BROADIFY_BUILD_TIMESTAMP "%Y-%m-%dT%H:%M:%SZ" UTC)
configure_file(
  "${CMAKE_CURRENT_SOURCE_DIR}/../../meeting-helper/src/build_stamp.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/build_stamp.h"
  @ONLY
)

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

target_include_directories(broadify-vcam PRIVATE
  "${CMAKE_CURRENT_BINARY_DIR}/generated"
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
