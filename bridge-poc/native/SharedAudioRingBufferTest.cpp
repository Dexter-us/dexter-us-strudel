#include "SharedAudioRingBuffer.hpp"

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

using dexter::strudel::bridge::kSharedAudioChannels;
using dexter::strudel::bridge::kSharedAudioHeaderBytes;
using dexter::strudel::bridge::kSharedAudioMagic;
using dexter::strudel::bridge::kSharedAudioVersion;
using dexter::strudel::bridge::SharedAudioHeader;
using dexter::strudel::bridge::SharedAudioRingBufferReader;

namespace {

std::vector<std::uint8_t> makeMapping(std::uint32_t capacity,
                                      std::uint32_t sampleRate) {
  std::vector<std::uint8_t> mapping(
      kSharedAudioHeaderBytes + capacity * kSharedAudioChannels * sizeof(float));
  SharedAudioHeader header{};
  header.magic = kSharedAudioMagic;
  header.version = kSharedAudioVersion;
  header.channels = kSharedAudioChannels;
  header.capacityFrames = capacity;
  header.sampleRate = sampleRate;
  std::memcpy(mapping.data(), &header, sizeof(header));
  return mapping;
}

void writeFrame(std::vector<std::uint8_t> &mapping, std::uint32_t capacity,
                std::uint32_t frame, float left, float right) {
  auto *samples = reinterpret_cast<float *>(mapping.data() +
                                            kSharedAudioHeaderBytes);
  const auto slot = frame % capacity;
  samples[slot * 2] = left;
  samples[slot * 2 + 1] = right;
}

void testCopiesPublishedFramesAndSilencesUnderruns() {
  constexpr std::uint32_t capacity = 8;
  auto mapping = makeMapping(capacity, 48000);
  for (std::uint32_t i = 0; i < 3; ++i) {
    writeFrame(mapping, capacity, i, static_cast<float>(i + 1),
               -static_cast<float>(i + 1));
  }

  SharedAudioRingBufferReader reader;
  assert(reader.attach(mapping.data(), mapping.size(), 48000));
  reader.publishWriteFrame(3);

  std::array<float, 5> left{};
  std::array<float, 5> right{};
  float *outputs[] = {left.data(), right.data()};
  reader.process(outputs, 2, 5);

  assert(left[0] == 1.0f && right[0] == -1.0f);
  assert(left[1] == 2.0f && right[1] == -2.0f);
  assert(left[2] == 3.0f && right[2] == -3.0f);
  assert(left[3] == 0.0f && right[3] == 0.0f);
  assert(left[4] == 0.0f && right[4] == 0.0f);
}

void testOverrunSkipsStaleFrames() {
  constexpr std::uint32_t capacity = 4;
  auto mapping = makeMapping(capacity, 48000);
  for (std::uint32_t i = 4; i < 8; ++i) {
    writeFrame(mapping, capacity, i, static_cast<float>(i),
               -static_cast<float>(i));
  }

  SharedAudioRingBufferReader reader;
  assert(reader.attach(mapping.data(), mapping.size(), 48000));
  reader.publishWriteFrame(8);

  std::array<float, 4> left{};
  std::array<float, 4> right{};
  float *outputs[] = {left.data(), right.data()};
  reader.process(outputs, 2, 4);

  for (std::uint32_t i = 0; i < capacity; ++i) {
    assert(left[i] == static_cast<float>(i + 4));
    assert(right[i] == -static_cast<float>(i + 4));
  }
}

void testRejectsBadFormatAndRate() {
  auto mapping = makeMapping(8, 48000);
  SharedAudioRingBufferReader reader;
  assert(!reader.attach(mapping.data(), mapping.size(), 44100));

  auto *header = reinterpret_cast<SharedAudioHeader *>(mapping.data());
  header->magic = 0;
  assert(!reader.attach(mapping.data(), mapping.size(), 48000));
}

} // namespace

int main() {
  testCopiesPublishedFramesAndSilencesUnderruns();
  testOverrunSkipsStaleFrames();
  testRejectsBadFormatAndRate();
  return 0;
}
