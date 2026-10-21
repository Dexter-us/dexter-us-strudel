#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace dexter::strudel::bridge {

inline constexpr std::uint32_t kSharedAudioMagic = 0x53425247; // "SBRG"
inline constexpr std::uint32_t kSharedAudioVersion = 1;
inline constexpr std::size_t kSharedAudioHeaderBytes = 64;
inline constexpr std::uint32_t kSharedAudioChannels = 2;

// The header is written by the native WebView2 host before it shares the
// mapping with JavaScript. JavaScript publishes writeFrame, then signals the
// host with a WebView2 message. The VST3 audio thread consumes only the last
// frame count published by the host's UI/message thread.
struct SharedAudioHeader {
  std::uint32_t magic;
  std::uint32_t version;
  std::uint32_t channels;
  std::uint32_t capacityFrames;
  std::uint32_t writeFrame;
  std::uint32_t sampleRate;
  std::uint32_t reserved[10];
};

static_assert(sizeof(SharedAudioHeader) == kSharedAudioHeaderBytes);
static_assert(std::atomic<std::uint32_t>::is_always_lock_free,
              "The VST3 audio callback requires lock-free 32-bit atomics.");

class SharedAudioRingBufferReader {
public:
  bool attach(void *mapping, std::size_t mappingBytes,
              std::uint32_t expectedSampleRate) noexcept {
    detach();
    if (mapping == nullptr || mappingBytes < kSharedAudioHeaderBytes) {
      return false;
    }

    const auto *bytes = static_cast<const std::uint8_t *>(mapping);
    SharedAudioHeader header{};
    std::memcpy(&header, bytes, sizeof(header));

    if (header.magic != kSharedAudioMagic ||
        header.version != kSharedAudioVersion ||
        header.channels != kSharedAudioChannels ||
        header.capacityFrames == 0 ||
        header.sampleRate != expectedSampleRate) {
      return false;
    }

    const auto requiredBytes =
        kSharedAudioHeaderBytes +
        static_cast<std::size_t>(header.capacityFrames) *
            header.channels * sizeof(float);
    if (requiredBytes > mappingBytes) {
      return false;
    }

    m_samples = reinterpret_cast<const float *>(bytes + kSharedAudioHeaderBytes);
    m_capacityFrames = header.capacityFrames;
    m_readFrame = header.writeFrame;
    m_publishedWriteFrame.store(header.writeFrame, std::memory_order_relaxed);
    return true;
  }

  void detach() noexcept {
    m_samples = nullptr;
    m_capacityFrames = 0;
    m_readFrame = 0;
    m_publishedWriteFrame.store(0, std::memory_order_relaxed);
  }

  // Called from the WebView2 message/UI thread after the matching PCM block
  // has been written into the shared mapping.
  void publishWriteFrame(std::uint32_t writeFrame) noexcept {
    m_publishedWriteFrame.store(writeFrame, std::memory_order_release);
  }

  // Called from the VST3 process callback. It never allocates, blocks, or
  // calls into WebView2. Missing frames are rendered as silence.
  void process(float **outputs, std::uint32_t outputChannels,
               std::uint32_t frameCount) noexcept {
    if (outputs == nullptr) {
      return;
    }

    for (std::uint32_t channel = 0; channel < outputChannels; ++channel) {
      if (outputs[channel] != nullptr) {
        std::memset(outputs[channel], 0, sizeof(float) * frameCount);
      }
    }

    if (m_samples == nullptr || m_capacityFrames == 0 ||
        outputChannels < kSharedAudioChannels) {
      return;
    }

    const auto published =
        m_publishedWriteFrame.load(std::memory_order_acquire);
    auto available = static_cast<std::uint32_t>(published - m_readFrame);

    if (available > m_capacityFrames) {
      // The renderer fell behind the host. Skip the oldest frames and keep
      // the newest complete ring window rather than replaying stale audio.
      const auto skipped = available - m_capacityFrames;
      m_readFrame = static_cast<std::uint32_t>(m_readFrame + skipped);
      available = m_capacityFrames;
    }

    const auto framesToCopy =
        available < frameCount ? available : frameCount;
    for (std::uint32_t frame = 0; frame < framesToCopy; ++frame) {
      const auto slot = (m_readFrame + frame) % m_capacityFrames;
      const auto sampleOffset = static_cast<std::size_t>(slot) * 2;
      outputs[0][frame] = m_samples[sampleOffset];
      outputs[1][frame] = m_samples[sampleOffset + 1];
    }
    m_readFrame =
        static_cast<std::uint32_t>(m_readFrame + framesToCopy);
  }

private:
  const float *m_samples = nullptr;
  std::uint32_t m_capacityFrames = 0;
  std::uint32_t m_readFrame = 0;
  std::atomic<std::uint32_t> m_publishedWriteFrame{0};
};

} // namespace dexter::strudel::bridge
