#include "StrudelEditorView.h"

#include "StrudelVst3.h"

#include <Windows.h>
#include <ShlObj.h>
#include <wrl.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cwchar>
#include <cstring>
#include <filesystem>
#include <limits>
#include <string>

extern "C" IMAGE_DOS_HEADER __ImageBase;

namespace Steinberg::Vst {
namespace {

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

constexpr wchar_t kVirtualHostName[] = L"strudel.local";
constexpr std::uint32_t kRingCapacityFrames = 65536;
constexpr std::uint32_t kMaximumSampleRate = 192000;
const ViewRect kEditorSize{0, 0, 1200, 800};

std::filesystem::path pluginModulePath() {
  std::array<wchar_t, 32768> path{};
  const auto module = reinterpret_cast<HMODULE>(&__ImageBase);
  const auto length =
      GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
  if (length == 0 || length >= path.size()) {
    return {};
  }
  return std::filesystem::path(std::wstring(path.data(), length));
}

std::filesystem::path webAssetsPath() {
  const auto modulePath = pluginModulePath();
  if (modulePath.empty()) {
    return {};
  }
  return modulePath.parent_path().parent_path() / L"Resources" / L"web";
}

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

bool beginsWith(const std::wstring &text, const wchar_t *prefix) {
  return text.rfind(prefix, 0) == 0;
}

std::string wideToUtf8(const std::wstring &text) {
  if (text.empty()) {
    return {};
  }
  const int byteCount =
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
                          static_cast<int>(text.size()), nullptr, 0, nullptr,
                          nullptr);
  if (byteCount <= 0) {
    return {};
  }
  std::string result(static_cast<std::size_t>(byteCount), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
                          static_cast<int>(text.size()), result.data(),
                          byteCount, nullptr, nullptr) != byteCount) {
    return {};
  }
  return result;
}

std::wstring utf8ToWide(const std::string &text) {
  if (text.empty()) {
    return {};
  }
  const int characterCount =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                          static_cast<int>(text.size()), nullptr, 0);
  if (characterCount <= 0) {
    return {};
  }
  std::wstring result(static_cast<std::size_t>(characterCount), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                          static_cast<int>(text.size()), result.data(),
                          characterCount) != characterCount) {
    return {};
  }
  return result;
}

}  // namespace

StrudelEditorView::StrudelEditorView(StrudelVst3Processor *processor)
    : CPluginView(&kEditorSize), m_processor(processor) {}

StrudelEditorView::~StrudelEditorView() { closeWebView(); }

tresult PLUGIN_API StrudelEditorView::isPlatformTypeSupported(FIDString type) {
  return FIDStringsEqual(type, kPlatformTypeHWND) ? kResultTrue : kResultFalse;
}

tresult PLUGIN_API StrudelEditorView::onSize(ViewRect *newSize) {
  const auto result = CPluginView::onSize(newSize);
  updateBounds();
  return result;
}

void StrudelEditorView::attachedToParent() {
  m_closing.store(false, std::memory_order_release);
  if (FAILED(createWebView())) {
    showError(L"Could not start the Strudel WebView2 editor.");
  }
}

void StrudelEditorView::removedFromParent() {
  m_closing.store(true, std::memory_order_release);
  closeWebView();
}

HRESULT StrudelEditorView::createWebView() {
  if (systemWindow == nullptr) {
    return E_POINTER;
  }

  const auto assets = webAssetsPath();
  if (assets.empty() || !std::filesystem::exists(assets / L"index.html")) {
    return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
  }

  const auto userData = webViewUserDataPath();
  if (userData.empty()) {
    return E_FAIL;
  }

  try {
    std::filesystem::create_directories(userData);
  } catch (...) {
    return E_ACCESSDENIED;
  }

  if (auto environment = m_processor->warmedWebViewEnvironment()) {
    return createController(environment.Get());
  }

  auto self = Steinberg::IPtr<StrudelEditorView>(this);
  const auto callback =
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
          [self](HRESULT error,
                 ICoreWebView2Environment *environment) mutable -> HRESULT {
            if (self->m_closing.load(std::memory_order_acquire)) {
              return S_OK;
            }
            if (FAILED(error) || environment == nullptr) {
              self->showError(
                  L"WebView2 Runtime is unavailable. Install the Microsoft "
                  L"Edge WebView2 Runtime, then reopen the editor.");
              return FAILED(error) ? error : E_FAIL;
            }
            self->m_environment = environment;
            return self->createController(environment);
          });

  return CreateCoreWebView2EnvironmentWithOptions(
      nullptr, userData.c_str(), nullptr, callback.Get());
}

