// Windows counterpart of ImageText.swift: Windows.Media.Ocr behind the same
// contract. One image per invocation. Bytes arrive on stdin; no URLs, shell
// commands, user files, or network access are accepted by the native helper.
// Output matches the Swift helper: words with normalized corners (top-left
// origin), recognized line strings, and line bounds in recognized-image pixels.
#define NOMINMAX
#include <windows.h>
#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>
#include "ImageTextSandbox.h"

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.Streams.h>

using namespace winrt;
using namespace winrt::Windows::Graphics::Imaging;
using namespace winrt::Windows::Media::Ocr;
using namespace winrt::Windows::Storage::Streams;

namespace {

constexpr size_t kMaxBytes = 32 * 1024 * 1024;
constexpr double kMaxDeclaredPixels = 80'000'000;
constexpr double kMaxPixels = 8'000'000;
constexpr double kMaxSide = 4096;

void appendString(std::string& out, hstring const& text) {
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string utf8(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), utf8.data(), size, nullptr, nullptr);
  out += '"';
  for (const char ch : utf8) {
    if (ch == '"' || ch == '\\') { out += '\\'; out += ch; }
    else if (static_cast<unsigned char>(ch) < 0x20) {
      char escaped[8];
      std::snprintf(escaped, sizeof escaped, "\\u%04x", ch);
      out += escaped;
    } else out += ch;
  }
  out += '"';
}

void appendNumber(std::string& out, double value) {
  char number[32];
  std::snprintf(number, sizeof number, "%.6g", value);
  out += number;
}

void appendPoint(std::string& out, const char* name, double x, double y) {
  out += '"'; out += name; out += "\":{\"x\":";
  appendNumber(out, x);
  out += ",\"y\":";
  appendNumber(out, y);
  out += '}';
}

std::vector<uint8_t> readInput() {
  _setmode(_fileno(stdin), _O_BINARY);
  std::vector<uint8_t> data;
  uint8_t buffer[65536];
  size_t read;
  while ((read = std::fread(buffer, 1, sizeof buffer, stdin)) > 0) {
    data.insert(data.end(), buffer, buffer + read);
    if (data.size() > kMaxBytes) throw std::runtime_error("image too large");
  }
  if (data.empty()) throw std::runtime_error("empty image");
  return data;
}

// The image is decoded here, in the AppContainer worker: the codecs run with
// no capabilities, in a job that is killed on close.
SoftwareBitmap decode(std::vector<uint8_t> const& data) {
  InMemoryRandomAccessStream stream;
  DataWriter writer(stream);
  writer.WriteBytes(data);
  writer.StoreAsync().get();
  writer.DetachStream();
  stream.Seek(0);
  const BitmapDecoder decoder = BitmapDecoder::CreateAsync(stream).get();
  const double width = decoder.PixelWidth(), height = decoder.PixelHeight();
  if (width <= 0 || height <= 0 || width * height > kMaxDeclaredPixels) throw std::runtime_error("invalid dimensions");
  // Scale is applied before EXIF orientation, so it uses the stored size;
  // the returned bitmap is upright, within the side and pixel budgets.
  const double scale = std::min({1.0, kMaxSide / std::max(width, height), std::sqrt(kMaxPixels / (width * height))});
  BitmapTransform transform;
  transform.ScaledWidth(std::max(1u, static_cast<uint32_t>(std::lround(width * scale))));
  transform.ScaledHeight(std::max(1u, static_cast<uint32_t>(std::lround(height * scale))));
  transform.InterpolationMode(BitmapInterpolationMode::Fant);
  return decoder.GetSoftwareBitmapAsync(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied, transform,
    ExifOrientationMode::RespectExifOrientation, ColorManagementMode::DoNotColorManage).get();
}

OcrEngine createEngine() {
  OcrEngine engine = OcrEngine::TryCreateFromUserProfileLanguages();
  if (!engine) {
    const auto languages = OcrEngine::AvailableRecognizerLanguages();
    if (languages.Size() > 0) engine = OcrEngine::TryCreateFromLanguage(languages.GetAt(0));
  }
  if (!engine) throw std::runtime_error("no OCR language installed");
  return engine;
}

std::string recognize(SoftwareBitmap const& bitmap) {
  const OcrResult result = createEngine().RecognizeAsync(bitmap).get();
  const double width = bitmap.PixelWidth(), height = bitmap.PixelHeight();
  std::string words = "[", textLines = "[", lineBounds = "[";
  bool firstLine = true;
  for (OcrLine const& line : result.Lines()) {
    double left = INFINITY, top = INFINITY, right = -INFINITY, bottom = -INFINITY;
    std::string lineWords = "[";
    bool firstWord = true;
    for (OcrWord const& word : line.Words()) {
      const auto box = word.BoundingRect();
      left = std::min<double>(left, box.X); top = std::min<double>(top, box.Y);
      right = std::max<double>(right, box.X + box.Width); bottom = std::max<double>(bottom, box.Y + box.Height);
      if (!firstWord) lineWords += ',';
      firstWord = false;
      lineWords += "{\"text\":";
      appendString(lineWords, word.Text());
      lineWords += ',';
      appendPoint(lineWords, "topLeft", box.X / width, box.Y / height);
      lineWords += ',';
      appendPoint(lineWords, "topRight", (box.X + box.Width) / width, box.Y / height);
      lineWords += ',';
      appendPoint(lineWords, "bottomLeft", box.X / width, (box.Y + box.Height) / height);
      lineWords += '}';
    }
    if (firstWord) continue;
    lineWords += ']';
    if (!firstLine) { words += ','; textLines += ','; lineBounds += ','; }
    firstLine = false;
    words += lineWords;
    appendString(textLines, line.Text());
    lineBounds += "{\"x\":"; appendNumber(lineBounds, left);
    lineBounds += ",\"y\":"; appendNumber(lineBounds, top);
    lineBounds += ",\"width\":"; appendNumber(lineBounds, right - left);
    lineBounds += ",\"height\":"; appendNumber(lineBounds, bottom - top);
    lineBounds += '}';
  }
  return "{\"lines\":" + words + "],\"textLines\":" + textLines + "],\"lineBounds\":" + lineBounds + "]}";
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  try {
    if (!image_text_sandbox::contained()) {
      if (argc == 1) return image_text_sandbox::run();
      if (argc == 3 && std::wstring(argv[1]) == L"--sandbox-directory") return image_text_sandbox::run(argv[2]);
      throw std::runtime_error("invalid sandbox arguments");
    }
    init_apartment(apartment_type::multi_threaded);
    const std::string json = recognize(decode(readInput()));
    _setmode(_fileno(stdout), _O_BINARY);
    std::fwrite(json.data(), 1, json.size(), stdout);
    return 0;
  } catch (std::exception const& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  } catch (winrt::hresult_error const& error) {
    std::fprintf(stderr, "Native OCR error: %08lx\n", static_cast<unsigned long>(error.code().value));
    return 1;
  } catch (...) {
    std::fputs("Image text recognition failed.\n", stderr);
    return 1;
  }
}
