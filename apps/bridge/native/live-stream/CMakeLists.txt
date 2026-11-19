cmake_minimum_required(VERSION 3.22)

# Shared live-stream library of the native helpers: hardware H.264 encoder
# abstraction (VideoToolbox on macOS, Media Foundation on Windows behind
# LIVE_STREAM_WITH_MF), Annex B helpers, pixel modules, bitrate ladder and the
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
# WebRTC + hardware encoder part (target `live_stream`). macOS: always. Windows
# (ADR-0009): opt-in, because it fetches libdatachannel and needs the static
# OpenSSL from scripts/prepare-windows-pgm-deps.ps1. Turned on there by
# -DLIVE_STREAM_WITH_WEBRTC=ON or the build switch BROADIFY_PGM_WINDOWS=1 in the
# environment; without them a Windows build stays what it is today.
if(NOT DEFINED LIVE_STREAM_WITH_WEBRTC)
  if(APPLE)
    set(LIVE_STREAM_WITH_WEBRTC ON)
  elseif(WIN32 AND "$ENV{BROADIFY_PGM_WINDOWS}" STREQUAL "1")
    set(LIVE_STREAM_WITH_WEBRTC ON)
  else()
    set(LIVE_STREAM_WITH_WEBRTC OFF)
  endif()
endif()

# Media Foundation hardware H.264 encoder (Windows, ADR-0009). Opt-in: without
# it a Windows build contains none of its targets, so `dist:win` (which builds
# every target of the meeting-helper build directory) stays as it is. Turned on
# by -DLIVE_STREAM_WITH_MF=ON, LIVE_STREAM_WITH_MF=1 or the build switch
# BROADIFY_PGM_WINDOWS=1 in the environment; needs neither WebRTC nor OpenSSL.
if(NOT DEFINED LIVE_STREAM_WITH_MF)
  if(DEFINED ENV{LIVE_STREAM_WITH_MF})
    set(LIVE_STREAM_WITH_MF "$ENV{LIVE_STREAM_WITH_MF}")
  elseif("$ENV{BROADIFY_PGM_WINDOWS}" STREQUAL "1")
    set(LIVE_STREAM_WITH_MF ON)
  else()
    set(LIVE_STREAM_WITH_MF OFF)
  endif()
endif()
# The Windows `live_stream` is the publisher on top of the Media Foundation encoder.
if(WIN32 AND LIVE_STREAM_WITH_WEBRTC AND NOT LIVE_STREAM_WITH_MF)
  message(STATUS "live-stream: LIVE_STREAM_WITH_WEBRTC turns LIVE_STREAM_WITH_MF on (Windows)")
  set(LIVE_STREAM_WITH_MF ON)
endif()

if(NOT TARGET helper_common)
  add_subdirectory(../helper-common helper-common)
endif()

