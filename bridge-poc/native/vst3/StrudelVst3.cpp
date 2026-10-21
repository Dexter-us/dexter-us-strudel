#include "StrudelVst3.h"

#include "StrudelEditorView.h"

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/base/fstrdefs.h"
#include "pluginterfaces/base/ustring.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "public.sdk/source/main/pluginfactory.h"

#include <cmath>
#include <cstring>

namespace Steinberg::Vst {

tresult PLUGIN_API StrudelVst3Processor::initialize(FUnknown *context) {
  const auto result = SingleComponentEffect::initialize(context);
  if (result != kResultOk) {
    return result;
  }

  addAudioOutput(STR16("Strudel Audio"), SpeakerArr::kStereo);
  return kResultOk;
}

tresult PLUGIN_API StrudelVst3Processor::setupProcessing(
    ProcessSetup &setup) {
  const auto result = SingleComponentEffect::setupProcessing(setup);
  if (result != kResultOk) {
    return result;
  }

  if (std::isfinite(setup.sampleRate) && setup.sampleRate >= 8000.0 &&
      setup.sampleRate <= 192000.0) {
    m_sampleRate.store(static_cast<std::uint32_t>(std::lround(setup.sampleRate)),
                       std::memory_order_release);
  }
  return kResultOk;
}

tresult PLUGIN_API StrudelVst3Processor::canProcessSampleSize(
    int32 symbolicSampleSize) {
  return symbolicSampleSize == kSample32 ? kResultTrue : kResultFalse;
}

tresult PLUGIN_API StrudelVst3Processor::process(ProcessData &data) {
  if (data.numOutputs < 1 || data.outputs == nullptr ||
      data.outputs[0].channelBuffers32 == nullptr) {
    return kResultOk;
  }

  auto **outputs = data.outputs[0].channelBuffers32;
  const auto channels =
      static_cast<std::uint32_t>(data.outputs[0].numChannels);
  const auto frames = static_cast<std::uint32_t>(data.numSamples);
  data.outputs[0].silenceFlags = 0;

  auto *reader = m_activeReader.load(std::memory_order_acquire);
  if (reader != nullptr) {
    reader->process(outputs, channels, frames);
  } else {
    for (std::uint32_t channel = 0; channel < channels; ++channel) {
      if (outputs[channel] != nullptr) {
        std::memset(outputs[channel], 0, sizeof(float) * frames);
      }
    }
  }
  return kResultOk;
}

IPlugView *PLUGIN_API StrudelVst3Processor::createView(const char *name) {
  if (name != nullptr && FIDStringsEqual(name, ViewType::kEditor)) {
    return new StrudelEditorView(this);
  }
  return nullptr;
}

dexter::strudel::bridge::SharedAudioRingBufferReader *
StrudelVst3Processor::retainSharedBuffer(
    Microsoft::WRL::ComPtr<ICoreWebView2SharedBuffer> buffer,
    std::uint32_t expectedSampleRate) {
  if (!buffer || expectedSampleRate != sampleRate()) {
    return nullptr;
  }

  BYTE *mapping = nullptr;
  UINT64 mappingBytes = 0;
  if (FAILED(buffer->get_Buffer(&mapping)) || mapping == nullptr ||
      FAILED(buffer->get_Size(&mappingBytes))) {
    return nullptr;
  }

  auto reader = std::make_unique<
      dexter::strudel::bridge::SharedAudioRingBufferReader>();
  if (!reader->attach(mapping, static_cast<std::size_t>(mappingBytes),
                      expectedSampleRate)) {
    return nullptr;
  }

  auto *readerAddress = reader.get();
  m_sharedBuffers.emplace_back(std::move(buffer));
  m_readers.emplace_back(std::move(reader));
  m_activeReader.store(readerAddress, std::memory_order_release);
  return readerAddress;
}

}  // namespace Steinberg::Vst

using namespace Steinberg;
using namespace Steinberg::Vst;

BEGIN_FACTORY_DEF("Dexter U.S.",
                  "https://github.com/Dexter-us/dexter-us-strudel", "")

DEF_CLASS2(INLINE_UID(0xD3E7A5B1, 0x4C2A6F80, 0xAB10CD23, 0x9F775E41),
           PClassInfo::kManyInstances, kVstAudioEffectClass,
           "Dexter U.S. Strudel", 0, "Instrument|Synth", "0.1.0",
           kVstVersionString, StrudelVst3Processor::createInstance)

END_FACTORY
