#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct framebus_writer framebus_writer_t;

typedef struct framebus_writer_info {
  uint32_t width;
  uint32_t height;
  uint32_t fps;
  uint32_t slot_count;
  uint64_t seq;
} framebus_writer_info_t;

framebus_writer_t *framebus_writer_open(const char *name,
                                        uint32_t width,
                                        uint32_t height,
                                        uint32_t fps,
                                        uint32_t slot_count);

void framebus_writer_close(framebus_writer_t *writer);

int framebus_writer_get_info(const framebus_writer_t *writer,
                             framebus_writer_info_t *info);

int framebus_writer_write_rgba(framebus_writer_t *writer,
                               const uint8_t *rgba,
                               size_t rgba_size,
                               uint64_t timestamp_ns);

#ifdef __cplusplus
}
#endif
