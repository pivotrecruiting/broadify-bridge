#include <node_api.h>
#include <stdint.h>
#include <string.h>

#include <string>

#include "framebus.h"

#if defined(_WIN32)
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {

struct FrameBusHandle {
  bool is_writer;
  std::string name;
  size_t size;
#if defined(_WIN32)
  HANDLE map_handle;
#else
  int fd;
#endif
  uint8_t* base;
  FrameBusHeader* header;
  uint8_t* slots;
};

napi_value ThrowError(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

bool GetString(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  napi_status status = napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  if (status != napi_ok) {
    return false;
  }
  std::string buffer;
  buffer.resize(length);
  status = napi_get_value_string_utf8(env, value, buffer.data(), buffer.size() + 1, &length);
  if (status != napi_ok) {
    return false;
  }
  *out = buffer;
  return true;
}

bool GetUint32(napi_env env, napi_value value, uint32_t* out) {
  napi_status status = napi_get_value_uint32(env, value, out);
  return status == napi_ok;
}

bool GetOptionalBigint(napi_env env, napi_value value, uint64_t* out, bool* has_value) {
  bool lossless = false;
  napi_status status = napi_get_value_bigint_uint64(env, value, out, &lossless);
  if (status == napi_ok && lossless) {
    *has_value = true;
    return true;
  }
  *has_value = false;
  return true;
}

uint64_t AtomicLoad64(uint64_t* ptr) {
#if defined(_MSC_VER)
  return static_cast<uint64_t>(__atomic_load_n(ptr, __ATOMIC_ACQUIRE));
#else
  return __atomic_load_n(ptr, __ATOMIC_ACQUIRE);
#endif
}

void AtomicStore64(uint64_t* ptr, uint64_t value) {
#if defined(_MSC_VER)
  __atomic_store_n(ptr, value, __ATOMIC_RELEASE);
#else
  __atomic_store_n(ptr, value, __ATOMIC_RELEASE);
#endif
}

napi_value BuildHeaderObject(napi_env env, const FrameBusHeader* header) {
  napi_value result;
  napi_create_object(env, &result);

  napi_value magic;
  napi_create_uint32(env, header->magic, &magic);
  napi_set_named_property(env, result, "magic", magic);

  napi_value version;
  napi_create_uint32(env, header->version, &version);
  napi_set_named_property(env, result, "version", version);

  napi_value flags;
  napi_create_uint32(env, header->flags, &flags);
  napi_set_named_property(env, result, "flags", flags);

  napi_value header_size;
  napi_create_uint32(env, header->header_size, &header_size);
  napi_set_named_property(env, result, "headerSize", header_size);

  napi_value width;
  napi_create_uint32(env, header->width, &width);
  napi_set_named_property(env, result, "width", width);

  napi_value height;
  napi_create_uint32(env, header->height, &height);
  napi_set_named_property(env, result, "height", height);

  napi_value fps;
  napi_create_uint32(env, header->fps, &fps);
  napi_set_named_property(env, result, "fps", fps);

  napi_value pixel_format;
  napi_create_uint32(env, header->pixel_format, &pixel_format);
  napi_set_named_property(env, result, "pixelFormat", pixel_format);

  napi_value frame_size;
  napi_create_uint32(env, header->frame_size, &frame_size);
  napi_set_named_property(env, result, "frameSize", frame_size);

  napi_value slot_count;
  napi_create_uint32(env, header->slot_count, &slot_count);
  napi_set_named_property(env, result, "slotCount", slot_count);

  napi_value slot_stride;
  napi_create_uint32(env, header->slot_stride, &slot_stride);
  napi_set_named_property(env, result, "slotStride", slot_stride);

  napi_value seq;
  napi_create_bigint_uint64(env, AtomicLoad64(const_cast<uint64_t*>(&header->seq)), &seq);
  napi_set_named_property(env, result, "seq", seq);

  napi_value last_write;
  napi_create_bigint_uint64(env, AtomicLoad64(const_cast<uint64_t*>(&header->last_write_ns)),
                            &last_write);
  napi_set_named_property(env, result, "lastWriteNs", last_write);

  return result;
}

void FinalizeHandle(napi_env env, void* data, void* hint) {
  FrameBusHandle* handle = static_cast<FrameBusHandle*>(data);
  if (!handle) {
    return;
  }
#if defined(_WIN32)
  if (handle->base) {
    UnmapViewOfFile(handle->base);
  }
  if (handle->map_handle) {
    CloseHandle(handle->map_handle);
  }
#else
  if (handle->base && handle->size > 0) {
    munmap(handle->base, handle->size);
  }
  if (handle->fd >= 0) {
    close(handle->fd);
  }
  if (handle->is_writer && !handle->name.empty()) {
    shm_unlink(handle->name.c_str());
  }
#endif
  delete handle;
}

napi_value WriterClose(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  napi_get_cb_info(env, info, nullptr, nullptr, &this_arg, nullptr);

  FrameBusHandle* handle = nullptr;
  napi_unwrap(env, this_arg, reinterpret_cast<void**>(&handle));
  if (!handle) {
    return nullptr;
  }

  FinalizeHandle(env, handle, nullptr);
  napi_wrap(env, this_arg, nullptr, nullptr, nullptr, nullptr);
  return nullptr;
}

napi_value ReaderClose(napi_env env, napi_callback_info info) {
  return WriterClose(env, info);
}

napi_value WriterWriteFrame(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_value this_arg;
  napi_get_cb_info(env, info, &argc, argv, &this_arg, nullptr);

  FrameBusHandle* handle = nullptr;
  napi_unwrap(env, this_arg, reinterpret_cast<void**>(&handle));
  if (!handle || !handle->header) {
    return ThrowError(env, "FrameBus writer not initialized");
  }

  if (argc < 1) {
    return ThrowError(env, "writeFrame requires a Buffer");
  }

  bool is_buffer = false;
  napi_is_buffer(env, argv[0], &is_buffer);
  if (!is_buffer) {
    return ThrowError(env, "writeFrame expects a Buffer");
  }

  void* buffer_data = nullptr;
  size_t buffer_length = 0;
  napi_get_buffer_info(env, argv[0], &buffer_data, &buffer_length);

  if (buffer_length != handle->header->frame_size) {
    return ThrowError(env, "Frame size mismatch");
  }

  uint64_t timestamp = 0;
  bool has_timestamp = false;
  if (argc >= 2) {
    GetOptionalBigint(env, argv[1], &timestamp, &has_timestamp);
  }

  const uint64_t current_seq = AtomicLoad64(&handle->header->seq);
  const uint32_t slot_index = handle->header->slot_count > 0
                                 ? static_cast<uint32_t>(current_seq % handle->header->slot_count)
                                 : 0;
  uint8_t* slot_ptr = handle->slots + (static_cast<size_t>(slot_index) * handle->header->slot_stride);

  memcpy(slot_ptr, buffer_data, buffer_length);
  if (has_timestamp) {
    AtomicStore64(&handle->header->last_write_ns, timestamp);
  }
  AtomicStore64(&handle->header->seq, current_seq + 1);

  return nullptr;
}

napi_value ReaderReadLatest(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  napi_get_cb_info(env, info, nullptr, nullptr, &this_arg, nullptr);

  FrameBusHandle* handle = nullptr;
  napi_unwrap(env, this_arg, reinterpret_cast<void**>(&handle));
  if (!handle || !handle->header) {
    return ThrowError(env, "FrameBus reader not initialized");
  }

  const uint64_t seq = AtomicLoad64(&handle->header->seq);
  if (seq == 0 || handle->header->slot_count == 0) {
    napi_value null_value;
    napi_get_null(env, &null_value);
    return null_value;
  }

  const uint32_t slot_index = static_cast<uint32_t>((seq - 1) % handle->header->slot_count);
  uint8_t* slot_ptr = handle->slots + (static_cast<size_t>(slot_index) * handle->header->slot_stride);

  napi_value buffer;
  napi_create_external_buffer(env, handle->header->frame_size, slot_ptr, nullptr, nullptr, &buffer);

  napi_value result;
  napi_create_object(env, &result);

  napi_set_named_property(env, result, "buffer", buffer);

  napi_value ts;
  napi_create_bigint_uint64(env, AtomicLoad64(&handle->header->last_write_ns), &ts);
  napi_set_named_property(env, result, "timestampNs", ts);

  napi_value seq_value;
  napi_create_bigint_uint64(env, seq, &seq_value);
  napi_set_named_property(env, result, "seq", seq_value);

  return result;
}

napi_value CreateWriter(napi_env env, napi_callback_info info) {
#if defined(_WIN32)
  return ThrowError(env, "FrameBus createWriter not implemented on Windows yet");
#else
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 1) {
    return ThrowError(env, "createWriter requires options object");
  }

  napi_value options = argv[0];
  napi_value name_value;
  napi_get_named_property(env, options, "name", &name_value);
  std::string name;
  if (!GetString(env, name_value, &name)) {
    return ThrowError(env, "Invalid name");
  }
  if (name.empty()) {
    return ThrowError(env, "FrameBus name is required");
  }
  if (name[0] != '/') {
    name = "/" + name;
  }

  napi_value width_value;
  napi_get_named_property(env, options, "width", &width_value);
  uint32_t width = 0;
  if (!GetUint32(env, width_value, &width) || width == 0) {
    return ThrowError(env, "Invalid width");
  }

  napi_value height_value;
  napi_get_named_property(env, options, "height", &height_value);
  uint32_t height = 0;
  if (!GetUint32(env, height_value, &height) || height == 0) {
    return ThrowError(env, "Invalid height");
  }

  napi_value fps_value;
  napi_get_named_property(env, options, "fps", &fps_value);
  uint32_t fps = 0;
  if (!GetUint32(env, fps_value, &fps) || fps == 0) {
    return ThrowError(env, "Invalid fps");
  }

  napi_value pixel_value;
  napi_get_named_property(env, options, "pixelFormat", &pixel_value);
  uint32_t pixel_format = 0;
  if (!GetUint32(env, pixel_value, &pixel_format) || pixel_format == 0) {
    return ThrowError(env, "Invalid pixelFormat");
  }

  napi_value slot_value;
  napi_get_named_property(env, options, "slotCount", &slot_value);
  uint32_t slot_count = 0;
  if (!GetUint32(env, slot_value, &slot_count) || slot_count < 2) {
    return ThrowError(env, "slotCount must be >= 2");
  }

  uint64_t frame_size_64 = static_cast<uint64_t>(width) * static_cast<uint64_t>(height) * 4;
  if (frame_size_64 > UINT32_MAX) {
    return ThrowError(env, "Frame size too large");
  }

  uint32_t frame_size = static_cast<uint32_t>(frame_size_64);
  uint32_t slot_stride = frame_size;
  uint64_t total_size_64 = static_cast<uint64_t>(FRAMEBUS_HEADER_SIZE) +
                           static_cast<uint64_t>(slot_stride) * slot_count;
  if (total_size_64 > SIZE_MAX) {
    return ThrowError(env, "FrameBus size too large");
  }

  const size_t total_size = static_cast<size_t>(total_size_64);

  int fd = shm_open(name.c_str(), O_CREAT | O_RDWR, 0600);
  if (fd < 0) {
    return ThrowError(env, "Failed to create shared memory");
  }

  if (ftruncate(fd, static_cast<off_t>(total_size)) != 0) {
    close(fd);
    return ThrowError(env, "Failed to resize shared memory");
  }

  void* base = mmap(nullptr, total_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (base == MAP_FAILED) {
    close(fd);
    return ThrowError(env, "Failed to map shared memory");
  }

  auto* header = static_cast<FrameBusHeader*>(base);
  header->magic = FRAMEBUS_MAGIC_LE;
  header->version = FRAMEBUS_VERSION;
  header->flags = 0;
  header->header_size = FRAMEBUS_HEADER_SIZE;
  header->width = width;
  header->height = height;
  header->fps = fps;
  header->pixel_format = pixel_format;
  header->frame_size = frame_size;
  header->slot_count = slot_count;
  header->slot_stride = slot_stride;
  AtomicStore64(&header->seq, 0);
  AtomicStore64(&header->last_write_ns, 0);
  memset(header->reserved, 0, sizeof(header->reserved));

  FrameBusHandle* handle = new FrameBusHandle();
  handle->is_writer = true;
  handle->name = name;
  handle->size = total_size;
  handle->fd = fd;
  handle->base = static_cast<uint8_t*>(base);
  handle->header = header;
  handle->slots = handle->base + FRAMEBUS_HEADER_SIZE;

  napi_value writer;
  napi_create_object(env, &writer);
  napi_wrap(env, writer, handle, FinalizeHandle, nullptr, nullptr);

  napi_value write_fn;
  napi_create_function(env, "writeFrame", NAPI_AUTO_LENGTH, WriterWriteFrame, nullptr, &write_fn);
  napi_set_named_property(env, writer, "writeFrame", write_fn);

  napi_value close_fn;
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, WriterClose, nullptr, &close_fn);
  napi_set_named_property(env, writer, "close", close_fn);

  napi_value header_obj = BuildHeaderObject(env, header);
  napi_set_named_property(env, writer, "header", header_obj);

  napi_value size_value;
  napi_create_uint32(env, static_cast<uint32_t>(total_size), &size_value);
  napi_set_named_property(env, writer, "size", size_value);

  napi_value name_value_out;
  napi_create_string_utf8(env, name.c_str(), name.size(), &name_value_out);
  napi_set_named_property(env, writer, "name", name_value_out);

  return writer;
#endif
}

napi_value OpenReader(napi_env env, napi_callback_info info) {
#if defined(_WIN32)
  return ThrowError(env, "FrameBus openReader not implemented on Windows yet");
#else
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 1) {
    return ThrowError(env, "openReader requires options object");
  }

  napi_value options = argv[0];
  napi_value name_value;
  napi_get_named_property(env, options, "name", &name_value);
  std::string name;
  if (!GetString(env, name_value, &name)) {
    return ThrowError(env, "Invalid name");
  }
  if (name.empty()) {
    return ThrowError(env, "FrameBus name is required");
  }
  if (name[0] != '/') {
    name = "/" + name;
  }

  int fd = shm_open(name.c_str(), O_RDWR, 0600);
  if (fd < 0) {
    return ThrowError(env, "Failed to open shared memory");
  }

  struct stat st;
  if (fstat(fd, &st) != 0) {
    close(fd);
    return ThrowError(env, "Failed to stat shared memory");
  }

  size_t total_size = static_cast<size_t>(st.st_size);
  if (total_size < FRAMEBUS_HEADER_SIZE) {
    close(fd);
    return ThrowError(env, "Shared memory size too small");
  }

  void* base = mmap(nullptr, total_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (base == MAP_FAILED) {
    close(fd);
    return ThrowError(env, "Failed to map shared memory");
  }

  auto* header = static_cast<FrameBusHeader*>(base);
  if (header->magic != FRAMEBUS_MAGIC_LE || header->header_size != FRAMEBUS_HEADER_SIZE) {
    munmap(base, total_size);
    close(fd);
    return ThrowError(env, "Invalid FrameBus header");
  }

  FrameBusHandle* handle = new FrameBusHandle();
  handle->is_writer = false;
  handle->name = name;
  handle->size = total_size;
  handle->fd = fd;
  handle->base = static_cast<uint8_t*>(base);
  handle->header = header;
  handle->slots = handle->base + FRAMEBUS_HEADER_SIZE;

  napi_value reader;
  napi_create_object(env, &reader);
  napi_wrap(env, reader, handle, FinalizeHandle, nullptr, nullptr);

  napi_value read_fn;
  napi_create_function(env, "readLatest", NAPI_AUTO_LENGTH, ReaderReadLatest, nullptr, &read_fn);
  napi_set_named_property(env, reader, "readLatest", read_fn);

  napi_value close_fn;
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, ReaderClose, nullptr, &close_fn);
  napi_set_named_property(env, reader, "close", close_fn);

  napi_value header_obj = BuildHeaderObject(env, header);
  napi_set_named_property(env, reader, "header", header_obj);

  napi_value name_value_out;
  napi_create_string_utf8(env, name.c_str(), name.size(), &name_value_out);
  napi_set_named_property(env, reader, "name", name_value_out);

  return reader;
#endif
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
      {"createWriter", nullptr, CreateWriter, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"openReader", nullptr, OpenReader, nullptr, nullptr, nullptr, napi_default, nullptr},
  };

  napi_status status = napi_define_properties(env, exports, 2, descriptors);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to define FrameBus properties");
    return nullptr;
  }

  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
