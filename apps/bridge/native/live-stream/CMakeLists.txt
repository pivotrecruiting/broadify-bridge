cmake_minimum_required(VERSION 3.22)

# Shared live-stream library of the native helpers: hardware H.264 encoder
# abstraction (VideoToolbox on macOS), Annex B helpers, bitrate ladder and the
# libdatachannel WebRTC publisher (one PeerConnection per viewer). Used by the
# PGM helper (switcher program) and the meeting helper (composited camera
# program). ADR-0001/ADR-0004 in docs/bridge/architecture/adr.

if(NOT DEFINED PROJECT_NAME)
  project(broadify_live_stream LANGUAGES C CXX)
  set(CMAKE_CXX_STANDARD 17)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
  enable_testing()
endif()

if(NOT DEFINED LIVE_STREAM_BUILD_TESTS)
  if(DEFINED ENV{LIVE_STREAM_BUILD_TESTS})
    set(LIVE_STREAM_BUILD_TESTS "$ENV{LIVE_STREAM_BUILD_TESTS}")
  elseif(DEFINED PGM_HELPER_BUILD_TESTS)
    set(LIVE_STREAM_BUILD_TESTS "${PGM_HELPER_BUILD_TESTS}")
  elseif(DEFINED MEETING_HELPER_BUILD_TESTS)
    set(LIVE_STREAM_BUILD_TESTS "${MEETING_HELPER_BUILD_TESTS}")
  else()
    set(LIVE_STREAM_BUILD_TESTS "1")
  endif()
endif()
# WebRTC + hardware encoder part: macOS only until the Media Foundation encoder ships.
if(NOT DEFINED LIVE_STREAM_WITH_WEBRTC)
  if(APPLE)
    set(LIVE_STREAM_WITH_WEBRTC ON)
  else()
    set(LIVE_STREAM_WITH_WEBRTC OFF)
  endif()
endif()

if(NOT TARGET helper_common)
  add_subdirectory(../helper-common helper-common)
endif()

# Pure modules: no platform or network dependency, used by tests on every platform.
add_library(live_stream_core STATIC
  src/h264_annexb.cpp
  src/bitrate_ladder.cpp
  src/viewer_offer_parse.cpp
)
target_include_directories(live_stream_core PUBLIC include)
target_compile_features(live_stream_core PUBLIC cxx_std_17)
target_link_libraries(live_stream_core PUBLIC helper_common)
if(WIN32)
  target_compile_definitions(live_stream_core PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

if(LIVE_STREAM_WITH_WEBRTC AND APPLE)
  enable_language(OBJCXX)
  include(FetchContent)
  # libdatachannel (MIT), static, pinned. TLS via OpenSSL linked statically
  # (Homebrew openssl@3 on macOS: no extra dylib to sign; MbedTLS is not vendored
  # by libdatachannel and would need its own distribution).
  # Offline builds: set FETCHCONTENT_SOURCE_DIR_LIBDATACHANNEL.
  # plog (libdatachannel dep) still declares cmake_minimum_required < 3.5.
  set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)
  if(NOT DEFINED OPENSSL_ROOT_DIR AND EXISTS "/opt/homebrew/opt/openssl@3")
    set(OPENSSL_ROOT_DIR "/opt/homebrew/opt/openssl@3" CACHE PATH "" FORCE)
  endif()
  set(OPENSSL_USE_STATIC_LIBS TRUE CACHE BOOL "" FORCE)
  # Dependencies' own test suites stay out of our ctest run.
  set(TEST_APPS OFF CACHE BOOL "" FORCE)
  set(NO_WEBSOCKET ON CACHE BOOL "" FORCE)
  set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
  set(NO_TESTS ON CACHE BOOL "" FORCE)
  set(USE_MBEDTLS OFF CACHE BOOL "" FORCE)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(libdatachannel
    GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
    GIT_TAG v0.22.6
    GIT_SHALLOW TRUE)
  FetchContent_MakeAvailable(libdatachannel)

  add_library(live_stream STATIC
    src/vt_encoder.mm
    src/publisher.cpp
  )
  set_source_files_properties(src/vt_encoder.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
  target_include_directories(live_stream PUBLIC include)
  target_link_libraries(live_stream PUBLIC live_stream_core LibDataChannel::LibDataChannelStatic
    "-framework CoreMedia" "-framework CoreVideo" "-framework VideoToolbox" "-framework Foundation")

  if(LIVE_STREAM_BUILD_TESTS)
    add_executable(vt_encoder_smoke_test tests/vt_encoder_smoke_test.mm)
    set_source_files_properties(tests/vt_encoder_smoke_test.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
    target_link_libraries(vt_encoder_smoke_test PRIVATE live_stream)
    add_test(NAME vt_encoder_smoke_test COMMAND vt_encoder_smoke_test)
    set_tests_properties(vt_encoder_smoke_test PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 60)
    add_executable(webrtc_loopback_test tests/webrtc_loopback_test.cpp)
    target_link_libraries(webrtc_loopback_test PRIVATE live_stream)
    add_test(NAME webrtc_loopback_test COMMAND webrtc_loopback_test)
    set_tests_properties(webrtc_loopback_test PROPERTIES TIMEOUT 60)
  endif()
endif()

if(LIVE_STREAM_BUILD_TESTS)
  foreach(live_test IN ITEMS h264_annexb_test bitrate_ladder_test)
    add_executable(${live_test} tests/${live_test}.cpp)
    target_link_libraries(${live_test} PRIVATE live_stream_core)
    add_test(NAME ${live_test} COMMAND ${live_test})
  endforeach()
endif()
