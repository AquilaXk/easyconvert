/* Copyright 2013 Google Inc. All Rights Reserved.

   Distributed under MIT license.
   See file LICENSE for detail or copy at https://opensource.org/licenses/MIT
*/

/* A commandline tool for compressing ttf format files to woff2. */

#include <stdlib.h>
#include <string>

#include "file.h"
#include <woff2/encode.h>

namespace {

/* EasyConvert: the sfnt header and the tables of one font (WOFF2_MAX_DECODED_BYTES and WOFF2_MAX_TABLES of the in-process reader). */
const size_t kSfntHeaderSize = 12;
const size_t kSfntNumTablesAt = 4;
const unsigned kMaxTables = 4096;
const size_t kMaxInputSize = 256 * 1024 * 1024;
const int kMaxQuality = 11;

}  // namespace

int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) {
    fprintf(stderr, "The input filename, and optionally the Brotli quality (0 to 11), must be provided.\n");
    return 1;
  }
  int quality = kMaxQuality;
  if (argc == 3) {
    char* end = NULL;
    long value = strtol(argv[2], &end, 10);
    if (end == argv[2] || *end != '\0' || value < 0 || value > kMaxQuality) {
      fprintf(stderr, "The Brotli quality must be a number from 0 to 11.\n");
      return 1;
    }
    quality = static_cast<int>(value);
  }

  std::string filename(argv[1]);
  std::string outfilename = filename.substr(0, filename.find_last_of(".")) + ".woff2";
  fprintf(stdout, "Processing %s => %s\n",
    filename.c_str(), outfilename.c_str());
  std::string input = woff2::GetFileContent(filename);

  const uint8_t* input_data = reinterpret_cast<const uint8_t*>(input.data());
  if (input.size() < kSfntHeaderSize || input.size() > kMaxInputSize ||
      ((input_data[kSfntNumTablesAt] << 8) | input_data[kSfntNumTablesAt + 1]) > kMaxTables) {
    fprintf(stderr, "The input is not a font this encoder reads.\n");
    return 1;
  }
  size_t output_size = woff2::MaxWOFF2CompressedSize(input_data, input.size());
  std::string output(output_size, 0);
  uint8_t* output_data = reinterpret_cast<uint8_t*>(&output[0]);

  woff2::WOFF2Params params;
  params.brotli_quality = quality;
  if (!woff2::ConvertTTFToWOFF2(input_data, input.size(),
                                output_data, &output_size, params)) {
    fprintf(stderr, "Compression failed.\n");
    return 1;
  }
  output.resize(output_size);

  woff2::SetFileContents(outfilename, output.begin(), output.end());

  return 0;
}
