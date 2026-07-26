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

#include "mf_attributes.h"
#include "raw_frame_client.h"

namespace broadify::vcam {

// One RGB32 video stream. Pulls the latest program frame from the shared
// RawFrameClient and hands it back as a self-allocated MF sample (so it works
// standalone via a source reader, without the frame server's allocator).
struct MediaStream : winrt::implements<MediaStream, AttributesBase<IMFAttributes>,
                                       IMFMediaStream2, IKsControl> {
  // IMFMediaEventGenerator
  STDMETHOD(BeginGetEvent)(IMFAsyncCallback *callback, IUnknown *state);
  STDMETHOD(EndGetEvent)(IMFAsyncResult *result, IMFMediaEvent **event);
  STDMETHOD(GetEvent)(DWORD flags, IMFMediaEvent **event);
  STDMETHOD(QueueEvent)
  (MediaEventType type, REFGUID extended, HRESULT status,
   const PROPVARIANT *value);

  // IMFMediaStream
  STDMETHOD(GetMediaSource)(IMFMediaSource **source);
  STDMETHOD(GetStreamDescriptor)(IMFStreamDescriptor **descriptor);
  STDMETHOD(RequestSample)(IUnknown *token);

  // IMFMediaStream2
  STDMETHOD(SetStreamState)(MF_STREAM_STATE state);
  STDMETHOD(GetStreamState)(MF_STREAM_STATE *state);

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

  HRESULT Initialize(IMFMediaSource *source, int index, RawFrameClient *client,
                     uint32_t width, uint32_t height);
  HRESULT Start();
  HRESULT Stop();
  void Shutdown();

 private:
  // Map the base interfaces the source reader queries onto IMFMediaStream2.
  int32_t query_interface_tearoff(winrt::guid const &id,
                                   void **object) const noexcept override {
    if (id == winrt::guid_of<IMFMediaStream>() ||
        id == winrt::guid_of<IMFMediaEventGenerator>()) {
      *object = static_cast<IMFMediaStream2 *>(const_cast<MediaStream *>(this));
      const_cast<MediaStream *>(this)->AddRef();
      return 0;  // S_OK
    }
    return static_cast<int32_t>(0x80004002L);  // E_NOINTERFACE
  }

  winrt::slim_mutex _lock;
  MF_STREAM_STATE _state = MF_STREAM_STATE_STOPPED;
  int _index = 0;
  uint32_t _width = 0;
  uint32_t _height = 0;
  uint64_t _lastSequence = 0;
  RawFrameClient *_client = nullptr;  // owned by the MediaSource.
  Microsoft::WRL::ComPtr<IMFStreamDescriptor> _descriptor;
  Microsoft::WRL::ComPtr<IMFMediaEventQueue> _queue;
  Microsoft::WRL::ComPtr<IMFMediaSource> _source;
};

}  // namespace broadify::vcam
