/*
 * POSIX shared-memory reader for the broadify FrameBus.
 * Mirrors the header layout defined in native/framebus/include/framebus.h
 * and the writer behaviour of the native meeting-helper FrameBus producer.
 */
#include "framebus_reader.h"

#include <fcntl.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#define FRAMEBUS_MAGIC_LE 0x46475242u /* "BRGF" little endian */
#define FRAMEBUS_VERSION 1u
#define FRAMEBUS_HEADER_SIZE 128u
#define FRAMEBUS_PIXELFORMAT_RGBA8 1u

#pragma pack(push, 1)
typedef struct framebus_header {
  uint32_t magic;
  uint16_t version;
  uint16_t flags;
  uint32_t header_size;
  uint32_t width;
  uint32_t height;
  uint32_t fps;
  uint32_t pixel_format;
  uint32_t frame_size;
  uint32_t slot_count;
  uint32_t slot_stride;
  uint64_t seq;
  uint64_t last_write_ns;
  uint8_t reserved[72];
} framebus_header_t;
#pragma pack(pop)

struct framebus_reader {
  int fd;
  size_t map_size;
  uint8_t *base;
  const framebus_header_t *header;
};

static uint64_t load_seq(const framebus_header_t *header) {
  /* seq lives at a fixed offset; use an atomic load to pair with the
   * writer's publish ordering. */
  const _Atomic uint64_t *seq_ptr = (const _Atomic uint64_t *)&header->seq;
  return atomic_load_explicit(seq_ptr, memory_order_acquire);
}

framebus_reader_t *framebus_reader_open(const char *name) {
  if (name == NULL || name[0] == '\0') {
    return NULL;
  }

  char shm_name[256];
  if (name[0] == '/') {
    snprintf(shm_name, sizeof(shm_name), "%s", name);
  } else {
    snprintf(shm_name, sizeof(shm_name), "/%s", name);
  }

  int fd = shm_open(shm_name, O_RDONLY, 0);
  if (fd < 0) {
    return NULL;
  }

  struct stat st;
  if (fstat(fd, &st) != 0 || (size_t)st.st_size < FRAMEBUS_HEADER_SIZE) {
    close(fd);
    return NULL;
  }

  size_t map_size = (size_t)st.st_size;
  uint8_t *base = mmap(NULL, map_size, PROT_READ, MAP_SHARED, fd, 0);
  if (base == MAP_FAILED) {
    close(fd);
    return NULL;
  }

  const framebus_header_t *header = (const framebus_header_t *)base;
  if (header->magic != FRAMEBUS_MAGIC_LE || header->version != FRAMEBUS_VERSION ||
      header->header_size != FRAMEBUS_HEADER_SIZE ||
      header->pixel_format != FRAMEBUS_PIXELFORMAT_RGBA8 ||
      header->slot_count == 0 || header->slot_stride < header->frame_size ||
      FRAMEBUS_HEADER_SIZE + (size_t)header->slot_count * header->slot_stride > map_size) {
    munmap(base, map_size);
    close(fd);
    return NULL;
  }

  framebus_reader_t *reader = calloc(1, sizeof(framebus_reader_t));
  if (reader == NULL) {
    munmap(base, map_size);
    close(fd);
    return NULL;
  }

  reader->fd = fd;
  reader->map_size = map_size;
  reader->base = base;
  reader->header = header;
  return reader;
}

void framebus_reader_close(framebus_reader_t *reader) {
  if (reader == NULL) {
    return;
  }
  if (reader->base != NULL) {
    munmap(reader->base, reader->map_size);
  }
  if (reader->fd >= 0) {
    close(reader->fd);
  }
  free(reader);
}

int framebus_reader_get_info(const framebus_reader_t *reader,
                             uint32_t *width,
                             uint32_t *height,
                             uint32_t *fps) {
  if (reader == NULL || reader->header == NULL) {
    return -1;
  }
  if (width != NULL) {
    *width = reader->header->width;
  }
  if (height != NULL) {
    *height = reader->header->height;
  }
  if (fps != NULL) {
    *fps = reader->header->fps;
  }
  return 0;
}

uint64_t framebus_reader_seq(const framebus_reader_t *reader) {
  if (reader == NULL || reader->header == NULL) {
    return 0;
  }
  return load_seq(reader->header);
}

int framebus_reader_copy_latest_bgra(framebus_reader_t *reader,
                                     uint8_t *dst,
                                     size_t dst_stride,
                                     uint64_t *last_seq) {
  if (reader == NULL || reader->header == NULL || dst == NULL || last_seq == NULL) {
    return -1;
  }

  const framebus_header_t *header = reader->header;
  const size_t row_bytes = (size_t)header->width * 4u;
  if (dst_stride < row_bytes) {
    return -1;
  }

  uint64_t seq = load_seq(header);
  if (seq == 0 || seq <= *last_seq) {
    return 0;
  }

  const uint32_t slot_index = (uint32_t)((seq - 1) % header->slot_count);
  const uint8_t *src =
      reader->base + FRAMEBUS_HEADER_SIZE + (size_t)slot_index * header->slot_stride;

  for (uint32_t y = 0; y < header->height; y++) {
    const uint8_t *src_row = src + (size_t)y * row_bytes;
    uint8_t *dst_row = dst + (size_t)y * dst_stride;
    for (uint32_t x = 0; x < header->width; x++) {
      const uint8_t r = src_row[x * 4 + 0];
      const uint8_t g = src_row[x * 4 + 1];
      const uint8_t b = src_row[x * 4 + 2];
      const uint8_t a = src_row[x * 4 + 3];
      dst_row[x * 4 + 0] = b;
      dst_row[x * 4 + 1] = g;
      dst_row[x * 4 + 2] = r;
      dst_row[x * 4 + 3] = a;
    }
  }

  /* Detect a torn read: the writer may have lapped this slot meanwhile. */
  const uint64_t seq_after = load_seq(header);
  if (seq_after >= seq + header->slot_count) {
    return -2;
  }

  *last_seq = seq;
  return 1;
}

int framebus_reader_copy_latest_rgba(framebus_reader_t *reader,
                                     uint8_t *dst,
                                     size_t dst_stride,
                                     uint64_t *last_seq) {
  if (reader == NULL || reader->header == NULL || dst == NULL || last_seq == NULL) {
    return -1;
  }

  const framebus_header_t *header = reader->header;
  const size_t row_bytes = (size_t)header->width * 4u;
  if (dst_stride < row_bytes) {
    return -1;
  }

  uint64_t seq = load_seq(header);
  if (seq == 0 || seq <= *last_seq) {
    return 0;
  }

  const uint32_t slot_index = (uint32_t)((seq - 1) % header->slot_count);
  const uint8_t *src =
      reader->base + FRAMEBUS_HEADER_SIZE + (size_t)slot_index * header->slot_stride;

  for (uint32_t y = 0; y < header->height; y++) {
    memcpy(dst + (size_t)y * dst_stride, src + (size_t)y * row_bytes, row_bytes);
  }

  const uint64_t seq_after = load_seq(header);
  if (seq_after >= seq + header->slot_count) {
    return -2;
  }

  *last_seq = seq;
  return 1;
}