# Pure modules: no platform or network dependency, used by tests on every platform.
add_library(live_stream_core STATIC
  src/h264_annexb.cpp
  src/bitrate_ladder.cpp
  src/viewer_offer_parse.cpp
  src/rgba_to_nv12.cpp
  src/yuv422_to_nv12.cpp
  src/nv12_scale.cpp
  src/frame_to_nv12.cpp
  src/mf_encoder_policy.cpp
)
target_include_directories(live_stream_core PUBLIC include)
target_compile_features(live_stream_core PUBLIC cxx_std_17)
target_link_libraries(live_stream_core PUBLIC helper_common)
if(WIN32)
  target_compile_definitions(live_stream_core PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

if(LIVE_STREAM_WITH_WEBRTC AND (APPLE OR WIN32))
  if(APPLE)
    enable_language(OBJCXX)
  endif()
  include(FetchContent)
  # libdatachannel (MPL-2.0), static, pinned. TLS via OpenSSL linked statically
  # (Homebrew openssl@3 on macOS, vcpkg x64-windows-static-md on Windows: no
  # extra dylib/DLL to sign; MbedTLS is not vendored by libdatachannel and would
  # need its own distribution).
  # Offline builds: set FETCHCONTENT_SOURCE_DIR_LIBDATACHANNEL.
  # plog (libdatachannel dep) still declares cmake_minimum_required < 3.5.
  set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)
  if(APPLE)
    if(NOT DEFINED OPENSSL_ROOT_DIR AND EXISTS "/opt/homebrew/opt/openssl@3")
      set(OPENSSL_ROOT_DIR "/opt/homebrew/opt/openssl@3" CACHE PATH "" FORCE)
    endif()
  else()
    # Static OpenSSL from the vcpkg manifest next to this file (vcpkg.json),
    # installed by scripts/prepare-windows-pgm-deps.ps1 into the gitignored
    # deps directory. Static libraries, dynamic CRT like every other helper.
    # No vcpkg toolchain file: only OPENSSL_ROOT_DIR points into the tree.
    if(NOT DEFINED OPENSSL_ROOT_DIR)
      if(DEFINED ENV{LIVE_STREAM_OPENSSL_ROOT})
        file(TO_CMAKE_PATH "$ENV{LIVE_STREAM_OPENSSL_ROOT}" LIVE_STREAM_OPENSSL_ROOT)
      else()
        set(LIVE_STREAM_OPENSSL_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/deps/vcpkg_installed/x64-windows-static-md")
      endif()
      set(OPENSSL_ROOT_DIR "${LIVE_STREAM_OPENSSL_ROOT}" CACHE PATH "" FORCE)
    endif()
    if(NOT EXISTS "${OPENSSL_ROOT_DIR}/include/openssl/ssl.h")
      message(FATAL_ERROR
        "live-stream: static OpenSSL not found at ${OPENSSL_ROOT_DIR}. "
        "Run scripts/prepare-windows-pgm-deps.ps1 (needs vcpkg), or set OPENSSL_ROOT_DIR / "
        "LIVE_STREAM_OPENSSL_ROOT to an x64-windows-static-md OpenSSL 3 tree.")
    endif()
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

  if(APPLE)
    add_library(live_stream STATIC
      src/vt_encoder.mm
      src/publisher.cpp
    )
    set_source_files_properties(src/vt_encoder.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
    target_include_directories(live_stream PUBLIC include)
    target_link_libraries(live_stream PUBLIC live_stream_core LibDataChannel::LibDataChannelStatic
      "-framework CoreMedia" "-framework CoreVideo" "-framework VideoToolbox" "-framework Foundation")
  else()
    # The Media Foundation encoder comes from live_stream_mf (block below): it
    # is compiled once and its opt-in gate stays in one place.
    add_library(live_stream STATIC
      src/publisher.cpp
    )
    target_include_directories(live_stream PUBLIC include)
    target_link_libraries(live_stream PUBLIC live_stream_core live_stream_mf LibDataChannel::LibDataChannelStatic
      mf mfplat mfuuid mfreadwrite ole32 ws2_32 crypt32 bcrypt iphlpapi)
  endif()

  if(LIVE_STREAM_BUILD_TESTS)
    if(APPLE)
      add_executable(vt_encoder_smoke_test tests/vt_encoder_smoke_test.mm)
      set_source_files_properties(tests/vt_encoder_smoke_test.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
      target_link_libraries(vt_encoder_smoke_test PRIVATE live_stream)
      add_test(NAME vt_encoder_smoke_test COMMAND vt_encoder_smoke_test)
      set_tests_properties(vt_encoder_smoke_test PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 60)
    endif()
    add_executable(webrtc_loopback_test tests/webrtc_loopback_test.cpp)
    target_link_libraries(webrtc_loopback_test PRIVATE live_stream)
    add_test(NAME webrtc_loopback_test COMMAND webrtc_loopback_test)
    set_tests_properties(webrtc_loopback_test PROPERTIES TIMEOUT 60)
  endif()
endif()

if(LIVE_STREAM_WITH_MF AND WIN32)
  # The encoder alone; with LIVE_STREAM_WITH_WEBRTC the publisher in `live_stream` links it.
  add_library(live_stream_mf STATIC
    src/mf_encoder.cpp
  )
  target_include_directories(live_stream_mf PUBLIC include)
  target_link_libraries(live_stream_mf PUBLIC live_stream_core mf mfplat mfuuid ole32)

  if(LIVE_STREAM_BUILD_TESTS)
    # In-test asynchronous MFT: event loop, credits, mailbox, forced keyframe, stream change, drain, shutdown.
    add_executable(mf_encoder_fake_mft_test tests/mf_encoder_fake_mft_test.cpp)
    target_include_directories(mf_encoder_fake_mft_test PRIVATE src)
    target_link_libraries(mf_encoder_fake_mft_test PRIVATE live_stream_mf)
    add_test(NAME mf_encoder_fake_mft_test COMMAND mf_encoder_fake_mft_test)
    set_tests_properties(mf_encoder_fake_mft_test PROPERTIES TIMEOUT 120)
    # Microsoft's software H.264 MFT behind the test seam: only ever part of this test binary.
    add_executable(mf_encoder_software_seam_test tests/mf_encoder_software_seam_test.cpp)
    target_include_directories(mf_encoder_software_seam_test PRIVATE src)
    target_link_libraries(mf_encoder_software_seam_test PRIVATE live_stream_mf)
    add_test(NAME mf_encoder_software_seam_test COMMAND mf_encoder_software_seam_test)
    set_tests_properties(mf_encoder_software_seam_test PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 120)
    # Real hardware MFT through the production factory; skips on machines without one.
    add_executable(mf_encoder_smoke_test tests/mf_encoder_smoke_test.cpp)
    target_link_libraries(mf_encoder_smoke_test PRIVATE live_stream_mf)
    add_test(NAME mf_encoder_smoke_test COMMAND mf_encoder_smoke_test)
    set_tests_properties(mf_encoder_smoke_test PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 120)
  endif()
endif()

if(LIVE_STREAM_BUILD_TESTS)
  foreach(live_test IN ITEMS h264_annexb_test bitrate_ladder_test rgba_to_nv12_test yuv422_to_nv12_test
    nv12_scale_test frame_to_nv12_test mf_encoder_policy_test)
    add_executable(${live_test} tests/${live_test}.cpp)
    target_link_libraries(${live_test} PRIVATE live_stream_core)
    add_test(NAME ${live_test} COMMAND ${live_test})
  endforeach()
endif()
