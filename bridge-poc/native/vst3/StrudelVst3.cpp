#include "StrudelVst3.h"

#include "StrudelEditorView.h"

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/base/fstrdefs.h"
#include "pluginterfaces/base/ustring.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "public.sdk/source/main/pluginfactory.h"

#include <Objbase.h>
#include <ShlObj.h>

#include <cmath>
#include <cstring>
#include <filesystem>
#include <string>
#include <utility>

namespace Steinberg::Vst {
namespace {

constexpr char kStateMagic[4] = {'D', 'U', 'S', 'C'};
constexpr std::uint32_t kStateVersion = 1;
constexpr std::uint32_t kMaximumEditorCodeBytes = 4 * 1024 * 1024;

std::filesystem::path webViewUserDataPath() {
  PWSTR localAppData = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE,
                                  nullptr, &localAppData)) ||
      localAppData == nullptr) {
    return {};
  }
  const std::filesystem::path result =
      std::filesystem::path(localAppData) / L"DexterUS" / L"Strudel" /
      L"WebView2";
  CoTaskMemFree(localAppData);
  return result;
}

tresult writeStateBytes(IBStream *stream, const void *data, int32 size) {
  int32 written = 0;
  const auto result =
      stream->write(const_cast<void *>(data), size, &written);
  return result == kResultOk && written == size ? kResultOk : kResultFalse;
}

tresult readStateBytes(IBStream *stream, void *data, int32 size) {
  int32 read = 0;
  const auto result = stream->read(data, size, &read);
  return result == kResultOk && read == size ? kResultOk : kResultFalse;
}

tresult restoreEditorCodeState(IBStream *state,
                               StrudelVst3Processor *processor) {
  if (state == nullptr || processor == nullptr) {
    return kInvalidArgument;
  }

  char magic[sizeof(kStateMagic)]{};
  std::uint32_t version = 0;
  std::uint32_t codeBytes = 0;
  if (readStateBytes(state, magic, static_cast<int32>(sizeof(magic))) !=
          kResultOk ||
      readStateBytes(state, &version,
                     static_cast<int32>(sizeof(version))) != kResultOk ||
      readStateBytes(state, &codeBytes,
                     static_cast<int32>(sizeof(codeBytes))) != kResultOk ||
      std::memcmp(magic, kStateMagic, sizeof(kStateMagic)) != 0 ||
      version != kStateVersion || codeBytes > kMaximumEditorCodeBytes) {
    return kResultFalse;
  }

  std::string code(codeBytes, '\0');
  if (codeBytes > 0 &&
      readStateBytes(state, code.data(), static_cast<int32>(codeBytes)) !=
          kResultOk) {
    return kResultFalse;
  }
  processor->setEditorCode(std::move(code));
  return kResultOk;
}

tresult saveEditorCodeState(IBStream *state,
                            const StrudelVst3Processor *processor) {
  if (state == nullptr || processor == nullptr) {
    return kInvalidArgument;
  }

  const auto code = processor->editorCode();
  if (code.size() > kMaximumEditorCodeBytes) {
    return kResultFalse;
  }

  const auto codeBytes = static_cast<std::uint32_t>(code.size());
  if (writeStateBytes(state, kStateMagic,
                      static_cast<int32>(sizeof(kStateMagic))) != kResultOk ||
      writeStateBytes(state, &kStateVersion,
                      static_cast<int32>(sizeof(kStateVersion))) !=
          kResultOk ||
      writeStateBytes(state, &codeBytes,
                      static_cast<int32>(sizeof(codeBytes))) != kResultOk) {
    return kResultFalse;
  }
  return codeBytes == 0
             ? kResultOk
             : writeStateBytes(state, code.data(),
                               static_cast<int32>(codeBytes));
}

}  // namespace

tresult PLUGIN_API StrudelVst3Processor::initialize(FUnknown *context) {
  const auto result = SingleComponentEffect::initialize(context);
  if (result != kResultOk) {
    return result;
  }

  addAudioOutput(STR16("Strudel Audio"), SpeakerArr::kStereo);
  warmWebView2Environment();
  return kResultOk;
}

void StrudelVst3Processor::warmWebView2Environment() {
  // WebView2 environments belong to the apartment that creates them. Only
  // prewarm from an STA; the editor can create its own environment otherwise.
  APTTYPE apartmentType{};
  APTTYPEQUALIFIER apartmentQualifier{};
  if (FAILED(CoGetApartmentType(&apartmentType, &apartmentQualifier)) ||
      (apartmentType != APTTYPE_STA && apartmentType != APTTYPE_MAINSTA)) {
    return;
  }

  const auto userData = webViewUserDataPath();
  if (userData.empty()) {
    return;
  }
  try {
    std::filesystem::create_directories(userData);
  } catch (...) {
    return;
  }

  {
    std::lock_guard<std::mutex> lock(m_webViewEnvironmentMutex);
    m_webViewEnvironmentThreadId = GetCurrentThreadId();
  }

  auto self = Steinberg::IPtr<StrudelVst3Processor>(this);
  const auto callback =
      Microsoft::WRL::Callback<
          ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
          [self](HRESULT error,
                 ICoreWebView2Environment *environment) mutable -> HRESULT {
            if (SUCCEEDED(error) && environment != nullptr) {
              std::lock_guard<std::mutex> lock(
                  self->m_webViewEnvironmentMutex);
              self->m_warmedWebViewEnvironment = environment;
            }
            return S_OK;
          });
  CreateCoreWebView2EnvironmentWithOptions(
      nullptr, userData.c_str(), nullptr, callback.Get());
}

Microsoft::WRL::ComPtr<ICoreWebView2Environment>
StrudelVst3Processor::warmedWebViewEnvironment() const {
  std::lock_guard<std::mutex> lock(m_webViewEnvironmentMutex);
  if (m_webViewEnvironmentThreadId != GetCurrentThreadId()) {
    return {};
  }
  return m_warmedWebViewEnvironment;
}

tresult PLUGIN_API StrudelVst3Processor::setState(IBStream *state) {
  return restoreEditorCodeState(state, this);
}

tresult PLUGIN_API StrudelVst3Processor::getState(IBStream *state) {
  return saveEditorCodeState(state, this);
}

tresult PLUGIN_API StrudelVst3Processor::setComponentState(IBStream *state) {
  return restoreEditorCodeState(state, this);
}

tresult PLUGIN_API StrudelVst3Processor::setEditorState(IBStream *state) {
  return restoreEditorCodeState(state, this);
}

tresult PLUGIN_API StrudelVst3Processor::getEditorState(IBStream *state) {
  return saveEditorCodeState(state, this);
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

void StrudelVst3Processor::setEditorCode(std::string code) {
  std::lock_guard<std::mutex> lock(m_editorCodeMutex);
  m_editorCode = std::move(code);
}

std::string StrudelVst3Processor::editorCode() const {
  std::lock_guard<std::mutex> lock(m_editorCodeMutex);
  return m_editorCode;
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
            "Dexter U.S. Strudel", 0, "Instrument|Synth", "0.2.3",
           kVstVersionString, StrudelVst3Processor::createInstance)

END_FACTORY
