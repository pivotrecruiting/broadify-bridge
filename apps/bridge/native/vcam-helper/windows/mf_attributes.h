#pragma once

#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <wrl/client.h>

// Minimal IMFAttributes implementation by delegation to an inner attribute
// store (MFCreateAttributes). Adapted from Microsoft's VCamSample (MIT), with
// the WIL/tracing dependencies removed. A media source/stream exposes its
// device attributes by deriving from this and listing it in winrt::implements.
template <class IFACE = IMFAttributes>
struct AttributesBase : public IFACE {
 protected:
  Microsoft::WRL::ComPtr<IMFAttributes> _attributes;

  AttributesBase() { MFCreateAttributes(&_attributes, 0); }

 public:
  STDMETHODIMP GetItem(REFGUID key, PROPVARIANT *value) {
    return _attributes->GetItem(key, value);
  }
  STDMETHODIMP GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE *type) {
    return _attributes->GetItemType(key, type);
  }
  STDMETHODIMP CompareItem(REFGUID key, REFPROPVARIANT value, BOOL *result) {
    return _attributes->CompareItem(key, value, result);
  }
  STDMETHODIMP Compare(IMFAttributes *theirs, MF_ATTRIBUTES_MATCH_TYPE type,
                       BOOL *result) {
    return _attributes->Compare(theirs, type, result);
  }
  STDMETHODIMP GetUINT32(REFGUID key, UINT32 *value) {
    return _attributes->GetUINT32(key, value);
  }
  STDMETHODIMP GetUINT64(REFGUID key, UINT64 *value) {
    return _attributes->GetUINT64(key, value);
  }
  STDMETHODIMP GetDouble(REFGUID key, double *value) {
    return _attributes->GetDouble(key, value);
  }
  STDMETHODIMP GetGUID(REFGUID key, GUID *value) {
    return _attributes->GetGUID(key, value);
  }
  STDMETHODIMP GetStringLength(REFGUID key, UINT32 *length) {
    return _attributes->GetStringLength(key, length);
  }
  STDMETHODIMP GetString(REFGUID key, LPWSTR value, UINT32 size,
                         UINT32 *length) {
    return _attributes->GetString(key, value, size, length);
  }
  STDMETHODIMP GetAllocatedString(REFGUID key, LPWSTR *value, UINT32 *length) {
    return _attributes->GetAllocatedString(key, value, length);
  }
  STDMETHODIMP GetBlobSize(REFGUID key, UINT32 *size) {
    return _attributes->GetBlobSize(key, size);
  }
  STDMETHODIMP GetBlob(REFGUID key, UINT8 *buf, UINT32 size, UINT32 *blobSize) {
    return _attributes->GetBlob(key, buf, size, blobSize);
  }
  STDMETHODIMP GetAllocatedBlob(REFGUID key, UINT8 **buf, UINT32 *size) {
    return _attributes->GetAllocatedBlob(key, buf, size);
  }
  STDMETHODIMP GetUnknown(REFGUID key, REFIID riid, LPVOID *ppv) {
    return _attributes->GetUnknown(key, riid, ppv);
  }
  STDMETHODIMP SetItem(REFGUID key, REFPROPVARIANT value) {
    return _attributes->SetItem(key, value);
  }
  STDMETHODIMP DeleteItem(REFGUID key) { return _attributes->DeleteItem(key); }
  STDMETHODIMP DeleteAllItems() { return _attributes->DeleteAllItems(); }
  STDMETHODIMP SetUINT32(REFGUID key, UINT32 value) {
    return _attributes->SetUINT32(key, value);
  }
  STDMETHODIMP SetUINT64(REFGUID key, UINT64 value) {
    return _attributes->SetUINT64(key, value);
  }
  STDMETHODIMP SetDouble(REFGUID key, double value) {
    return _attributes->SetDouble(key, value);
  }
  STDMETHODIMP SetGUID(REFGUID key, REFGUID value) {
    return _attributes->SetGUID(key, value);
  }
  STDMETHODIMP SetString(REFGUID key, LPCWSTR value) {
    return _attributes->SetString(key, value);
  }
  STDMETHODIMP SetBlob(REFGUID key, const UINT8 *buf, UINT32 size) {
    return _attributes->SetBlob(key, buf, size);
  }
  STDMETHODIMP SetUnknown(REFGUID key, IUnknown *value) {
    return _attributes->SetUnknown(key, value);
  }
  STDMETHODIMP LockStore() { return _attributes->LockStore(); }
  STDMETHODIMP UnlockStore() { return _attributes->UnlockStore(); }
  STDMETHODIMP GetCount(UINT32 *count) { return _attributes->GetCount(count); }
  STDMETHODIMP GetItemByIndex(UINT32 index, GUID *key, PROPVARIANT *value) {
    return _attributes->GetItemByIndex(index, key, value);
  }
  STDMETHODIMP CopyAllItems(IMFAttributes *dest) {
    return _attributes->CopyAllItems(dest);
  }
};
