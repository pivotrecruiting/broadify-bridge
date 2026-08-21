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

# Optional OpenVINO matting backend (Windows only): runs MODNet on Intel
# GPU/NPU where DirectML is slow (UHD 630: ~280ms at 512 via DML). Default
# OFF; dist:win enables it. Vendored deps via
# scripts/prepare-windows-openvino-deps.ps1.
if(DEFINED ENV{MEETING_HELPER_ENABLE_OPENVINO})
  set(MEETING_HELPER_ENABLE_OPENVINO "$ENV{MEETING_HELPER_ENABLE_OPENVINO}")
else()
  set(MEETING_HELPER_ENABLE_OPENVINO "0")
endif()

# Native unit tests (ctest). Default ON; overridable via the environment like
# MEETING_HELPER_ENABLE_MODNET. The tests are stdlib-only and never require
# ONNX Runtime, Metal or MediaFoundation.
if(DEFINED ENV{MEETING_HELPER_BUILD_TESTS})
  set(MEETING_HELPER_BUILD_TESTS "$ENV{MEETING_HELPER_BUILD_TESTS}")
else()
  set(MEETING_HELPER_BUILD_TESTS "1")
endif()

enable_testing()

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
  src/compose/d3d_adapter_select.cpp
  src/common/options.cpp
  src/control/control_server.cpp
  src/output/vcam_controller.cpp
  src/keyer/keyer_chain.cpp
  src/keyer/keyer_governor.cpp
  src/keyer/matting_backend.cpp
  src/keyer/matting_common.cpp
  src/keyer/model_manifest.cpp
  src/keyer/modnet_keyer.cpp
  src/keyer/openvino_keyer.cpp
  src/keyer/ort_session_options_policy.cpp
  src/main.cpp
  src/pipeline/frame_pipeline.cpp
  src/pipeline/frame_pipeline_gating.cpp
  src/pipeline/framebus_reader_log_gate.cpp
  src/pipeline/guided_mask_refine.cpp
  src/pipeline/keyer_cadence.cpp
  src/pipeline/mask_retention.cpp
  src/pipeline/subject_presence.cpp
  src/pipeline/tier_handover.cpp
  src/preview/preview_frame_store.cpp
  src/preview/mjpeg_server.cpp
  src/preview/raw_frame_record.cpp
  src/preview/raw_frame_server.cpp
  src/preview/raw_frame_stream_header.cpp
  src/util/sha256.cpp
  src/util/json_utils.cpp
  src/util/helper_event_log.cpp
  src/util/pixel_swizzle.cpp
  src/util/win_qos.cpp
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
    src/recorder/recorder_writer_factory.mm
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
  set_source_files_properties(src/recorder/recorder_writer_factory.mm PROPERTIES
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

# OpenVINO matting backend (Windows only). Mirrors the ONNX Runtime block:
# vendored deps under deps/openvino/windows-x64 (NO_DEFAULT_PATH), overridable
# via BROADIFY_OPENVINO_ROOT, and a hard error when enabled but missing so a
# release can never silently ship without the backend it was told to build.
if(WIN32 AND MEETING_HELPER_ENABLE_OPENVINO STREQUAL "1")
  set(BROADIFY_OPENVINO_ROOT "$ENV{BROADIFY_OPENVINO_ROOT}" CACHE PATH "Path to vendored OpenVINO runtime distribution")
  if(BROADIFY_OPENVINO_ROOT STREQUAL "")
    set(BROADIFY_OPENVINO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/deps/openvino/windows-x64")
  endif()
  find_path(OPENVINO_INCLUDE_DIR
    NAMES openvino/openvino.hpp
    PATHS "${BROADIFY_OPENVINO_ROOT}/include"
    NO_DEFAULT_PATH
  )
  find_library(OPENVINO_LIBRARY
    NAMES openvino
    PATHS "${BROADIFY_OPENVINO_ROOT}/lib"
    NO_DEFAULT_PATH
  )
  if(NOT OPENVINO_INCLUDE_DIR OR NOT OPENVINO_LIBRARY)
    message(FATAL_ERROR
      "The OpenVINO backend is enabled but the vendored runtime was not found. "
      "Expected deps at ${BROADIFY_OPENVINO_ROOT} with include/ and lib/ "
      "(run scripts/prepare-windows-openvino-deps.ps1), set "
      "BROADIFY_OPENVINO_ROOT, or build with MEETING_HELPER_ENABLE_OPENVINO=0."
    )
  endif()
  target_compile_definitions(meeting-helper PRIVATE BROADIFY_ENABLE_OPENVINO=1)
  target_include_directories(meeting-helper PRIVATE "${OPENVINO_INCLUDE_DIR}")
  target_link_libraries(meeting-helper PRIVATE "${OPENVINO_LIBRARY}")
else()
  target_compile_definitions(meeting-helper PRIVATE BROADIFY_ENABLE_OPENVINO=0)
endif()

if(WIN32)
  target_compile_definitions(meeting-helper PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  # mfsensorgroup is intentionally NOT linked: MFCreateVirtualCamera is
  # resolved at runtime (Windows 11 only); a static import would prevent the
  # helper from loading at all on Windows 10 / Server.
  target_link_libraries(meeting-helper PRIVATE ws2_32 mf mfplat mfreadwrite mfuuid ole32 shlwapi d3d11 dxgi d3d12 d3dcompiler DirectML avrt winmm dbghelp)
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

if(MEETING_HELPER_BUILD_TESTS)
  # Each test links ONLY the production sources it exercises, so the test
  # binaries stay dependency-free (no ONNX/Metal/MediaFoundation) and build on
  # every platform regardless of MEETING_HELPER_ENABLE_MODNET.
  add_executable(guided_mask_refine_test
    tests/guided_mask_refine_test.cpp
    src/pipeline/guided_mask_refine.cpp
  )
  add_executable(framebus_reader_log_gate_test
    tests/framebus_reader_log_gate_test.cpp
    src/pipeline/framebus_reader_log_gate.cpp
  )
  add_executable(staging_readback_ring_test
    tests/staging_readback_ring_test.cpp
  )
  add_executable(d3d_adapter_select_test
    tests/d3d_adapter_select_test.cpp
    src/compose/d3d_adapter_select.cpp
  )
  add_executable(pixel_swizzle_test
    tests/pixel_swizzle_test.cpp
    src/util/pixel_swizzle.cpp
  )
  add_executable(ort_session_options_policy_test
    tests/ort_session_options_policy_test.cpp
    src/keyer/ort_session_options_policy.cpp
  )
  add_executable(keyer_governor_test
    tests/keyer_governor_test.cpp
    src/keyer/keyer_governor.cpp
  )
  add_executable(keyer_cadence_test
    tests/keyer_cadence_test.cpp
    src/pipeline/keyer_cadence.cpp
  )
  add_executable(mask_retention_test
    tests/mask_retention_test.cpp
    src/pipeline/mask_retention.cpp
  )
  add_executable(subject_presence_test
    tests/subject_presence_test.cpp
    src/pipeline/subject_presence.cpp
  )
  add_executable(frame_pipeline_stall_test
    tests/frame_pipeline_stall_test.cpp
  )
  add_executable(frame_pipeline_gating_test
    tests/frame_pipeline_gating_test.cpp
    src/pipeline/frame_pipeline_gating.cpp
  )
  add_executable(tier_handover_test
    tests/tier_handover_test.cpp
    src/pipeline/tier_handover.cpp
  )
  # Covers the raw-frame HTTP handshake the Windows VCam DLL parses for its
  # geometry; stdlib-only, no sockets.
  add_executable(raw_frame_stream_header_test
    tests/raw_frame_stream_header_test.cpp
    src/preview/raw_frame_stream_header.cpp
  )
  add_executable(raw_frame_record_test
    tests/raw_frame_record_test.cpp
    src/preview/raw_frame_record.cpp
  )
  add_executable(raw_frame_server_test
    tests/raw_frame_server_test.cpp
    src/preview/raw_frame_record.cpp
    src/preview/raw_frame_server.cpp
    src/preview/raw_frame_stream_header.cpp
    src/preview/preview_frame_store.cpp
    src/util/helper_event_log.cpp
    src/util/pixel_swizzle.cpp
    src/util/win_qos.cpp
  )
  add_executable(control_server_test
    tests/control_server_test.cpp
    src/control/control_server.cpp
    src/capture/camera_source.cpp
    src/output/vcam_controller.cpp
    src/preview/preview_frame_store.cpp
    src/recorder/meeting_recorder_stub.cpp
    src/util/helper_event_log.cpp
    src/util/json_utils.cpp
  )
  # The backend-factory test compiles the production sources WITHOUT the
  # BROADIFY_ENABLE_MODNET/BROADIFY_ENABLE_OPENVINO defines, so the factory
  # policy and the ModnetKeyer fallback wiring are exercised dependency-free
  # (openvino_keyer.cpp is an empty translation unit here).
  add_executable(matting_backend_test
    tests/matting_backend_test.cpp
    src/keyer/matting_backend.cpp
    src/keyer/matting_common.cpp
    src/keyer/model_manifest.cpp
    src/keyer/modnet_keyer.cpp
    src/keyer/openvino_keyer.cpp
    src/keyer/ort_session_options_policy.cpp
    src/util/json_utils.cpp
    src/util/sha256.cpp
  )
  foreach(helper_test
    guided_mask_refine_test
    framebus_reader_log_gate_test
    staging_readback_ring_test
    d3d_adapter_select_test
    pixel_swizzle_test
    ort_session_options_policy_test
    keyer_governor_test
    keyer_cadence_test
    mask_retention_test
    subject_presence_test
    frame_pipeline_stall_test
    frame_pipeline_gating_test
    tier_handover_test
    matting_backend_test
    control_server_test
    raw_frame_stream_header_test
    raw_frame_record_test
    raw_frame_server_test
  )
    target_include_directories(${helper_test} PRIVATE src)
    if(WIN32)
      target_compile_definitions(${helper_test} PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
      if(helper_test STREQUAL "raw_frame_server_test")
        target_link_libraries(${helper_test} PRIVATE ws2_32)
      elseif(helper_test STREQUAL "control_server_test")
        target_link_libraries(${helper_test} PRIVATE ws2_32)
      endif()
    elseif(APPLE AND helper_test STREQUAL "raw_frame_server_test")
      target_link_libraries(${helper_test} PRIVATE "-framework Accelerate")
    endif()
    add_test(NAME ${helper_test} COMMAND ${helper_test})
  endforeach()

  if(APPLE)
    # Exercises the production AVAssetWriter configuration across fragment
    # boundaries with accelerated media timestamps; needs no camera or
    # microphone access, so it runs headless under ctest.
    add_executable(meeting_recorder_writer_test
      tests/meeting_recorder_writer_test.mm
      src/recorder/recorder_writer_factory.mm
    )
    set_source_files_properties(tests/meeting_recorder_writer_test.mm PROPERTIES
      COMPILE_FLAGS "-fobjc-arc"
    )
    target_include_directories(meeting_recorder_writer_test PRIVATE src)
    target_link_libraries(meeting_recorder_writer_test PRIVATE
      "-framework AVFoundation"
      "-framework CoreMedia"
      "-framework CoreVideo"
      "-framework Foundation"
    )
    add_test(NAME meeting_recorder_writer_test COMMAND meeting_recorder_writer_test)
  endif()
endif()
