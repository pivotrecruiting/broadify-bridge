#include "live/program_stream.h"

#include <string>

namespace broadify::meeting {

// Platforms without the shared hardware encoder path (Windows until the Media
// Foundation encoder ships): the stream reports itself unsupported.
struct ProgramStream::Impl {};

ProgramStream::ProgramStream(PreviewFrameStore &, MeetingState &, ProgramStreamConfig) : impl_(nullptr) {}
ProgramStream::~ProgramStream() = default;
void ProgramStream::start() {}
void ProgramStream::stop() {}
bool ProgramStream::supported() const { return false; }
std::string ProgramStream::viewerOffer(const live::ViewerOfferRequest &) {
  throw live::RpcFailure{"program_stream_unavailable", "The program stream is not available on this platform yet."};
}
void ProgramStream::viewerClose(const std::string &) {}
size_t ProgramStream::viewerCount() const { return 0; }
std::string ProgramStream::sessionsJson() const { return "[]"; }
std::string ProgramStream::statusJson() const {
  return "{\"supported\":false,\"active\":false,\"viewers\":0,\"encoder\":null,\"encoded_frames\":0,\"dropped_frames\":0}";
}

}  // namespace broadify::meeting