HRESULT StrudelEditorView::createController(
    ICoreWebView2Environment *environment) {
  auto self = Steinberg::IPtr<StrudelEditorView>(this);
  const auto callback =
      Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
          [self](HRESULT error,
                 ICoreWebView2Controller *controller) mutable -> HRESULT {
            if (self->m_closing.load(std::memory_order_acquire)) {
              return S_OK;
            }
            if (FAILED(error) || controller == nullptr) {
              self->showError(L"WebView2 could not create the editor window.");
              return FAILED(error) ? error : E_FAIL;
            }

            self->m_controller = controller;
            HRESULT result = self->m_controller->get_CoreWebView2(
                self->m_webView.GetAddressOf());
            if (FAILED(result)) {
              self->showError(L"Could not initialize the WebView2 page.");
              return result;
            }

            result = self->m_environment.As(&self->m_environment12);
            if (FAILED(result)) {
              self->showError(
                  L"This WebView2 Runtime lacks shared-buffer support.");
              return result;
            }
            result = self->m_webView.As(&self->m_webView17);
            if (FAILED(result)) {
              self->showError(
                  L"This WebView2 Runtime lacks shared-buffer support.");
              return result;
            }

            const auto assets = webAssetsPath();
            result = self->m_webView17->SetVirtualHostNameToFolderMapping(
                kVirtualHostName, assets.c_str(),
                COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
            if (FAILED(result)) {
              self->showError(L"Could not mount Strudel's packaged web assets.");
              return result;
            }

            auto eventSelf = Steinberg::IPtr<StrudelEditorView>(self);
            const auto messageHandler =
                Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                    [eventSelf](ICoreWebView2 *,
                                ICoreWebView2WebMessageReceivedEventArgs *args)
                        mutable -> HRESULT {
                      return eventSelf->handleWebMessage(args);
                    });
            result = self->m_webView->add_WebMessageReceived(
                messageHandler.Get(), &self->m_messageToken);
            if (FAILED(result)) {
              self->showError(L"Could not connect the Strudel audio bridge.");
              return result;
            }

            ComPtr<ICoreWebView2Settings> settings;
            if (SUCCEEDED(self->m_webView->get_Settings(&settings)) &&
                settings) {
              settings->put_IsWebMessageEnabled(TRUE);
            }

            self->updateBounds();
            const std::wstring url =
                std::wstring(L"https://") + kVirtualHostName + L"/index.html";
            return self->m_webView->Navigate(url.c_str());
          });

  return environment->CreateCoreWebView2Controller(
      static_cast<HWND>(systemWindow), callback.Get());
}

HRESULT StrudelEditorView::handleWebMessage(
    ICoreWebView2WebMessageReceivedEventArgs *args) {
  if (args == nullptr || m_closing.load(std::memory_order_acquire)) {
    return S_OK;
  }

  LPWSTR rawSource = nullptr;
  if (FAILED(args->get_Source(&rawSource)) || rawSource == nullptr) {
    return S_OK;
  }
  const std::wstring source(rawSource);
  CoTaskMemFree(rawSource);
  if (!beginsWith(source, L"https://strudel.local/")) {
    return S_OK;
  }

  LPWSTR rawString = nullptr;
  if (SUCCEEDED(args->TryGetWebMessageAsString(&rawString)) &&
      rawString != nullptr) {
    const std::wstring message(rawString);
    CoTaskMemFree(rawString);
    if (message == L"request-editor-code") {
      return sendEditorCode();
    }
    constexpr wchar_t kEditorCodePrefix[] = L"editor-code:";
    if (beginsWith(message, kEditorCodePrefix)) {
      const auto code = wideToUtf8(message.substr(
          sizeof(kEditorCodePrefix) / sizeof(kEditorCodePrefix[0]) - 1));
      if (code.size() <= 4 * 1024 * 1024) {
        m_processor->setEditorCode(code);
      }
      return S_OK;
    }
  } else if (rawString != nullptr) {
    CoTaskMemFree(rawString);
  }

  LPWSTR rawJson = nullptr;
  if (FAILED(args->get_WebMessageAsJson(&rawJson)) || rawJson == nullptr) {
    return S_OK;
  }
  const std::wstring json(rawJson);
  CoTaskMemFree(rawJson);

  if (json.find(L"request-audio-buffer") != std::wstring::npos) {
    return provideAudioBuffer();
  }

  if (json.find(L"audio-ready") != std::wstring::npos && m_reader != nullptr) {
    const auto key = json.find(L"\"writeFrame\"");
    if (key != std::wstring::npos) {
      const auto colon = json.find(L':', key);
      if (colon != std::wstring::npos) {
        const auto firstDigit = json.find_first_of(L"0123456789", colon + 1);
        if (firstDigit != std::wstring::npos) {
          wchar_t *end = nullptr;
          const auto value =
              std::wcstoul(json.c_str() + firstDigit, &end, 10);
          if (end != json.c_str() + firstDigit &&
              value <= std::numeric_limits<std::uint32_t>::max()) {
            m_reader->publishWriteFrame(
                static_cast<std::uint32_t>(value));
          }
        }
      }
    }
  }
  return S_OK;
}

