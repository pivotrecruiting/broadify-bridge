cmake_minimum_required(VERSION 3.22)

# Pin the macOS deployment target to the supported floor (13.0) before project().
if(APPLE AND NOT DEFINED CMAKE_OSX_DEPLOYMENT_TARGET)
  if(DEFINED ENV{PGM_HELPER_MACOSX_DEPLOYMENT_TARGET} AND NOT "$ENV{PGM_HELPER_MACOSX_DEPLOYMENT_TARGET}" STREQUAL "")
    set(CMAKE_OSX_DEPLOYMENT_TARGET "$ENV{PGM_HELPER_MACOSX_DEPLOYMENT_TARGET}" CACHE STRING "Minimum macOS deployment version")
  else()
    set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "Minimum macOS deployment version")
  endif()
endif()

project(broadify_pgm_helper LANGUAGES C CXX)

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

# Pure modules: usable by the binary and by tests without any dependency.
add_library(pgm_core STATIC
  src/encode/h264_annexb.cpp
  src/encode/bitrate_ladder.cpp
  src/signal/video_signal_tracker.cpp
  src/control/pgm_rpc.cpp
  src/common/pgm_options.cpp
)
target_include_directories(pgm_core PUBLIC src)
target_link_libraries(pgm_core PUBLIC helper_common)

if(PGM_HELPER_BUILD_BINARY AND APPLE)
  include(FetchContent)
  # libdatachannel (MIT) with MbedTLS: static, no extra dylib to sign. Pinned.
  # Offline builds: set FETCHCONTENT_SOURCE_DIR_LIBDATACHANNEL / _OPUS.
  set(NO_WEBSOCKET ON CACHE BOOL "" FORCE)
  set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
  set(NO_TESTS ON CACHE BOOL "" FORCE)
  set(USE_MBEDTLS ON CACHE BOOL "" FORCE)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(libdatachannel
    GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
    GIT_TAG v0.22.6
    GIT_SHALLOW TRUE)
  FetchContent_MakeAvailable(libdatachannel)
  set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
  set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(opus
    GIT_REPOSITORY https://github.com/xiph/opus.git
    GIT_TAG v1.5.2
    GIT_SHALLOW TRUE)
  FetchContent_MakeAvailable(opus)

  add_executable(pgm-helper MACOSX_BUNDLE
    src/main.mm
    src/pgm_engine.cpp
    src/capture/uvc_avfoundation.mm
    src/capture/synthetic_source.mm
    src/encode/vt_encoder.mm
    src/audio/audio_capture_avfoundation.mm
    src/audio/opus_encoder.cpp
    src/webrtc/publisher.cpp
    src/macos/macos_app.mm
  )
  set_source_files_properties(
    src/main.mm src/capture/uvc_avfoundation.mm src/capture/synthetic_source.mm src/encode/vt_encoder.mm
    src/audio/audio_capture_avfoundation.mm src/macos/macos_app.mm
    PROPERTIES COMPILE_FLAGS "-fobjc-arc")
  target_include_directories(pgm-helper PRIVATE src)
  target_link_libraries(pgm-helper PRIVATE pgm_core LibDataChannel::LibDataChannelStatic opus
    "-framework AVFoundation" "-framework CoreMedia" "-framework CoreVideo" "-framework VideoToolbox"
    "-framework Foundation" "-framework AppKit" "-framework CoreAudio" "-framework AudioToolbox")
  set_target_properties(pgm-helper PROPERTIES
    OUTPUT_NAME "BroadifyPgmHelper"
    MACOSX_BUNDLE_BUNDLE_NAME "Broadify Bridge PGM Helper"
    MACOSX_BUNDLE_GUI_IDENTIFIER "com.broadify.bridge.pgm-helper"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/macos/Info.plist"
  )
endif()

if(PGM_HELPER_BUILD_TESTS)
  foreach(pgm_test IN ITEMS h264_annexb_test bitrate_ladder_test video_signal_tracker_test pgm_rpc_dispatch_test)
    add_executable(${pgm_test} tests/${pgm_test}.cpp)
    target_link_libraries(${pgm_test} PRIVATE pgm_core)
    if(WIN32)
      target_compile_definitions(${pgm_test} PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    endif()
    add_test(NAME ${pgm_test} COMMAND ${pgm_test})
  endforeach()
endif()
