cmake_minimum_required(VERSION 3.22)

# Pin the macOS deployment target so the helper runs on the supported floor
# (13.0). Without this it inherits the build host's SDK default (e.g. 15.0 on
# macos-15 runners), which fails release artifact verification. Must be set
# before project(). Overridable via MEETING_HELPER_MACOSX_DEPLOYMENT_TARGET.
if(APPLE AND NOT DEFINED CMAKE_OSX_DEPLOYMENT_TARGET)
  if(DEFINED ENV{MEETING_HELPER_MACOSX_DEPLOYMENT_TARGET} AND NOT "$ENV{MEETING_HELPER_MACOSX_DEPLOYMENT_TARGET}" STREQUAL "")
    set(CMAKE_OSX_DEPLOYMENT_TARGET "$ENV{MEETING_HELPER_MACOSX_DEPLOYMENT_TARGET}" CACHE STRING "Minimum macOS deployment version")
  else()
    set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "Minimum macOS deployment version")
  endif()
endif()

project(broadify_meeting_helper LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(DEFINED ENV{MEETING_HELPER_ENABLE_MODNET})
  set(MEETING_HELPER_ENABLE_MODNET "$ENV{MEETING_HELPER_ENABLE_MODNET}")
else()
  set(MEETING_HELPER_ENABLE_MODNET "1")
endif()

if(APPLE)
  set(DEFAULT_ONNXRUNTIME_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/deps/onnxruntime/macos-arm64")
elseif(WIN32)
  set(DEFAULT_ONNXRUNTIME_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/deps/onnxruntime/windows-x64")
else()
  set(DEFAULT_ONNXRUNTIME_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/deps/onnxruntime/linux-x64")
endif()

set(BROADIFY_ONNXRUNTIME_ROOT "$ENV{BROADIFY_ONNXRUNTIME_ROOT}" CACHE PATH "Path to vendored ONNX Runtime C/C++ distribution")
if(BROADIFY_ONNXRUNTIME_ROOT STREQUAL "")
  set(BROADIFY_ONNXRUNTIME_ROOT "${DEFAULT_ONNXRUNTIME_ROOT}")
endif()

set(MEETING_HELPER_SOURCES
  ../vcam-helper/Shared/src/framebus_reader.c
  Shared/src/framebus_writer.c
  src/capture/camera_source.cpp
  src/compose/compositor.cpp
  src/common/options.cpp
  src/control/control_server.cpp
  src/output/vcam_controller.cpp
  src/keyer/keyer_chain.cpp
  src/keyer/model_manifest.cpp
  src/keyer/modnet_keyer.cpp
  src/main.cpp
  src/pipeline/frame_pipeline.cpp
  src/pipeline/guided_mask_refine.cpp
  src/preview/preview_frame_store.cpp
  src/preview/mjpeg_server.cpp
  src/preview/raw_frame_server.cpp
  src/util/sha256.cpp
  src/util/json_utils.cpp
)

if(APPLE)
  enable_language(OBJCXX)
  list(APPEND MEETING_HELPER_SOURCES
    src/capture/camera_avfoundation.mm
    src/compose/metal_compositor.mm
    src/compose/metal_device.mm
    src/keyer/vision_keyer.mm
    src/keyer/coreml_keyer.mm
    src/keyer/gpu_mask_refine.mm
    src/recorder/meeting_recorder.mm
    src/macos/macos_app.mm
  )
  set_source_files_properties(src/keyer/coreml_keyer.mm PROPERTIES
    COMPILE_FLAGS "-fobjc-arc"
  )
  set_source_files_properties(src/keyer/gpu_mask_refine.mm PROPERTIES
    COMPILE_FLAGS "-fobjc-arc"
  )
  set_source_files_properties(src/recorder/meeting_recorder.mm PROPERTIES
    COMPILE_FLAGS "-fobjc-arc"
  )
  set_source_files_properties(src/capture/camera_avfoundation.mm PROPERTIES
    COMPILE_FLAGS "-fobjc-arc"
  )
  set_source_files_properties(src/compose/metal_compositor.mm PROPERTIES
    COMPILE_FLAGS "-fobjc-arc"
  )
  set_source_files_properties(src/compose/metal_device.mm PROPERTIES
    COMPILE_FLAGS "-fobjc-arc"
  )
  set_source_files_properties(src/keyer/vision_keyer.mm PROPERTIES
    COMPILE_FLAGS "-fobjc-arc"
  )
  set_source_files_properties(src/macos/macos_app.mm PROPERTIES
    COMPILE_FLAGS "-fobjc-arc"
  )
elseif(WIN32)
  list(APPEND MEETING_HELPER_SOURCES src/capture/camera_mediafoundation.cpp src/recorder/meeting_recorder_mediafoundation.cpp src/compose/d3d11_compositor.cpp)
else()
  list(APPEND MEETING_HELPER_SOURCES src/capture/camera_stub.cpp src/recorder/meeting_recorder_stub.cpp)
endif()

if(APPLE)
  add_executable(meeting-helper MACOSX_BUNDLE ${MEETING_HELPER_SOURCES})
else()
  add_executable(meeting-helper ${MEETING_HELPER_SOURCES})
endif()

target_include_directories(meeting-helper PRIVATE
  src
  Shared/include
  ../vcam-helper/Shared/include
  ../framebus/include
  third_party/stb
)

if(MEETING_HELPER_ENABLE_MODNET STREQUAL "1")
  find_path(ONNXRUNTIME_INCLUDE_DIR
    NAMES onnxruntime_cxx_api.h
    PATHS "${BROADIFY_ONNXRUNTIME_ROOT}/include"
    NO_DEFAULT_PATH
  )
  find_library(ONNXRUNTIME_LIBRARY
    NAMES onnxruntime libonnxruntime
    PATHS "${BROADIFY_ONNXRUNTIME_ROOT}/lib" "${BROADIFY_ONNXRUNTIME_ROOT}/lib64" "${BROADIFY_ONNXRUNTIME_ROOT}"
    NO_DEFAULT_PATH
  )
  if(NOT ONNXRUNTIME_INCLUDE_DIR OR NOT ONNXRUNTIME_LIBRARY)
    message(FATAL_ERROR
      "MODNet is enabled but ONNX Runtime was not found. "
      "Expected vendored deps at ${BROADIFY_ONNXRUNTIME_ROOT} with include/ and lib/. "
      "Set BROADIFY_ONNXRUNTIME_ROOT or build with MEETING_HELPER_ENABLE_MODNET=0."
    )
  endif()
  target_compile_definitions(meeting-helper PRIVATE BROADIFY_ENABLE_MODNET=1)
  target_include_directories(meeting-helper PRIVATE "${ONNXRUNTIME_INCLUDE_DIR}")
  target_link_libraries(meeting-helper PRIVATE "${ONNXRUNTIME_LIBRARY}")
else()
  target_compile_definitions(meeting-helper PRIVATE BROADIFY_ENABLE_MODNET=0)
endif()

if(WIN32)
  target_compile_definitions(meeting-helper PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  # mfsensorgroup is intentionally NOT linked: MFCreateVirtualCamera is
  # resolved at runtime (Windows 11 only); a static import would prevent the
  # helper from loading at all on Windows 10 / Server.
  target_link_libraries(meeting-helper PRIVATE ws2_32 mf mfplat mfreadwrite mfuuid ole32 shlwapi d3d11 d3dcompiler dbghelp)
else()
  target_link_libraries(meeting-helper PRIVATE pthread)
  if(NOT APPLE)
    target_link_libraries(meeting-helper PRIVATE dl)
  endif()
endif()

if(APPLE)
  target_link_libraries(meeting-helper PRIVATE
    "-framework Accelerate"
    "-framework AppKit"
    "-framework ApplicationServices"
    "-framework AVFoundation"
    "-framework CoreGraphics"
    "-framework CoreImage"
    "-framework CoreML"
    "-framework CoreMedia"
    "-framework CoreVideo"
    "-framework Foundation"
    "-framework ImageIO"
    "-framework Metal"
    "-framework MetalPerformanceShaders"
    "-framework Vision"
  )
  set_target_properties(meeting-helper PROPERTIES
    OUTPUT_NAME "BroadifyMeetingHelper"
    MACOSX_RPATH ON
    BUILD_RPATH "@loader_path"
    MACOSX_BUNDLE_BUNDLE_NAME "Broadify Bridge Meeting Helper"
    MACOSX_BUNDLE_GUI_IDENTIFIER "com.broadify.bridge.meeting-helper"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/macos/Info.plist"
  )
endif()
