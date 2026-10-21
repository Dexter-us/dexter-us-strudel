#include "StrudelEditorView.h"

#include "StrudelVst3.h"

#include <Windows.h>
#include <ShlObj.h>
#include <ShObjIdl.h>
#include <shellapi.h>
#include <wrl.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cwchar>
#include <cwctype>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <string>
#include <system_error>
#include <vector>

extern "C" IMAGE_DOS_HEADER __ImageBase;

namespace Steinberg::Vst {
namespace {

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

constexpr wchar_t kVirtualHostName[] = L"strudel.local";
constexpr wchar_t kSampleVirtualHostName[] = L"strudel-samples.local";
constexpr std::uint32_t kRingCapacityFrames = 65536;
constexpr std::uint32_t kMaximumSampleRate = 192000;
constexpr std::size_t kMaximumIndexedSampleFiles = 10000;
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

std::filesystem::path pluginBundlePath() {
  const auto modulePath = pluginModulePath();
  if (modulePath.empty()) {
    return {};
  }
  return modulePath.parent_path().parent_path().parent_path();
}

std::filesystem::path webAssetsPath() {
  const auto bundlePath = pluginBundlePath();
  if (bundlePath.empty()) {
    return {};
  }
  return bundlePath / L"Contents" / L"Resources" / L"web";
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

bool prepareUserDataDirectory(const std::filesystem::path &root) {
  if (root.empty()) {
    return false;
  }
  std::error_code error;
  for (const auto *subfolder : {L"Prebake", L"Presets", L"Samples",
                                L"Exports"}) {
    std::filesystem::create_directories(root / subfolder, error);
    if (error) {
      return false;
    }
  }

  const auto probePath =
      root / (L".write-test-" + std::to_wstring(GetCurrentProcessId()));
  {
    std::ofstream probe(probePath, std::ios::binary | std::ios::trunc);
    if (!probe) {
      return false;
    }
    probe << "ok";
    if (!probe.good()) {
      std::filesystem::remove(probePath, error);
      return false;
    }
  }
  std::filesystem::remove(probePath, error);
  return !error;
}

std::filesystem::path userDataDirectory(bool &portable) {
  portable = false;
  const auto bundle = pluginBundlePath();
  if (!bundle.empty()) {
    const auto candidate = bundle / L"UserData";
    if (prepareUserDataDirectory(candidate)) {
      portable = true;
      return candidate;
    }
  }

  const auto webViewPath = webViewUserDataPath();
  if (webViewPath.empty()) {
    return {};
  }
  const auto fallback = webViewPath.parent_path() / L"UserData";
  return prepareUserDataDirectory(fallback) ? fallback
                                             : std::filesystem::path{};
}

std::filesystem::path sampleFolderSettingsPath() {
  const auto bundlePath = pluginBundlePath();
  return bundlePath.empty() ? std::filesystem::path{}
                            : bundlePath / L"sample-folder.txt";
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

bool isWithinBundle(const std::filesystem::path &folder) {
  const auto bundlePath = pluginBundlePath().lexically_normal();
  const auto normalizedFolder = folder.lexically_normal();
  if (bundlePath.empty()) {
    return false;
  }
  const auto relative = normalizedFolder.lexically_relative(bundlePath);
  if (relative.empty()) {
    return normalizedFolder == bundlePath;
  }
  return *relative.begin() != L"..";
}

std::string jsonEscape(const std::string &text) {
  std::string result;
  result.reserve(text.size() + 8);
  for (const unsigned char character : text) {
    switch (character) {
      case '"':
        result += "\\\"";
        break;
      case '\\':
        result += "\\\\";
        break;
      case '\b':
        result += "\\b";
        break;
      case '\f':
        result += "\\f";
        break;
      case '\n':
        result += "\\n";
        break;
      case '\r':
        result += "\\r";
        break;
      case '\t':
        result += "\\t";
        break;
      default:
        if (character < 0x20) {
          constexpr char hex[] = "0123456789abcdef";
          result += "\\u00";
          result += hex[(character >> 4) & 0xf];
          result += hex[character & 0xf];
        } else {
          result += static_cast<char>(character);
        }
    }
  }
  return result;
}

bool isSupportedSampleFile(const std::filesystem::path &path) {
  auto extension = path.extension().wstring();
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](wchar_t character) {
                   return static_cast<wchar_t>(std::towlower(character));
                 });
  return extension == L".wav" || extension == L".wave" ||
         extension == L".aif" || extension == L".aiff" ||
         extension == L".mp3" || extension == L".ogg" ||
         extension == L".m4a" || extension == L".aac" ||
         extension == L".flac";
}

std::filesystem::path loadSampleFolderSetting(bool &remembered) {
  remembered = false;
  const auto bundlePath = pluginBundlePath();
  const auto settingsPath = sampleFolderSettingsPath();
  if (!bundlePath.empty() && !settingsPath.empty()) {
    std::ifstream file(settingsPath, std::ios::binary);
    if (file) {
      const std::string utf8Path((std::istreambuf_iterator<char>(file)),
                                 std::istreambuf_iterator<char>());
      const std::filesystem::path relative(utf8ToWide(utf8Path));
      if (!relative.empty() && !relative.is_absolute()) {
        const auto savedFolder = (bundlePath / relative).lexically_normal();
        std::error_code statusError;
        if (isWithinBundle(savedFolder) &&
            std::filesystem::is_directory(savedFolder, statusError) &&
            !statusError) {
          remembered = true;
          return savedFolder;
        }
      }
    }
  }

  if (!bundlePath.empty()) {
    for (const auto *candidate : {L"Samples", L"samples",
                                  L"uzu-drumkit-main",
                                  L"UserData/Samples"}) {
      const auto folder = bundlePath / candidate;
      std::error_code statusError;
      if (std::filesystem::is_directory(folder, statusError) && !statusError) {
        remembered = true;
        return folder;
      }
    }
  }
  return {};
}

bool saveSampleFolderSetting(const std::filesystem::path &folder) {
  const auto settingsPath = sampleFolderSettingsPath();
  const auto bundlePath = pluginBundlePath();
  if (settingsPath.empty() || bundlePath.empty() || !isWithinBundle(folder)) {
    return false;
  }
  const auto relative = folder.lexically_normal().lexically_relative(
      bundlePath.lexically_normal());
  const auto utf8Path = relative.generic_u8string();
  std::ofstream file(settingsPath, std::ios::binary | std::ios::trunc);
  if (!file) {
    return false;
  }
  file.write(utf8Path.data(), static_cast<std::streamsize>(utf8Path.size()));
  return file.good();
}

std::vector<std::string> listSampleFiles(const std::filesystem::path &root,
                                         bool &truncated) {
  std::vector<std::string> files;
  truncated = false;
  std::error_code error;
  const auto options = std::filesystem::directory_options::skip_permission_denied;
  std::filesystem::recursive_directory_iterator iterator(root, options, error);
  const std::filesystem::recursive_directory_iterator end;
  while (!error && iterator != end) {
    std::error_code entryError;
    if (iterator->is_regular_file(entryError) && !entryError &&
        isSupportedSampleFile(iterator->path())) {
      const auto relative = iterator->path().lexically_relative(root);
      files.push_back(relative.generic_u8string());
      if (files.size() >= kMaximumIndexedSampleFiles) {
        truncated = true;
        break;
      }
    }
    iterator.increment(error);
    if (error) {
      error.clear();
      if (iterator != end) {
        iterator.increment(error);
      }
    }
  }
  std::sort(files.begin(), files.end());
  return files;
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
            (void)self->setWebViewBackgroundAlpha(255);

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

            self->m_userDataPath =
                userDataDirectory(self->m_userDataPortable);
            self->m_sampleFolderPath =
                loadSampleFolderSetting(self->m_sampleFolderRemembered);
            self->m_sampleFolderPortable =
                !self->m_sampleFolderPath.empty() &&
                isWithinBundle(self->m_sampleFolderPath);
            if (!self->m_sampleFolderPath.empty()) {
              result = self->mapSampleFolder(self->m_sampleFolderPath);
              if (FAILED(result)) {
                self->m_sampleFolderPath.clear();
                self->m_sampleFolderPortable = false;
                self->m_sampleFolderRemembered = false;
              }
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
    if (message == L"request-sample-folder-index") {
      return sendSampleFolderIndex();
    }
    if (message == L"choose-sample-folder") {
      return selectSampleFolder();
    }
    if (message == L"request-portable-data-info") {
      return sendPortableDataInfo();
    }
    if (message == L"request-portable-prebake") {
      return sendPortablePrebake();
    }
    if (message == L"reset-portable-prebake") {
      return resetPortablePrebake();
    }
    if (message == L"open-portable-data-folder") {
      return openPortableDataFolder();
    }
    constexpr wchar_t kSavePortablePrebakePrefix[] =
        L"save-portable-prebake:";
    if (beginsWith(message, kSavePortablePrebakePrefix)) {
      const auto prefixLength =
          sizeof(kSavePortablePrebakePrefix) /
              sizeof(kSavePortablePrebakePrefix[0]) -
          1;
      const auto source = wideToUtf8(message.substr(prefixLength));
      return savePortablePrebake(source);
    }
    constexpr wchar_t kWebViewBackgroundAlphaPrefix[] =
        L"webview-background-alpha:";
    if (beginsWith(message, kWebViewBackgroundAlphaPrefix)) {
      const auto prefixLength = sizeof(kWebViewBackgroundAlphaPrefix) /
                                    sizeof(kWebViewBackgroundAlphaPrefix[0]) -
                                1;
      wchar_t *end = nullptr;
      const auto alpha =
          std::wcstoul(message.c_str() + prefixLength, &end, 10);
      const bool valid = end != message.c_str() + prefixLength &&
                         end != nullptr && *end == L'\0' && alpha <= 255;
      const auto alphaResult =
          valid ? setWebViewBackgroundAlpha(static_cast<BYTE>(alpha))
                : E_INVALIDARG;
      if (m_webView) {
        m_webView->PostWebMessageAsJson(
            SUCCEEDED(alphaResult)
                ? L"{\"type\":\"webview-background-alpha-status\",\"webViewAccepted\":true}"
                : L"{\"type\":\"webview-background-alpha-status\",\"webViewAccepted\":false}");
      }
      return S_OK;
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

HRESULT StrudelEditorView::sendPortableDataInfo() {
  if (!m_webView) {
    return E_POINTER;
  }
  const auto path = wideToUtf8(m_userDataPath.wstring());
  const std::string json =
      "{\"type\":\"portable-data-info\",\"path\":\"" + jsonEscape(path) +
      "\",\"portable\":" + (m_userDataPortable ? "true" : "false") + "}";
  const auto wideJson = utf8ToWide(json);
  return m_webView->PostWebMessageAsJson(wideJson.c_str());
}

HRESULT StrudelEditorView::sendPortablePrebake() {
  if (!m_webView) {
    return E_POINTER;
  }
  if (m_userDataPath.empty()) {
    return m_webView->PostWebMessageAsString(
        L"portable-prebake-error:No writable data folder is available.");
  }
  const auto path =
      m_userDataPath / L"Prebake" / L"prebake.strudel";
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    return m_webView->PostWebMessageAsString(
        L"portable-prebake-missing");
  }
  constexpr std::size_t kMaximumPrebakeBytes = 2 * 1024 * 1024;
  file.seekg(0, std::ios::end);
  const auto fileSize = static_cast<std::streamoff>(file.tellg());
  if (fileSize < 0 ||
      static_cast<std::uint64_t>(fileSize) > kMaximumPrebakeBytes) {
    return m_webView->PostWebMessageAsString(
        L"portable-prebake-error:Portable Prebake file exceeds 2 MB.");
  }
  file.seekg(0, std::ios::beg);
  std::string source(static_cast<std::size_t>(fileSize), '\0');
  if (!source.empty()) {
    file.read(source.data(), static_cast<std::streamsize>(source.size()));
    if (!file.good()) {
      return m_webView->PostWebMessageAsString(
          L"portable-prebake-error:Could not read the portable Prebake file.");
    }
  }
  const auto wideSource = utf8ToWide(source);
  if (!source.empty() && wideSource.empty()) {
    return m_webView->PostWebMessageAsString(
        L"portable-prebake-error:Portable Prebake file is not valid UTF-8.");
  }
  const std::wstring message =
      std::wstring(L"portable-prebake-content:") + wideSource;
  return m_webView->PostWebMessageAsString(message.c_str());
}

HRESULT StrudelEditorView::savePortablePrebake(const std::string &source) {
  constexpr std::size_t kMaximumPrebakeBytes = 2 * 1024 * 1024;
  HRESULT result = S_OK;
  if (m_userDataPath.empty()) {
    result = E_ACCESSDENIED;
  } else if (source.size() > kMaximumPrebakeBytes) {
    result = HRESULT_FROM_WIN32(ERROR_FILE_TOO_LARGE);
  } else {
    const auto path =
        m_userDataPath / L"Prebake" / L"prebake.strudel";
    auto temporaryPath = path;
    temporaryPath += L".tmp";
    {
      std::ofstream file(temporaryPath, std::ios::binary | std::ios::trunc);
      if (!file) {
        result = E_ACCESSDENIED;
      } else {
        file.write(source.data(), static_cast<std::streamsize>(source.size()));
        file.flush();
        if (!file.good()) {
          result = HRESULT_FROM_WIN32(ERROR_WRITE_FAULT);
        }
      }
    }
    if (SUCCEEDED(result) &&
        !MoveFileExW(temporaryPath.c_str(), path.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      result = HRESULT_FROM_WIN32(GetLastError());
    }
    if (FAILED(result)) {
      std::error_code ignored;
      std::filesystem::remove(temporaryPath, ignored);
    }
  }
  if (m_webView) {
    m_webView->PostWebMessageAsJson(
        SUCCEEDED(result)
            ? L"{\"type\":\"portable-prebake-save-result\",\"success\":true}"
            : L"{\"type\":\"portable-prebake-save-result\",\"success\":false}");
  }
  return result;
}

HRESULT StrudelEditorView::resetPortablePrebake() {
  std::error_code error;
  if (!m_userDataPath.empty()) {
    std::filesystem::remove(
        m_userDataPath / L"Prebake" / L"prebake.strudel", error);
  } else {
    error = std::make_error_code(std::errc::permission_denied);
  }
  const auto result = error ? HRESULT_FROM_WIN32(error.value()) : S_OK;
  if (m_webView) {
    m_webView->PostWebMessageAsJson(
        SUCCEEDED(result)
            ? L"{\"type\":\"portable-prebake-reset-result\",\"success\":true}"
            : L"{\"type\":\"portable-prebake-reset-result\",\"success\":false}");
  }
  return result;
}

HRESULT StrudelEditorView::openPortableDataFolder() {
  if (!m_webView) {
    return E_POINTER;
  }
  std::intptr_t shellResult = 0;
  if (!m_userDataPath.empty()) {
    shellResult = reinterpret_cast<std::intptr_t>(ShellExecuteW(
        static_cast<HWND>(systemWindow), L"open", m_userDataPath.c_str(),
        nullptr, nullptr, SW_SHOWNORMAL));
  }
  const bool opened = shellResult > 32;
  m_webView->PostWebMessageAsJson(
      opened
          ? L"{\"type\":\"portable-data-folder-opened\",\"success\":true}"
          : L"{\"type\":\"portable-data-folder-opened\",\"success\":false}");
  return opened ? S_OK : E_FAIL;
}

HRESULT StrudelEditorView::setWebViewBackgroundAlpha(BYTE alpha) {
  if (!m_controller) {
    return E_POINTER;
  }
  Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
  const auto queryResult = m_controller.As(&controller2);
  if (FAILED(queryResult)) {
    return queryResult;
  }

  COREWEBVIEW2_COLOR background{};
  background.A = alpha;
  background.R = 17;
  background.G = 18;
  background.B = 15;
  return controller2->put_DefaultBackgroundColor(background);
}

HRESULT StrudelEditorView::mapSampleFolder(
    const std::filesystem::path &folder) {
  if (!m_webView17) {
    return E_POINTER;
  }
  m_webView17->ClearVirtualHostNameToFolderMapping(kSampleVirtualHostName);
  if (folder.empty()) {
    return S_OK;
  }
  return m_webView17->SetVirtualHostNameToFolderMapping(
      kSampleVirtualHostName, folder.c_str(),
      COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
}

HRESULT StrudelEditorView::sendSampleFolderIndex() {
  if (!m_webView) {
    return E_POINTER;
  }

  std::error_code statusError;
  const bool selected = !m_sampleFolderPath.empty() &&
                        std::filesystem::is_directory(m_sampleFolderPath,
                                                      statusError) &&
                        !statusError;
  bool truncated = false;
  const auto files =
      selected ? listSampleFiles(m_sampleFolderPath, truncated)
               : std::vector<std::string>{};
  const auto folderName =
      selected ? wideToUtf8(m_sampleFolderPath.filename().wstring())
               : std::string{};
  std::string json =
      "{\"type\":\"sample-folder-index\",\"selected\":" +
      std::string(selected ? "true" : "false") +
      ",\"portable\":" +
      std::string(selected && m_sampleFolderPortable ? "true" : "false") +
      ",\"remembered\":" +
      std::string(selected && m_sampleFolderRemembered ? "true" : "false") +
      ",\"folder\":\"" + jsonEscape(folderName) +
      "\",\"truncated\":" + (truncated ? "true" : "false") +
      ",\"files\":[";
  for (std::size_t index = 0; index < files.size(); ++index) {
    if (index != 0) {
      json += ',';
    }
    json += '"';
    json += jsonEscape(files[index]);
    json += '"';
  }
  json += "]}";
  const auto wideJson = utf8ToWide(json);
  return m_webView->PostWebMessageAsJson(wideJson.c_str());
}

HRESULT StrudelEditorView::selectSampleFolder() {
  if (!m_webView || !m_webView17) {
    return E_POINTER;
  }

  ComPtr<IFileOpenDialog> dialog;
  HRESULT result =
      CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                       IID_PPV_ARGS(&dialog));
  if (FAILED(result)) {
    m_webView->PostWebMessageAsJson(
        L"{\"type\":\"sample-folder-error\",\"message\":\"Windows could not open the folder picker.\"}");
    return result;
  }

  FILEOPENDIALOGOPTIONS options{};
  result = dialog->GetOptions(&options);
  if (FAILED(result)) {
    return result;
  }
  result = dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM |
                              FOS_PATHMUSTEXIST);
  if (FAILED(result)) {
    return result;
  }
  dialog->SetTitle(L"Choose a folder containing audio samples");

  const auto bundlePath = pluginBundlePath();
  if (!bundlePath.empty()) {
    ComPtr<IShellItem> initialFolder;
    if (SUCCEEDED(SHCreateItemFromParsingName(
            bundlePath.c_str(), nullptr, IID_PPV_ARGS(&initialFolder)))) {
      dialog->SetFolder(initialFolder.Get());
    }
  }

  result = dialog->Show(static_cast<HWND>(systemWindow));
  if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
    return S_OK;
  }
  if (FAILED(result)) {
    return result;
  }

  ComPtr<IShellItem> selectedItem;
  result = dialog->GetResult(&selectedItem);
  if (FAILED(result)) {
    return result;
  }

  PWSTR selectedPath = nullptr;
  result = selectedItem->GetDisplayName(SIGDN_FILESYSPATH, &selectedPath);
  if (FAILED(result) || selectedPath == nullptr) {
    return FAILED(result) ? result : E_FAIL;
  }
  const std::filesystem::path folder(selectedPath);
  CoTaskMemFree(selectedPath);
  std::error_code statusError;
  if (!std::filesystem::is_directory(folder, statusError) || statusError) {
    m_webView->PostWebMessageAsJson(
        L"{\"type\":\"sample-folder-error\",\"message\":\"The selected folder is not available.\"}");
    return E_INVALIDARG;
  }

  result = mapSampleFolder(folder);
  if (FAILED(result)) {
    m_webView->PostWebMessageAsJson(
        L"{\"type\":\"sample-folder-error\",\"message\":\"WebView2 could not access that folder.\"}");
    return result;
  }

  m_sampleFolderPath = folder;
  m_sampleFolderPortable = isWithinBundle(folder);
  m_sampleFolderRemembered = false;
  if (m_sampleFolderPortable) {
    m_sampleFolderRemembered = saveSampleFolderSetting(folder);
  } else {
    std::error_code ignored;
    std::filesystem::remove(sampleFolderSettingsPath(), ignored);
  }
  return sendSampleFolderIndex();
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
