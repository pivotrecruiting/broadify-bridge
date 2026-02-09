#include <node_api.h>

namespace {

napi_value ThrowNotImplemented(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

napi_value CreateWriter(napi_env env, napi_callback_info info) {
  return ThrowNotImplemented(env, "FrameBus createWriter not implemented");
}

napi_value OpenReader(napi_env env, napi_callback_info info) {
  return ThrowNotImplemented(env, "FrameBus openReader not implemented");
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
