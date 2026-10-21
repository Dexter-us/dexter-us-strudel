cmake_minimum_required(VERSION 3.25)
project(DexterUSStrudelVST3 VERSION 0.2.13 LANGUAGES C CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The WebView2/VST3 editor target is Windows-only.")
endif()

set(VST3_SDK_DIR "${CMAKE_CURRENT_LIST_DIR}/../../../third_party/vst3sdk")
if(NOT EXISTS "${VST3_SDK_DIR}/CMakeLists.txt")
  message(FATAL_ERROR
    "VST3 SDK is missing. Run: git submodule update --init --recursive")
endif()

set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_BUNDLE_FOR_WINDOWS ON CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
add_subdirectory("${VST3_SDK_DIR}" "${CMAKE_BINARY_DIR}/vst3sdk")
list(APPEND CMAKE_MODULE_PATH "${VST3_SDK_DIR}/cmake/modules")
include(SMTG_AddVST3Library)

set(WEBVIEW2_VERSION "1.0.3537.50")
set(WEBVIEW2_SHA256
    "5ea526bbd728adda0da4d31219267e96460494a427e4894c4e09d9f320f4b9aa")
set(WEBVIEW2_ARCH "x64")
if(CMAKE_GENERATOR_PLATFORM MATCHES "ARM64")
  set(WEBVIEW2_ARCH "arm64")
elseif(CMAKE_SIZEOF_VOID_P EQUAL 4)
  set(WEBVIEW2_ARCH "x86")
endif()

set(WEBVIEW2_ROOT "${CMAKE_BINARY_DIR}/webview2")
set(WEBVIEW2_PACKAGE
    "${CMAKE_BINARY_DIR}/microsoft.web.webview2.${WEBVIEW2_VERSION}.nupkg")
if(NOT EXISTS "${WEBVIEW2_ROOT}/build/native/include/WebView2.h")
  file(DOWNLOAD
    "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2_VERSION}/microsoft.web.webview2.${WEBVIEW2_VERSION}.nupkg"
    "${WEBVIEW2_PACKAGE}"
    EXPECTED_HASH "SHA256=${WEBVIEW2_SHA256}"
    TLS_VERIFY ON
    SHOW_PROGRESS
    STATUS WEBVIEW2_DOWNLOAD_STATUS)
  list(GET WEBVIEW2_DOWNLOAD_STATUS 0 WEBVIEW2_DOWNLOAD_CODE)
  if(NOT WEBVIEW2_DOWNLOAD_CODE EQUAL 0)
    message(FATAL_ERROR "Could not download the pinned WebView2 SDK package.")
  endif()
  file(ARCHIVE_EXTRACT INPUT "${WEBVIEW2_PACKAGE}"
       DESTINATION "${WEBVIEW2_ROOT}")
endif()

set(STRUDEL_WEB_DIR "${CMAKE_CURRENT_LIST_DIR}/../../web")
set(STRUDEL_WEB_DIST "${STRUDEL_WEB_DIR}/dist")
if(NOT EXISTS "${STRUDEL_WEB_DIST}/index.html")
  message(FATAL_ERROR
    "Strudel web assets are missing. Run npm ci and npm run build in bridge-poc/web first.")
endif()

smtg_add_vst3plugin(DexterUSStrudel
  StrudelVst3.cpp
  StrudelEditorView.cpp
  StrudelVst3.h
  StrudelEditorView.h
  "${VST3_SDK_DIR}/public.sdk/source/vst/vstsinglecomponenteffect.cpp")

target_compile_features(DexterUSStrudel PRIVATE cxx_std_17)
target_compile_definitions(DexterUSStrudel PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX)
target_include_directories(DexterUSStrudel PRIVATE
  "${CMAKE_CURRENT_LIST_DIR}/.."
  "${VST3_SDK_DIR}"
  "${WEBVIEW2_ROOT}/build/native/include")
target_link_libraries(DexterUSStrudel PRIVATE
  sdk
  "${WEBVIEW2_ROOT}/build/native/${WEBVIEW2_ARCH}/WebView2LoaderStatic.lib"
  ole32
  shell32
  shlwapi
  user32)

get_target_property(STRUDEL_PLUGIN_PACKAGE DexterUSStrudel
                    SMTG_PLUGIN_PACKAGE_PATH)
add_custom_command(TARGET DexterUSStrudel POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E copy_directory
          "${STRUDEL_WEB_DIST}"
          "${STRUDEL_PLUGIN_PACKAGE}/Contents/Resources/web"
  COMMENT "Copying Strudel web assets into the VST3 package"
  VERBATIM)
