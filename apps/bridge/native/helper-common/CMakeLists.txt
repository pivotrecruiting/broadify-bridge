# helper-common: code shared by the native helpers (meeting-helper, pgm-helper).
# Stdlib + OS primitives only - no SDKs, no media frameworks - so every helper
# and every test can link it on macOS and Windows without extra dependencies.
cmake_minimum_required(VERSION 3.22)

if(NOT DEFINED PROJECT_NAME)
  project(broadify_helper_common LANGUAGES C CXX)
  set(CMAKE_CXX_STANDARD 17)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
  enable_testing()
endif()

if(NOT DEFINED HELPER_COMMON_BUILD_TESTS)
  if(DEFINED ENV{HELPER_COMMON_BUILD_TESTS})
    set(HELPER_COMMON_BUILD_TESTS "$ENV{HELPER_COMMON_BUILD_TESTS}")
  elseif(DEFINED MEETING_HELPER_BUILD_TESTS)
    set(HELPER_COMMON_BUILD_TESTS "${MEETING_HELPER_BUILD_TESTS}")
  else()
    set(HELPER_COMMON_BUILD_TESTS "1")
  endif()
endif()

add_library(helper_common STATIC
  src/rpc_transport.cpp
)
target_include_directories(helper_common PUBLIC include)
target_compile_features(helper_common PUBLIC cxx_std_17)
if(WIN32)
  target_compile_definitions(helper_common PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
else()
  find_package(Threads REQUIRED)
  target_link_libraries(helper_common PUBLIC Threads::Threads)
endif()

if(HELPER_COMMON_BUILD_TESTS)
  add_executable(rpc_transport_test tests/rpc_transport_test.cpp)
  target_link_libraries(rpc_transport_test PRIVATE helper_common)
  if(WIN32)
    target_compile_definitions(rpc_transport_test PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  endif()
  add_test(NAME rpc_transport_test COMMAND rpc_transport_test)
endif()
