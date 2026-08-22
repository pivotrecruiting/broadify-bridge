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

  std::cout << "shm_frame_reader_no_frame_test passed\n";
  return 0;
}
