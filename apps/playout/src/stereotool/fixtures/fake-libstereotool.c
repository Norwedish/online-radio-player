/*
 * Test double for Thimeo's libStereoTool generic plugin (same C symbols and
 * signatures as libStereoTool.h, API 256). Built by adapter.test.ts with the
 * system C compiler so the koffi FFI path is exercised in CI without the
 * proprietary library. Behaviour:
 *   - Process halves every sample (so tests can see processing happened)
 *   - LoadPreset succeeds only for files ending in ".sts" and only with the
 *     *older* load-type numbering (10387) to exercise the fallback
 *   - the licence is valid only for the key "good-key"; with any other key the
 *     "unlicensed features" text is "Advanced clipper"
 *   - a preset named "crash.sts" makes Process abort() (crash isolation test)
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

typedef struct {
  bool licensed;
  bool crash;
} fake_st;

EXPORT int stereoTool_GetSoftwareVersion(void) { return 11080; }
EXPORT int stereoTool_GetApiVersion(void) { return 256; }
EXPORT void stereoTool_global_setBindIp(const char *web, const char *uecp) { (void)web; (void)uecp; }
EXPORT void stereoTool_EnableInternalSoundCard(bool enabled) { (void)enabled; }

EXPORT fake_st *stereoTool_Create(const char *key) {
  fake_st *st = calloc(1, sizeof(fake_st));
  st->licensed = key != NULL && strcmp(key, "good-key") == 0;
  return st;
}

EXPORT fake_st *stereoTool_Create3(bool has_gui, const char *key, const char *name, const char *home, bool load_ini) {
  (void)has_gui; (void)name; (void)home; (void)load_ini;
  return stereoTool_Create(key);
}

EXPORT void stereoTool_Delete(fake_st *st) { free(st); }

EXPORT bool stereoTool_LoadPreset(fake_st *st, const char *filename, int type) {
  size_t n = strlen(filename);
  if (n < 4 || strcmp(filename + n - 4, ".sts") != 0 || type != 10387) return false;
  st->crash = strstr(filename, "crash.sts") != NULL;
  return true;
}

EXPORT int stereoTool_GetLatency2(fake_st *st, int32_t rate, bool feed_silence) {
  (void)st; (void)feed_silence;
  return rate / 100; /* 10 ms */
}

EXPORT bool stereoTool_CheckLicenseValid(fake_st *st) { return st->licensed; }

EXPORT bool stereoTool_GetUnlicensedUsedFeatures(fake_st *st, char *text, int maxlen) {
  if (st->licensed) {
    if (maxlen > 0) text[0] = 0;
    return true;
  }
  strncpy(text, "Advanced clipper", (size_t)maxlen);
  text[maxlen - 1] = 0;
  return false;
}

EXPORT void stereoTool_Process(fake_st *st, float *samples, int32_t frames, int32_t channels, int32_t rate) {
  (void)rate;
  if (st->crash) abort();
  for (int32_t i = 0; i < frames * channels; i++) samples[i] *= 0.5f;
}
