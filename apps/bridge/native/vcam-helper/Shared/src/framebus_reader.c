/*
 * Shared-memory reader for the broadify FrameBus.
 * Mirrors the header layout defined in native/framebus/include/framebus.h
 * and the writer behaviour of the native meeting-helper FrameBus producer.
 */
#include "framebus_reader.h"

#include "framebus_atomic.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

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
  size_t map_size;
  uint8_t *base;
  const framebus_header_t *header;
#if defined(_WIN32)
  HANDLE mapping;
#else
  int fd;
#endif
};

static uint64_t load_seq(const framebus_header_t *header) {
  return framebus_atomic_load_u64(&header->seq);
}

#if defined(_WIN32)
static void normalize_mapping_name(const char *name, char *out, size_t out_size) {
  char sanitized[256];
  size_t write_index = 0;
  for (size_t read_index = 0; name[read_index] != '\0' && write_index + 1 < sizeof(sanitized);
       read_index++) {
    if (name[read_index] == '/' || name[read_index] == '\\') {
      continue;
    }
    sanitized[write_index++] = name[read_index];
  }
  sanitized[write_index] = '\0';
  if (write_index == 0) {
    out[0] = '\0';
    return;
  }
  snprintf(out, out_size, "Local\\%s", sanitized);
}
#else
static void normalize_mapping_name(const char *name, char *out, size_t out_size) {
  if (name[0] == '/') {
    snprintf(out, out_size, "%s", name);
    return;
  }
  snprintf(out, out_size, "/%s", name);
}
#endif

static int validate_header(const framebus_header_t *header, size_t map_size) {
  if (header == NULL) {
    return -1;
  }

  const size_t slots_size = (size_t)header->slot_count * (size_t)header->slot_stride;
  if (header->slot_count != 0 && slots_size / header->slot_count != header->slot_stride) {
    return -1;
  }
  if (FRAMEBUS_HEADER_SIZE > SIZE_MAX - slots_size) {
    return -1;
  }

  if (header->magic != FRAMEBUS_MAGIC_LE || header->version != FRAMEBUS_VERSION ||
      header->header_size != FRAMEBUS_HEADER_SIZE ||
      header->pixel_format != FRAMEBUS_PIXELFORMAT_RGBA8 ||
      header->slot_count == 0 || header->slot_stride < header->frame_size ||
      FRAMEBUS_HEADER_SIZE + slots_size > map_size) {
    return -1;
  }

  return 0;
}

framebus_reader_t *framebus_reader_open(const char *name) {
  if (name == NULL || name[0] == '\0') {
    return NULL;
  }

  char mapping_name[256];
  normalize_mapping_name(name, mapping_name, sizeof(mapping_name));
  if (mapping_name[0] == '\0') {
    return NULL;
  }

#if defined(_WIN32)
  HANDLE mapping = OpenFileMappingA(FILE_MAP_READ, FALSE, mapping_name);
  if (mapping == NULL) {
    return NULL;
  }

  uint8_t *base = (uint8_t *)MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
  if (base == NULL) {
    CloseHandle(mapping);
    return NULL;
  }

  const framebus_header_t *header = (const framebus_header_t *)base;
  const size_t map_size =
      FRAMEBUS_HEADER_SIZE + (size_t)header->slot_count * (size_t)header->slot_stride;
  if (validate_header(header, map_size) != 0) {
    UnmapViewOfFile(base);
    CloseHandle(mapping);
    return NULL;
  }
#else
  int fd = shm_open(mapping_name, O_RDONLY, 0);
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
  if (validate_header(header, map_size) != 0) {
    munmap(base, map_size);
    close(fd);
    return NULL;
  }
#endif

  framebus_reader_t *reader = calloc(1, sizeof(framebus_reader_t));
  if (reader == NULL) {
#if defined(_WIN32)
    UnmapViewOfFile(base);
    CloseHandle(mapping);
#else
    munmap(base, map_size);
    close(fd);
#endif
    return NULL;
  }

  reader->map_size = map_size;
  reader->base = base;
  reader->header = header;
#if defined(_WIN32)
  reader->mapping = mapping;
#else
  reader->fd = fd;
#endif
  return reader;
}

void framebus_reader_close(framebus_reader_t *reader) {
  if (reader == NULL) {
    return;
  }
#if defined(_WIN32)
  if (reader->base != NULL) {
    UnmapViewOfFile(reader->base);
  }
  if (reader->mapping != NULL) {
    CloseHandle(reader->mapping);
  }
#else
  if (reader->base != NULL) {
    munmap(reader->base, reader->map_size);
  }
  if (reader->fd >= 0) {
    close(reader->fd);
  }
#endif
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
