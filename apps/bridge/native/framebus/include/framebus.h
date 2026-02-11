#pragma once
#include <stdint.h>

#define FRAMEBUS_MAGIC_LE 0x46475242u /* "BRGF" in Little Endian */
#define FRAMEBUS_VERSION 1
#define FRAMEBUS_HEADER_SIZE 128

typedef enum FrameBusPixelFormat {
  FRAMEBUS_PIXELFORMAT_RGBA8 = 1,
  FRAMEBUS_PIXELFORMAT_BGRA8 = 2,
  FRAMEBUS_PIXELFORMAT_ARGB8 = 3,
} FrameBusPixelFormat;

#pragma pack(push, 1)
typedef struct FrameBusHeader {
  uint32_t magic;          /* 0x00 */
  uint16_t version;        /* 0x04 */
  uint16_t flags;          /* 0x06 */
  uint32_t header_size;    /* 0x08 */
  uint32_t width;          /* 0x0C */
  uint32_t height;         /* 0x10 */
  uint32_t fps;            /* 0x14 */
  uint32_t pixel_format;   /* 0x18 */
  uint32_t frame_size;     /* 0x1C */
  uint32_t slot_count;     /* 0x20 */
  uint32_t slot_stride;    /* 0x24 */
  uint64_t seq;            /* 0x28 */
  uint64_t last_write_ns;  /* 0x30 */
  uint8_t reserved[72];    /* 0x38 */
} FrameBusHeader;
#pragma pack(pop)

#if defined(__cplusplus)
static_assert(sizeof(FrameBusHeader) == FRAMEBUS_HEADER_SIZE,
              "FrameBusHeader size must be 128");
#else
_Static_assert(sizeof(FrameBusHeader) == FRAMEBUS_HEADER_SIZE,
              "FrameBusHeader size must be 128");
#endif
