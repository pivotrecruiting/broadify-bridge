/*
  Display Helper (macOS)

  Reads RGBA frames from FrameBus shared memory and displays fullscreen via SDL2.
  No Electron, no IPC for frame data.
*/

#include "framebus.h"

#include <SDL.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <iostream>
#include <string>
#include <thread>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>

namespace {

std::atomic<bool> gShouldExit{false};

struct FrameBusReader {
  int fd = -1;
  uint8_t* base = nullptr;
  size_t size = 0;
  FrameBusHeader* header = nullptr;
  uint8_t* slots = nullptr;
};

uint64_t atomicLoad64(uint64_t* ptr) {
  return __atomic_load_n(ptr, __ATOMIC_ACQUIRE);
}

bool openFrameBusReader(const std::string& name, FrameBusReader& out, std::string& error) {
  if (name.empty()) {
    error = "FrameBus name is empty";
    return false;
  }
  std::string shmName = name;
  if (shmName[0] != '/') {
    shmName = "/" + shmName;
  }

  const int fd = shm_open(shmName.c_str(), O_RDWR, 0600);
  if (fd < 0) {
    error = "Failed to open FrameBus shared memory";
    return false;
  }

  struct stat st;
  if (fstat(fd, &st) != 0) {
    close(fd);
    error = "Failed to stat FrameBus shared memory";
    return false;
  }

  size_t totalSize = static_cast<size_t>(st.st_size);
  if (totalSize < FRAMEBUS_HEADER_SIZE) {
    close(fd);
    error = "FrameBus shared memory too small";
    return false;
  }

  void* base = mmap(nullptr, totalSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (base == MAP_FAILED) {
    close(fd);
    error = "Failed to map FrameBus shared memory";
    return false;
  }

  auto* header = static_cast<FrameBusHeader*>(base);
  if (header->magic != FRAMEBUS_MAGIC_LE || header->header_size != FRAMEBUS_HEADER_SIZE) {
    munmap(base, totalSize);
    close(fd);
    error = "FrameBus header invalid";
    return false;
  }

  out.fd = fd;
  out.base = static_cast<uint8_t*>(base);
  out.size = totalSize;
  out.header = header;
  out.slots = out.base + FRAMEBUS_HEADER_SIZE;
  return true;
}

void closeFrameBusReader(FrameBusReader& reader) {
  if (reader.base && reader.size > 0) {
    munmap(reader.base, reader.size);
  }
  if (reader.fd >= 0) {
    close(reader.fd);
  }
  reader.fd = -1;
  reader.base = nullptr;
  reader.size = 0;
  reader.header = nullptr;
  reader.slots = nullptr;
}

void signalHandler(int) {
  gShouldExit.store(true);
}

}  // namespace

int main(int argc, char* argv[]) {
  std::string frameBusName;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fps = 60;
  int displayIndex = 0;

  // Parse CLI args
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--framebus-name" && i + 1 < argc) {
      frameBusName = argv[++i];
    } else if (arg == "--width" && i + 1 < argc) {
      width = static_cast<uint32_t>(std::atoi(argv[++i]));
    } else if (arg == "--height" && i + 1 < argc) {
      height = static_cast<uint32_t>(std::atoi(argv[++i]));
    } else if (arg == "--fps" && i + 1 < argc) {
      fps = static_cast<uint32_t>(std::atoi(argv[++i]));
    } else if (arg == "--display-index" && i + 1 < argc) {
      displayIndex = std::atoi(argv[++i]);
    }
  }

  // Fallback to env
  if (frameBusName.empty()) {
    const char* env = std::getenv("BRIDGE_FRAMEBUS_NAME");
    if (env) frameBusName = env;
  }
  if (width == 0) {
    const char* env = std::getenv("BRIDGE_FRAME_WIDTH");
    if (env) width = static_cast<uint32_t>(std::atoi(env));
  }
  if (height == 0) {
    const char* env = std::getenv("BRIDGE_FRAME_HEIGHT");
    if (env) height = static_cast<uint32_t>(std::atoi(env));
  }
  if (fps == 0) {
    const char* env = std::getenv("BRIDGE_FRAME_FPS");
    if (env) fps = static_cast<uint32_t>(std::atoi(env));
  }
  if (fps == 0) fps = 60;

  if (frameBusName.empty()) {
    std::cerr << "Display Helper: framebus name required (--framebus-name or BRIDGE_FRAMEBUS_NAME)" << std::endl;
    return 1;
  }
  if (width == 0 || height == 0) {
    std::cerr << "Display Helper: width and height required (--width/--height or env)" << std::endl;
    return 1;
  }

  signal(SIGTERM, signalHandler);
  signal(SIGINT, signalHandler);

  FrameBusReader reader;
  std::string fbError;
  if (!openFrameBusReader(frameBusName, reader, fbError)) {
    std::cerr << "FrameBus open failed: " << fbError << std::endl;
    return 1;
  }

  if (reader.header->width != width || reader.header->height != height) {
    std::cerr << "FrameBus size mismatch: expected " << width << "x" << height
              << " got " << reader.header->width << "x" << reader.header->height << std::endl;
    closeFrameBusReader(reader);
    return 1;
  }
  if (reader.header->pixel_format != FRAMEBUS_PIXELFORMAT_RGBA8) {
    std::cerr << "FrameBus pixel format mismatch (expected RGBA8)" << std::endl;
    closeFrameBusReader(reader);
    return 1;
  }

  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    std::cerr << "SDL_Init failed: " << SDL_GetError() << std::endl;
    closeFrameBusReader(reader);
    return 1;
  }

  const int numDisplays = SDL_GetNumVideoDisplays();
  if (displayIndex < 0 || displayIndex >= numDisplays) {
    displayIndex = 0;
  }

  SDL_Rect displayBounds;
  if (SDL_GetDisplayBounds(displayIndex, &displayBounds) != 0) {
    std::cerr << "SDL_GetDisplayBounds failed: " << SDL_GetError() << std::endl;
    SDL_Quit();
    closeFrameBusReader(reader);
    return 1;
  }

  SDL_Window* window = SDL_CreateWindow(
    "Broadify Display Output",
    displayBounds.x, displayBounds.y,
    displayBounds.w, displayBounds.h,
    SDL_WINDOW_FULLSCREEN | SDL_WINDOW_SHOWN
  );
  if (!window) {
    std::cerr << "SDL_CreateWindow failed: " << SDL_GetError() << std::endl;
    SDL_Quit();
    closeFrameBusReader(reader);
    return 1;
  }

  SDL_Renderer* renderer = SDL_CreateRenderer(
    window, -1,
    SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC
  );
  if (!renderer) {
    std::cerr << "SDL_CreateRenderer failed: " << SDL_GetError() << std::endl;
    SDL_DestroyWindow(window);
    SDL_Quit();
    closeFrameBusReader(reader);
    return 1;
  }

  SDL_Texture* texture = SDL_CreateTexture(
    renderer,
    SDL_PIXELFORMAT_RGBA32,
    SDL_TEXTUREACCESS_STREAMING,
    static_cast<int>(width),
    static_cast<int>(height)
  );
  if (!texture) {
    std::cerr << "SDL_CreateTexture failed: " << SDL_GetError() << std::endl;
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    closeFrameBusReader(reader);
    return 1;
  }

  std::cout << "{\"type\":\"ready\"}" << std::endl;
  std::cout.flush();

  const size_t frameSize = reader.header->frame_size;
  uint64_t lastSeq = 0;
  const std::chrono::milliseconds frameInterval(fps > 0 ? std::max(1, 1000 / static_cast<int>(fps)) : 16);
  auto nextFrameAt = std::chrono::steady_clock::now();

  while (!gShouldExit.load()) {
    const uint64_t seq = atomicLoad64(&reader.header->seq);
    if (seq == 0 || seq == lastSeq) {
      SDL_Event e;
      while (SDL_PollEvent(&e)) {
        if (e.type == SDL_QUIT) gShouldExit.store(true);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      continue;
    }
    lastSeq = seq;

    const uint32_t slotIndex = static_cast<uint32_t>((seq - 1) % reader.header->slot_count);
    const uint8_t* slotPtr = reader.slots + (static_cast<size_t>(slotIndex) * reader.header->slot_stride);

    void* texPixels = nullptr;
    int texPitch = 0;
    if (SDL_LockTexture(texture, nullptr, &texPixels, &texPitch) == 0) {
      const size_t srcRowBytes = width * 4;
      if (static_cast<size_t>(texPitch) == srcRowBytes) {
        std::memcpy(texPixels, slotPtr, frameSize);
      } else {
        for (uint32_t y = 0; y < height; ++y) {
          std::memcpy(
            static_cast<uint8_t*>(texPixels) + y * static_cast<size_t>(texPitch),
            slotPtr + y * srcRowBytes,
            srcRowBytes
          );
        }
      }
      SDL_UnlockTexture(texture);
    }

    SDL_RenderClear(renderer);
    SDL_RenderCopy(renderer, texture, nullptr, nullptr);
    SDL_RenderPresent(renderer);

    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_QUIT) gShouldExit.store(true);
    }

    nextFrameAt += frameInterval;
    auto now = std::chrono::steady_clock::now();
    if (now < nextFrameAt) {
      std::this_thread::sleep_until(nextFrameAt);
    } else {
      nextFrameAt = now;
    }
  }

  SDL_DestroyTexture(texture);
  SDL_DestroyRenderer(renderer);
  SDL_DestroyWindow(window);
  SDL_Quit();
  closeFrameBusReader(reader);

  return 0;
}
