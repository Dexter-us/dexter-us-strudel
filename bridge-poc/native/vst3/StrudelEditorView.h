#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <wrl.h>
#include <WebView2.h>

#include "SharedAudioRingBuffer.hpp"

#include "public.sdk/source/common/pluginview.h"

#include <atomic>

namespace Steinberg::Vst {

class StrudelVst3Processor;

class StrudelEditorView final : public CPluginView {
 public:
  explicit StrudelEditorView(StrudelVst3Processor *processor);
  ~StrudelEditorView() SMTG_OVERRIDE;

  tresult PLUGIN_API isPlatformTypeSupported(FIDString type) SMTG_OVERRIDE;
  tresult PLUGIN_API onSize(ViewRect *newSize) SMTG_OVERRIDE;

  void attachedToParent() SMTG_OVERRIDE;
  void removedFromParent() SMTG_OVERRIDE;

 private:
  HRESULT createWebView();
  HRESULT createController(ICoreWebView2Environment *environment);
  HRESULT handleWebMessage(ICoreWebView2WebMessageReceivedEventArgs *args);
  HRESULT provideAudioBuffer();
  void updateBounds();
  void showError(const wchar_t *message) const;
  void closeWebView() noexcept;

  StrudelVst3Processor *m_processor;
  Microsoft::WRL::ComPtr<ICoreWebView2Environment> m_environment;
  Microsoft::WRL::ComPtr<ICoreWebView2Controller> m_controller;
  Microsoft::WRL::ComPtr<ICoreWebView2> m_webView;
  Microsoft::WRL::ComPtr<ICoreWebView2_17> m_webView17;
  Microsoft::WRL::ComPtr<ICoreWebView2Environment12> m_environment12;
  Microsoft::WRL::ComPtr<ICoreWebView2SharedBuffer> m_sharedBuffer;
  dexter::strudel::bridge::SharedAudioRingBufferReader *m_reader{nullptr};
  EventRegistrationToken m_messageToken{};
  std::atomic<bool> m_closing{false};
};

}  // namespace Steinberg::Vst
