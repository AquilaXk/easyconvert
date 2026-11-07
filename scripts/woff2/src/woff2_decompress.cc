/* Copyright 2013 Google Inc. All Rights Reserved.

   Distributed under MIT license.
   See file LICENSE for detail or copy at https://opensource.org/licenses/MIT
*/

/* A very simple commandline tool for decompressing woff2 format files to true
   type font files. */

#include <algorithm>
#include <string>

#include "./file.h"
#include <woff2/decode.h>

namespace {

/* EasyConvert: what is checked in the 48 bytes of the header before the buffer of the output is allocated. */
const size_t kHeaderSize = 48;
const size_t kHeaderLengthAt = 8;
const size_t kHeaderNumTablesAt = 12;
/* The tables of one directory (WOFF2_MAX_TABLES of the in-process reader). */
const unsigned kMaxTables = 4096;
/* The size of the output is announced by a field of the header that the decoder does not believe, so the buffer starts at
   most this many times the size of the input and grows when the font needs more (the decoder itself refuses a font that
   expands past 100 times, kMaxPlausibleCompressionRatio of woff2_dec.cc). */
const size_t kPresizeFactor = 100;

unsigned ReadU16(const uint8_t* p) { return (p[0] << 8) | p[1]; }
size_t ReadU32(const uint8_t* p) {
  return (static_cast<size_t>(p[0]) << 24) | (p[1] << 16) | (p[2] << 8) | p[3];
}

}  // namespace

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "One argument, the input filename, must be provided.\n");
    return 1;
  }

  std::string filename(argv[1]);
  std::string outfilename = filename.substr(0, filename.find_last_of(".")) + ".ttf";

  // Note: update woff2_dec_fuzzer_new_entry.cc if this pattern changes.
  std::string input = woff2::GetFileContent(filename);
  const uint8_t* raw_input = reinterpret_cast<const uint8_t*>(input.data());
  if (input.size() < kHeaderSize ||
      ReadU32(raw_input + kHeaderLengthAt) != input.size() ||
      ReadU16(raw_input + kHeaderNumTablesAt) == 0 ||
      ReadU16(raw_input + kHeaderNumTablesAt) > kMaxTables ||
      woff2::ComputeWOFF2FinalSize(raw_input, input.size()) >
          woff2::kDefaultMaxSize) {
    fprintf(stderr, "The header is not that of a font this decoder reads.\n");
    return 1;
  }
  std::string output(
      std::min(woff2::ComputeWOFF2FinalSize(raw_input, input.size()),
               kPresizeFactor * input.size()),
      0);
  woff2::WOFF2StringOut out(&output);

  const bool ok = woff2::ConvertWOFF2ToTTF(raw_input, input.size(), &out);

  if (ok) {
    woff2::SetFileContents(outfilename, output.begin(),
        output.begin() + out.Size());
  }
  return ok ? 0 : 1;
}
