#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <unknwn.h>
#include <winrt/base.h>

#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <ks.h>
#include <ksproxy.h>
#include <wrl/client.h>

#include <cstdint>
#include <memory>

#include "mf_attributes.h"
#include "media_stream.h"
#include "raw_frame_client.h"

namespace broadify::vcam {

// The Broadify virtual-camera media source. Owns the RawFrameClient (Channel A
// consumer) and a single RGB32 stream. Activated by MFCreateVirtualCamera in
// the Frame Server, or directly via a source reader for standalone testing.
struct MediaSource
    : winrt::implements<MediaSource, AttributesBase<IMFAttributes>,
                        IMFMediaSourceEx, IMFGetService, IKsControl> {
  // IMFMediaEventGenerator
  STDMETHOD(BeginGetEvent)(IMFAsyncCallback *callback, IUnknown *state);
  STDMETHOD(EndGetEvent)(IMFAsyncResult *result, IMFMediaEvent **event);
  STDMETHOD(GetEvent)(DWORD flags, IMFMediaEvent **event);
  STDMETHOD(QueueEvent)
  (MediaEventType type, REFGUID extended, HRESULT status,
   const PROPVARIANT *value);

  // IMFMediaSource
  STDMETHOD(CreatePresentationDescriptor)(IMFPresentationDescriptor **descriptor);
  STDMETHOD(GetCharacteristics)(DWORD *characteristics);
  STDMETHOD(Pause)();
  STDMETHOD(Shutdown)();
  STDMETHOD(Start)
  (IMFPresentationDescriptor *descriptor, const GUID *timeFormat,
   const PROPVARIANT *startPosition);
  STDMETHOD(Stop)();

  // IMFMediaSourceEx
  STDMETHOD(GetSourceAttributes)(IMFAttributes **attributes);
  STDMETHOD(GetStreamAttributes)
  (DWORD streamId, IMFAttributes **attributes);
  STDMETHOD(SetD3DManager)(IUnknown *manager);

  // IMFGetService
  STDMETHOD(GetService)(REFGUID service, REFIID riid, LPVOID *object);

  // IKsControl
  STDMETHOD(KsProperty)
  (PKSPROPERTY property, ULONG length, LPVOID data, ULONG dataLength,
   ULONG *bytesReturned);
  STDMETHOD(KsMethod)
  (PKSMETHOD method, ULONG length, LPVOID data, ULONG dataLength,
   ULONG *bytesReturned);
  STDMETHOD(KsEvent)
  (PKSEVENT evt, ULONG length, LPVOID data, ULONG dataLength,
   ULONG *bytesReturned);

  HRESULT Initialize(IMFAttributes *attributes);

 private:
  // winrt::implements only answers QI for the exact interfaces listed above;
  // the source reader also queries the base interfaces, so map them onto the
  // derived IMFMediaSourceEx (which shares their vtable prefix).
  int32_t query_interface_tearoff(winrt::guid const &id,
                                   void **object) const noexcept override {
    if (id == winrt::guid_of<IMFMediaSource>() ||
        id == winrt::guid_of<IMFMediaEventGenerator>()) {
      *object = static_cast<IMFMediaSourceEx *>(const_cast<MediaSource *>(this));
      const_cast<MediaSource *>(this)->AddRef();
      return 0;  // S_OK
    }
    return static_cast<int32_t>(0x80004002L);  // E_NOINTERFACE
  }

  winrt::slim_mutex _lock;
  uint32_t _width = 0;
  uint32_t _height = 0;
  std::unique_ptr<RawFrameClient> _client;
  winrt::com_ptr<MediaStream> _stream;
  Microsoft::WRL::ComPtr<IMFMediaEventQueue> _queue;
  Microsoft::WRL::ComPtr<IMFPresentationDescriptor> _descriptor;
};

}  // namespace broadify::vcam
