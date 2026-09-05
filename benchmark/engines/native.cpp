// Benchmark-only stdin/file protocol. Not a production HTTP server.
#include <vips/vips.h>
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

int main(int argc, char **argv) {
  if (VIPS_INIT(argv[0])) return 1;
  vips_concurrency_set(1);
  vips_cache_set_max(0);
  std::cout << "{\"ready\":true,\"vips\":\"" << vips_version_string() << "\"}" << std::endl;
  std::string line;
  while (std::getline(std::cin, line)) {
    VipsImage *probe = nullptr, *thumb = nullptr;
    void *encoded = nullptr; size_t length = 0;
    try {
      std::stringstream fields(line); std::string path, w, q, e, output;
      std::getline(fields,path,'\t'); std::getline(fields,w,'\t'); std::getline(fields,q,'\t');
      std::getline(fields,e,'\t'); std::getline(fields,output,'\t');
      auto started = std::chrono::steady_clock::now();
      std::ifstream file(path,std::ios::binary);
      std::vector<char> input((std::istreambuf_iterator<char>(file)),std::istreambuf_iterator<char>());
      if (input.empty() || input.size() > 26214400) throw std::runtime_error("input limit");
      const auto readMs = std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
      probe = vips_image_new_from_buffer(input.data(),input.size(),"","access",VIPS_ACCESS_SEQUENTIAL,"fail_on",VIPS_FAIL_ON_WARNING,nullptr);
      if (!probe || (int64_t)vips_image_get_width(probe)*vips_image_get_height(probe)>50000000) throw std::runtime_error("decode/size");
      if (vips_thumbnail_buffer(input.data(),input.size(),&thumb,std::stoi(w),
          "height",100000,"size",VIPS_SIZE_DOWN,"fail_on",VIPS_FAIL_ON_WARNING,nullptr)) throw std::runtime_error("thumbnail");
      if (vips_webpsave_buffer(thumb,&encoded,&length,"Q",std::stoi(q),"effort",std::stoi(e),"strip",TRUE,nullptr)) throw std::runtime_error("encode");
      const auto ms = std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
      std::ofstream out(output,std::ios::binary); out.write((char*)encoded,length);
      std::cout << "{\"ok\":true,\"ms\":" << ms << ",\"readMs\":" << readMs << ",\"bytes\":" << length << "}" << std::endl;
    } catch (...) {
      std::cerr << vips_error_buffer() << std::endl; vips_error_clear();
      std::cout << "{\"ok\":false,\"error\":\"native transform failed; see stderr\"}" << std::endl;
    }
    if (encoded) g_free(encoded);
    if (thumb) g_object_unref(thumb);
    if (probe) g_object_unref(probe);
  }
  vips_shutdown();
}
