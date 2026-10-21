#pragma once

#include "SharedAudioRingBuffer.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <wrl.h>
#include <WebView2.h>

#include "public.sdk/source/vst/vstsinglecomponenteffect.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/smartpointer.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace Steinberg::Vst {

class StrudelEditorView;

class StrudelVst3Processor final : public SingleComponentEffect {
 public:
  static FUnknown *createInstance(void *) {
    return static_cast<IAudioProcessor *>(new StrudelVst3Processor());
  }

  tresult PLUGIN_API initialize(FUnknown *context) SMTG_OVERRIDE;
  tresult PLUGIN_API setState(IBStream *state) SMTG_OVERRIDE;
  tresult PLUGIN_API getState(IBStream *state) SMTG_OVERRIDE;
  tresult PLUGIN_API setupProcessing(ProcessSetup &setup) SMTG_OVERRIDE;
  tresult PLUGIN_API canProcessSampleSize(int32 symbolicSampleSize) SMTG_OVERRIDE;
  tresult PLUGIN_API process(ProcessData &data) SMTG_OVERRIDE;
  IPlugView *PLUGIN_API createView(const char *name) SMTG_OVERRIDE;

  std::uint32_t sampleRate() const noexcept {
    return m_sampleRate.load(std::memory_order_acquire);
  }

  void setEditorCode(std::string code);
  std::string editorCode() const;

  dexter::strudel::bridge::SharedAudioRingBufferReader *retainSharedBuffer(
      Microsoft::WRL::ComPtr<ICoreWebView2SharedBuffer> buffer,
      std::uint32_t expectedSampleRate);

 private:
  std::atomic<std::uint32_t> m_sampleRate{48000};
  mutable std::mutex m_editorCodeMutex;
  std::string m_editorCode;
  std::atomic<dexter::strudel::bridge::SharedAudioRingBufferReader *>
      m_activeReader{nullptr};

  // Keep both the reader and WebView2 mapping alive for the component's
  // lifetime. Replacing a mapping publishes a stable reader pointer; the
  // audio callback can finish using the previous one without a use-after-free.
  std::vector<std::unique_ptr<
      dexter::strudel::bridge::SharedAudioRingBufferReader>>
      m_readers;
  std::vector<Microsoft::WRL::ComPtr<ICoreWebView2SharedBuffer>>
      m_sharedBuffers;
};

}  // namespace Steinberg::Vst
