/*
 * FrameBus shared-memory reader for the broadify virtual camera helper.
 *
 * Layout (see ../../framebus/include/framebus.h):
 *   - 128 byte header (magic "BRGF", version 1)
 *   - N frame slots of width*height*4 bytes (RGBA8) after the header
 *
 * The writer publishes a frame into slot (seq % slot_count) and then
 * increments seq. The latest complete frame therefore lives in slot
 * ((seq - 1) % slot_count).
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct framebus_reader framebus_reader_t;

/*
 * Open an existing FrameBus shared-memory segment by name.
 * The name matches the writer's segment name (leading '/' optional).
 * Returns NULL when the segment does not exist or the header is invalid.
 */
framebus_reader_t *framebus_reader_open(const char *name);

void framebus_reader_close(framebus_reader_t *reader);

/* Returns 0 on success, -1 when the reader is invalid. */
int framebus_reader_get_info(const framebus_reader_t *reader,
                             uint32_t *width,
                             uint32_t *height,
                             uint32_t *fps);

/* Current sequence number (0 = no frame written yet). */
uint64_t framebus_reader_seq(const framebus_reader_t *reader);

/*
 * Copy the latest frame into dst, converting RGBA8 -> BGRA8.
 *
 * dst must hold at least height * dst_stride bytes and dst_stride must be
 * >= width * 4. last_seq is an in/out cursor: the call only copies when a
 * newer frame than *last_seq exists and updates *last_seq on success.
 *
 * Returns:
 *    1  frame copied
 *    0  no new frame available
 *   -1  invalid arguments / reader
 *   -2  torn frame (writer overran the reader; caller may retry)
 */
int framebus_reader_copy_latest_bgra(framebus_reader_t *reader,
                                     uint8_t *dst,
                                     size_t dst_stride,
                                     uint64_t *last_seq);

/*
 * Copy the latest frame into dst as RGBA8.
 *
 * Return values match framebus_reader_copy_latest_bgra.
 */
int framebus_reader_copy_latest_rgba(framebus_reader_t *reader,
                                     uint8_t *dst,
                                     size_t dst_stride,
                                     uint64_t *last_seq);

#ifdef __cplusplus
}
#endif