HRESULT StrudelEditorView::sendEditorCode() {
  if (!m_webView) {
    return E_POINTER;
  }
  constexpr wchar_t kEditorCodePrefix[] = L"editor-code-state:";
  const auto code = utf8ToWide(m_processor->editorCode());
  const std::wstring message =
      std::wstring(kEditorCodePrefix) + code;
  return m_webView->PostWebMessageAsString(message.c_str());
}

HRESULT StrudelEditorView::provideAudioBuffer() {
  if (!m_environment12 || !m_webView17 || m_processor == nullptr) {
    return E_POINTER;
  }

  if (!m_sharedBuffer) {
    const auto rate = m_processor->sampleRate();
    if (rate < 8000 || rate > kMaximumSampleRate) {
      showError(L"The VST3 host supplied an unsupported sample rate.");
      return E_INVALIDARG;
    }

    const UINT64 byteCount =
        dexter::strudel::bridge::kSharedAudioHeaderBytes +
        static_cast<UINT64>(kRingCapacityFrames) *
            dexter::strudel::bridge::kSharedAudioChannels * sizeof(float);
    HRESULT result =
        m_environment12->CreateSharedBuffer(byteCount, &m_sharedBuffer);
    if (FAILED(result)) {
      showError(L"WebView2 could not allocate the shared audio buffer.");
      return result;
    }

    BYTE *mapping = nullptr;
    result = m_sharedBuffer->get_Buffer(&mapping);
    if (FAILED(result) || mapping == nullptr) {
      showError(L"WebView2 did not provide the shared audio buffer mapping.");
      return FAILED(result) ? result : E_FAIL;
    }

    dexter::strudel::bridge::SharedAudioHeader header{};
    header.magic = dexter::strudel::bridge::kSharedAudioMagic;
    header.version = dexter::strudel::bridge::kSharedAudioVersion;
    header.channels = dexter::strudel::bridge::kSharedAudioChannels;
    header.capacityFrames = kRingCapacityFrames;
    header.writeFrame = 0;
    header.sampleRate = rate;
    std::memcpy(mapping, &header, sizeof(header));

    m_reader = m_processor->retainSharedBuffer(m_sharedBuffer, rate);
    if (m_reader == nullptr) {
      showError(L"The native VST3 audio reader rejected the shared buffer.");
      return E_FAIL;
    }
  }

  const auto additionalData =
      std::wstring(L"{\"sampleRate\":") +
      std::to_wstring(m_processor->sampleRate()) + L"}";
  return m_webView17->PostSharedBufferToScript(
      m_sharedBuffer.Get(), COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
      additionalData.c_str());
}

void StrudelEditorView::updateBounds() {
  if (!m_controller) {
    return;
  }
  RECT bounds{rect.left, rect.top, rect.right, rect.bottom};
  m_controller->put_Bounds(bounds);
}

void StrudelEditorView::showError(const wchar_t *message) const {
  const auto parent = static_cast<HWND>(systemWindow);
  if (parent != nullptr && !m_closing.load(std::memory_order_acquire)) {
    MessageBoxW(parent, message, L"Dexter U.S. Strudel",
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
  }
}

void StrudelEditorView::closeWebView() noexcept {
  if (m_webView && m_messageToken.value != 0) {
    m_webView->remove_WebMessageReceived(m_messageToken);
    m_messageToken.value = 0;
  }
  if (m_controller) {
    m_controller->Close();
  }
  m_webView17.Reset();
  m_webView.Reset();
  m_controller.Reset();
  m_environment12.Reset();
  m_environment.Reset();
  m_sharedBuffer.Reset();
  m_reader = nullptr;
}

}  // namespace Steinberg::Vst
