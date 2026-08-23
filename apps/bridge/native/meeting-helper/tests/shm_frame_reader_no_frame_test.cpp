#include "../../vcam-helper/windows/shm_frame_reader.h"

#include <cstdlib>
#include <iostream>

#define CHECK(expr)                                                     \
  do {                                                                  \
    if (!(expr)) {                                                       \
      std::cerr << "CHECK failed at " << __FILE__ << ":" << __LINE__    \
                << ": " << #expr << "\n";                              \
      std::abort();                                                      \
    }                                                                   \
  } while (0)

int main() {
  using broadify::vcam::ShmFrameReader;

  CHECK(!ShmFrameReader::NoFrameDeadlineExpired(false, 0, 3000));
  CHECK(!ShmFrameReader::NoFrameDeadlineExpired(true, 1000, 4000));
  CHECK(!ShmFrameReader::NoFrameDeadlineExpired(false, 1000, 2999));
  CHECK(ShmFrameReader::NoFrameDeadlineExpired(false, 1000, 3000));
  CHECK(ShmFrameReader::NoFrameDeadlineExpired(false, 1000, 4500));
  CHECK(ShmFrameReader::RetryDelayMsForReason("control_mapping_absent") == 1000);
  CHECK(ShmFrameReader::RetryDelayMsForReason("invalid_stream_header") == 1000);
  CHECK(ShmFrameReader::RetryDelayMsForReason("shm_no_frame_after_open") == 5000);
  CHECK(ShmFrameReader::RetryDelayMsForReason("shm_heartbeat_stale") == 5000);

  std::cout << "shm_frame_reader_no_frame_test passed\n";
  return 0;
}
