cmake_minimum_required(VERSION 3.22)

# Pin the macOS deployment target to the supported floor (13.0) before project().
if(APPLE AND NOT DEFINED CMAKE_OSX_DEPLOYMENT_TARGET)
  if(DEFINED ENV{PGM_HELPER_MACOSX_DEPLOYMENT_TARGET} AND NOT "$ENV{PGM_HELPER_MACOSX_DEPLOYMENT_TARGET}" STREQUAL "")
    set(CMAKE_OSX_DEPLOYMENT_TARGET "$ENV{PGM_HELPER_MACOSX_DEPLOYMENT_TARGET}" CACHE STRING "Minimum macOS deployment version")
  else()
    set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "Minimum macOS deployment version")
  endif()
endif()

project(broadify_pgm_helper VERSION 0.1.0 LANGUAGES C CXX)
if(APPLE)
  enable_language(OBJCXX)
endif()

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Native unit tests (ctest): stdlib-only, no media frameworks, no WebRTC.
if(DEFINED ENV{PGM_HELPER_BUILD_TESTS})
  set(PGM_HELPER_BUILD_TESTS "$ENV{PGM_HELPER_BUILD_TESTS}")
else()
  set(PGM_HELPER_BUILD_TESTS "1")
endif()
# The helper binary itself (capture, encoder, WebRTC). OFF builds only the pure
# modules + tests, e.g. in CI jobs without network for FetchContent.
if(DEFINED ENV{PGM_HELPER_BUILD_BINARY})
  set(PGM_HELPER_BUILD_BINARY "$ENV{PGM_HELPER_BUILD_BINARY}")
else()
  set(PGM_HELPER_BUILD_BINARY "1")
endif()

enable_testing()

set(MEETING_HELPER_BUILD_TESTS "${PGM_HELPER_BUILD_TESTS}")
add_subdirectory(../helper-common helper-common)
# Encoder, Annex B, bitrate ladder and WebRTC publisher are shared with the meeting helper.
add_subdirectory(../live-stream live-stream)

# Pure modules: usable by the binary and by tests without any dependency.
add_library(pgm_core STATIC
  src/signal/video_signal_tracker.cpp
  src/control/pgm_rpc.cpp
  src/common/pgm_options.cpp
  src/capture/uvc_format_select.cpp
  src/capture/snapshot_portable.cpp
  src/audio/audio_pairing.cpp
)
target_include_directories(pgm_core PUBLIC src)
# stb_image_write (JPEG for the portable snapshot) is vendored with the meeting helper.
target_include_directories(pgm_core PRIVATE ../meeting-helper/third_party/stb)
target_link_libraries(pgm_core PUBLIC helper_common live_stream_core)

if(PGM_HELPER_BUILD_BINARY AND APPLE)
  include(FetchContent)
  set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
  set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(opus
    GIT_REPOSITORY https://github.com/xiph/opus.git
    GIT_TAG v1.5.2
    GIT_SHALLOW TRUE)
  FetchContent_MakeAvailable(opus)

  add_executable(pgm-helper MACOSX_BUNDLE
    src/main.cpp
    src/pgm_engine.cpp
    src/platform/platform_host_mac.mm
    src/capture/uvc_avfoundation.mm
    src/capture/synthetic_source.mm
    src/capture/frame_holder_mac.mm
    src/audio/audio_capture_avfoundation.mm
    src/audio/opus_encoder.cpp
    src/capture/snapshot.mm
    src/recorder/mp4_recorder.mm
    src/macos/macos_app.mm
  )
  set_source_files_properties(
    src/platform/platform_host_mac.mm src/capture/uvc_avfoundation.mm src/capture/synthetic_source.mm
    src/capture/frame_holder_mac.mm src/audio/audio_capture_avfoundation.mm src/macos/macos_app.mm src/capture/snapshot.mm src/recorder/mp4_recorder.mm
    PROPERTIES COMPILE_FLAGS "-fobjc-arc")
  target_include_directories(pgm-helper PRIVATE src)
  target_link_libraries(pgm-helper PRIVATE pgm_core live_stream opus
    "-framework AVFoundation" "-framework CoreMedia" "-framework CoreVideo" "-framework VideoToolbox"
    "-framework Foundation" "-framework AppKit" "-framework CoreAudio" "-framework AudioToolbox" "-framework CoreImage" "-framework ImageIO")
  set_target_properties(pgm-helper PROPERTIES
    OUTPUT_NAME "BroadifyPgmHelper"
    MACOSX_BUNDLE_BUNDLE_NAME "Broadify Bridge PGM Helper"
    MACOSX_BUNDLE_GUI_IDENTIFIER "com.broadify.bridge.pgm-helper"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/macos/Info.plist"
  )
endif()

# Windows (ADR-0009): the helper executable follows with the Windows capture
# sources. Until then the portable entry point, the engine and the Windows
# platform host can be compiled on request (object library: nothing is linked,
# nothing ships) so the CI workflow keeps them MSVC-clean.
option(PGM_HELPER_WINDOWS_COMPILE_CHECK "Compile the portable pgm-helper sources and the Windows platform host (no executable)" OFF)
if(WIN32 AND PGM_HELPER_WINDOWS_COMPILE_CHECK)
  add_library(pgm_helper_portable_objects OBJECT
    src/main.cpp
    src/pgm_engine.cpp
    src/platform/platform_host_win.cpp
  )
  target_include_directories(pgm_helper_portable_objects PRIVATE src)
  target_link_libraries(pgm_helper_portable_objects PRIVATE pgm_core)
endif()

if(PGM_HELPER_BUILD_TESTS)
  foreach(pgm_test IN ITEMS video_signal_tracker_test pgm_rpc_dispatch_test recording_signal_gate_test pgm_options_test
      uvc_format_select_test audio_pairing_test snapshot_portable_test portable_sources_test)
    add_executable(${pgm_test} tests/${pgm_test}.cpp)
    target_link_libraries(${pgm_test} PRIVATE pgm_core)
    if(WIN32)
      target_compile_definitions(${pgm_test} PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    endif()
    add_test(NAME ${pgm_test} COMMAND ${pgm_test})
  endforeach()
  # stb_image decodes the snapshot again.
  target_include_directories(snapshot_portable_test PRIVATE ../meeting-helper/third_party/stb)
  # The plain C++ backends of the Windows helper, compiled into a test on every
  # platform (on macOS the helper itself uses the .mm counterparts).
  target_sources(portable_sources_test PRIVATE
    src/capture/synthetic_source.cpp
    src/capture/frame_holder_portable.cpp
    src/recorder/mp4_recorder_stub.cpp
  )
  set_tests_properties(portable_sources_test PROPERTIES TIMEOUT 60)
endif()
