cmake_minimum_required(VERSION 3.22)

project(broadify_vcam LANGUAGES CXX)

# C++/WinRT (winrt::implements) requires C++17.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

execute_process(
  COMMAND git rev-parse --short=12 HEAD
  WORKING_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/../../../../.."
  OUTPUT_VARIABLE BROADIFY_VCAM_GIT_SHA
  OUTPUT_STRIP_TRAILING_WHITESPACE
  ERROR_QUIET
)
if(BROADIFY_VCAM_GIT_SHA STREQUAL "")
  set(BROADIFY_VCAM_GIT_SHA "unknown")
endif()
string(TIMESTAMP BROADIFY_VCAM_BUILD_TIME "%Y-%m-%dT%H:%M:%SZ" UTC)

add_library(broadify-vcam SHARED
  ../../meeting-helper/src/preview/vcam_shm_layout.cpp
  raw_frame_client.cpp
  shm_frame_reader.cpp
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
  BROADIFY_VCAM_GIT_SHA="${BROADIFY_VCAM_GIT_SHA}"
  BROADIFY_VCAM_BUILD_TIME="${BROADIFY_VCAM_BUILD_TIME}"
)

target_include_directories(broadify-vcam PRIVATE
  ../../meeting-helper/src
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
