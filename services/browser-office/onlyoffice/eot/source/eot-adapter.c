/* SPDX-License-Identifier: MPL-2.0 */
/* Private diagnostic. All decoding runs in a disposable bounded worker. */
#include <stdint.h>
#include <stdlib.h>
#include <libeot/libeot.h>

#define MAX_FONT_BYTES (32u * 1024u * 1024u)
static uint32_t u32le(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint16_t u16le(const uint8_t *p) { return p[0] | ((uint16_t)p[1] << 8); }
static int sfnt(const uint8_t *p, unsigned n) {
  if (n < 12) return 0;
  uint32_t signature=u32le(p);
  return signature==0x00000100u || signature==0x4f54544fu || signature==0x66637474u || signature==0x65757274u;
}
int sb_decode_eot(const uint8_t *input, unsigned length, uint8_t **out, unsigned *out_length) {
  *out=NULL; *out_length=0;
  if (!input || length<36 || length>MAX_FONT_BYTES) return -1;
  uint32_t total=u32le(input), payload=u32le(input+4);
  uint16_t permissions=u16le(input+32);
  if(total!=length || payload<12 || payload>MAX_FONT_BYTES || payload>length || u16le(input+34)!=0x504cu) return -2;
  if((permissions&0x0002u) || (permissions&0x0200u) || !(permissions==0 || (permissions&0x0008u))) return -3;
  struct EOTMetadata metadata={0};
  int result=EOT2ttf_buffer(input,length,&metadata,out,out_length);
  EOTfreeMetadata(&metadata);
  if(result!=EOT_SUCCESS || !*out || *out_length>MAX_FONT_BYTES || !sfnt(*out,*out_length)) {
    if(*out) EOTfreeBuffer(*out);
    *out=NULL; *out_length=0;
    return result ? result : -4;
  }
  return 0;
}
void sb_free(uint8_t *buffer) { EOTfreeBuffer(buffer); }
