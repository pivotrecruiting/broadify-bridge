#include "framebus_writer.h"

#include "framebus.h"

#include <stdatomic.h>
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

struct framebus_writer {
  size_t map_size;
  uint8_t *base;
  FrameBusHeader *header;
#if defined(_WIN32)
  HANDLE mapping;
#else
  int fd;
  char shm_name[256];
  int created;
#endif
};

static uint64_t load_seq(const FrameBusHeader *header) {
  const _Atomic uint64_t *seq_ptr = (const _Atomic uint64_t *)&header->seq;
  return atomic_load_explicit(seq_ptr, memory_order_acquire);
}

static void store_u64(uint64_t *target, uint64_t value) {
  _Atomic uint64_t *ptr = (_Atomic uint64_t *)target;
  atomic_store_explicit(ptr, value, memory_order_release);
}

static int init_header(FrameBusHeader *header,
                       uint32_t width,
                       uint32_t height,
                       uint32_t fps,
                       uint32_t slot_count) {
  if (header == NULL || width == 0 || height == 0 || fps == 0 || slot_count < 2) {
    return -1;
  }

  const uint32_t frame_size = width * height * 4u;
  memset(header, 0, FRAMEBUS_HEADER_SIZE);
  header->magic = FRAMEBUS_MAGIC_LE;
  header->version = FRAMEBUS_VERSION;
  header->flags = 0;
  header->header_size = FRAMEBUS_HEADER_SIZE;
  header->width = width;
  header->height = height;
  header->fps = fps;
  header->pixel_format = FRAMEBUS_PIXELFORMAT_RGBA8;
  header->frame_size = frame_size;
  header->slot_count = slot_count;
  header->slot_stride = frame_size;
  header->seq = 0;
  header->last_write_ns = 0;
  return 0;
}

#if !defined(_WIN32)
static void normalize_shm_name(const char *name, char *out, size_t out_size) {
  if (name[0] == '/') {
    snprintf(out, out_size, "%s", name);
    return;
  }
  snprintf(out, out_size, "/%s", name);
}
#endif

framebus_writer_t *framebus_writer_open(const char *name,
                                        uint32_t width,
                                        uint32_t height,
                                        uint32_t fps,
                                        uint32_t slot_count) {
  if (name == NULL || name[0] == '\0' || width == 0 || height == 0 || fps == 0) {
    return NULL;
  }

  const size_t frame_size = (size_t)width * (size_t)height * 4u;
  const size_t map_size = FRAMEBUS_HEADER_SIZE + frame_size * (size_t)slot_count;
  framebus_writer_t *writer = (framebus_writer_t *)calloc(1, sizeof(framebus_writer_t));
  if (writer == NULL) {
    return NULL;
  }
  writer->map_size = map_size;

#if defined(_WIN32)
  writer->mapping = CreateFileMappingA(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE,
                                       (DWORD)((map_size >> 32u) & 0xffffffffu),
                                       (DWORD)(map_size & 0xffffffffu), name);
  if (writer->mapping == NULL) {
    free(writer);
    return NULL;
  }
  writer->base = (uint8_t *)MapViewOfFile(writer->mapping, FILE_MAP_ALL_ACCESS, 0, 0, map_size);
  if (writer->base == NULL) {
    CloseHandle(writer->mapping);
    free(writer);
    return NULL;
  }
#else
  normalize_shm_name(name, writer->shm_name, sizeof(writer->shm_name));
  shm_unlink(writer->shm_name);
  writer->fd = shm_open(writer->shm_name, O_CREAT | O_EXCL | O_RDWR, 0600);
  if (writer->fd < 0) {
    free(writer);
    return NULL;
  }
  writer->created = 1;
  if (ftruncate(writer->fd, (off_t)map_size) != 0) {
    close(writer->fd);
    shm_unlink(writer->shm_name);
    free(writer);
    return NULL;
  }
  writer->base = (uint8_t *)mmap(NULL, map_size, PROT_READ | PROT_WRITE, MAP_SHARED, writer->fd, 0);
  if (writer->base == MAP_FAILED) {
    close(writer->fd);
    shm_unlink(writer->shm_name);
    free(writer);
    return NULL;
  }
#endif

  writer->header = (FrameBusHeader *)writer->base;
  if (init_header(writer->header, width, height, fps, slot_count) != 0) {
    framebus_writer_close(writer);
    return NULL;
  }
  return writer;
}

void framebus_writer_close(framebus_writer_t *writer) {
  if (writer == NULL) {
    return;
  }
#if defined(_WIN32)
  if (writer->base != NULL) {
    UnmapViewOfFile(writer->base);
  }
  if (writer->mapping != NULL) {
    CloseHandle(writer->mapping);
  }
#else
  if (writer->base != NULL && writer->base != MAP_FAILED) {
    munmap(writer->base, writer->map_size);
  }
  if (writer->fd >= 0) {
    close(writer->fd);
  }
  if (writer->created) {
    shm_unlink(writer->shm_name);
  }
#endif
  free(writer);
}

int framebus_writer_get_info(const framebus_writer_t *writer,
                             framebus_writer_info_t *info) {
  if (writer == NULL || writer->header == NULL || info == NULL) {
    return -1;
  }
  info->width = writer->header->width;
  info->height = writer->header->height;
  info->fps = writer->header->fps;
  info->slot_count = writer->header->slot_count;
  info->seq = load_seq(writer->header);
  return 0;
}

int framebus_writer_write_rgba(framebus_writer_t *writer,
                               const uint8_t *rgba,
                               size_t rgba_size,
                               uint64_t timestamp_ns) {
  if (writer == NULL || writer->header == NULL || rgba == NULL) {
    return -1;
  }
  FrameBusHeader *header = writer->header;
  if (rgba_size != header->frame_size || header->slot_count == 0) {
    return -1;
  }

  const uint64_t seq = load_seq(header);
  const uint32_t slot_index = (uint32_t)(seq % header->slot_count);
  uint8_t *slot = writer->base + FRAMEBUS_HEADER_SIZE + (size_t)slot_index * header->slot_stride;
  memcpy(slot, rgba, rgba_size);
  store_u64(&header->last_write_ns, timestamp_ns);
  store_u64(&header->seq, seq + 1u);
  return 0;
}
