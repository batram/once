// Node-API addon behind src/browser/windowCloak.ts: shows a window without the
// white frame Windows otherwise presents first.
//
// Chromium answers WM_ERASEBKGND without painting, so a newly shown window's
// redirection surface stays unpainted, and DWM composes it as white until
// Chromium's first frame lands (~250 ms). The window-open animation usually
// hides that; with "Animate windows when minimizing and maximizing" off it is
// a visible flash, and backgroundColor cannot reach it. The fix: show the
// window cloaked, fill its surface with the class brush (which Electron sets
// to backgroundColor), wait for DWM to take that, then uncloak.
//
// The napi_* functions are resolved from the host executable at load time, so
// the build needs neither node headers nor node.lib, and the module works in
// whatever executable Electron is renamed to.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>

#include <cstdint>
#include <cstring>

extern "C" {
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
}

namespace {

constexpr size_t kAutoLength = static_cast<size_t>(-1);

using CreateFunction = napi_status (*)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
using SetNamedProperty = napi_status (*)(napi_env, napi_value, const char*, napi_value);
using GetCbInfo = napi_status (*)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
using GetBufferInfo = napi_status (*)(napi_env, napi_value, void**, size_t*);
using GetValueBool = napi_status (*)(napi_env, napi_value, bool*);
using GetBoolean = napi_status (*)(napi_env, bool, napi_value*);
using ThrowError = napi_status (*)(napi_env, const char*, const char*);

struct Api {
  CreateFunction create_function;
  SetNamedProperty set_named_property;
  GetCbInfo get_cb_info;
  GetBufferInfo get_buffer_info;
  GetValueBool get_value_bool;
  GetBoolean get_boolean;
  ThrowError throw_error;
};

Api api;

template <typename T>
bool Resolve(HMODULE host, const char* name, T& slot) {
  slot = reinterpret_cast<T>(GetProcAddress(host, name));
  return slot != nullptr;
}

bool LoadApi() {
  HMODULE host = GetModuleHandleW(nullptr);
  return Resolve(host, "napi_create_function", api.create_function) &&
         Resolve(host, "napi_set_named_property", api.set_named_property) &&
         Resolve(host, "napi_get_cb_info", api.get_cb_info) &&
         Resolve(host, "napi_get_buffer_info", api.get_buffer_info) &&
         Resolve(host, "napi_get_value_bool", api.get_value_bool) &&
         Resolve(host, "napi_get_boolean", api.get_boolean) &&
         Resolve(host, "napi_throw_error", api.throw_error);
}

napi_value Boolean(napi_env env, bool value) {
  napi_value result = nullptr;
  api.get_boolean(env, value, &result);
  return result;
}

// Reads the first argument, BrowserWindow.getNativeWindowHandle(), into an
// HWND; throws and returns null when it is not one.
HWND WindowArgument(napi_env env, napi_value* argv, size_t argc, size_t expected, const char* usage) {
  if (argc < expected) {
    api.throw_error(env, nullptr, usage);
    return nullptr;
  }
  void* data = nullptr;
  size_t length = 0;
  HWND window = nullptr;
  if (api.get_buffer_info(env, argv[0], &data, &length) != 0 || length != sizeof(HWND)) {
    api.throw_error(env, nullptr, usage);
    return nullptr;
  }
  memcpy(&window, data, sizeof(HWND));
  return window;
}

// setCloaked(handle: Buffer, cloaked: boolean): boolean — whether DWM took it.
napi_value SetCloaked(napi_env env, napi_callback_info info) {
  constexpr const char* kUsage = "setCloaked(handle: Buffer, cloaked: boolean)";
  size_t argc = 2;
  napi_value argv[2] = {};
  if (api.get_cb_info(env, info, &argc, argv, nullptr, nullptr) != 0) return nullptr;
  HWND window = WindowArgument(env, argv, argc, 2, kUsage);
  if (!window) return nullptr;
  bool cloaked = false;
  if (api.get_value_bool(env, argv[1], &cloaked) != 0) {
    api.throw_error(env, nullptr, kUsage);
    return nullptr;
  }
  BOOL value = cloaked ? TRUE : FALSE;
  return Boolean(env, IsWindow(window) &&
      SUCCEEDED(DwmSetWindowAttribute(window, DWMWA_CLOAK, &value, sizeof(value))));
}

// fillBackground(handle: Buffer): boolean — paints the client area with the
// window class's background brush and waits until DWM has composed it.
napi_value FillBackground(napi_env env, napi_callback_info info) {
  constexpr const char* kUsage = "fillBackground(handle: Buffer)";
  size_t argc = 1;
  napi_value argv[1] = {};
  if (api.get_cb_info(env, info, &argc, argv, nullptr, nullptr) != 0) return nullptr;
  HWND window = WindowArgument(env, argv, argc, 1, kUsage);
  if (!window) return nullptr;
  if (!IsWindow(window)) return Boolean(env, false);
  auto brush = reinterpret_cast<HBRUSH>(GetClassLongPtrW(window, GCLP_HBRBACKGROUND));
  if (!brush) return Boolean(env, false);
  HDC dc = GetDC(window);
  if (!dc) return Boolean(env, false);
  RECT client = {};
  GetClientRect(window, &client);
  const bool filled = FillRect(dc, &client, brush) != 0;
  ReleaseDC(window, dc);
  return Boolean(env, filled && SUCCEEDED(DwmFlush()));
}

bool Export(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value function = nullptr;
  return api.create_function(env, name, kAutoLength, callback, nullptr, &function) == 0 &&
         api.set_named_property(env, exports, name, function) == 0;
}

}  // namespace

extern "C" __declspec(dllexport) int32_t node_api_module_get_api_version_v1() {
  return 8;
}

extern "C" __declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  if (LoadApi()) {
    Export(env, exports, "setCloaked", SetCloaked);
    Export(env, exports, "fillBackground", FillBackground);
  }
  return exports;
}
