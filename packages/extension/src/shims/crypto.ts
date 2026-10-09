/**
 * Stands in for node:crypto in the extension, which only needs SHA-1 to give
 * issues the same ids the CLI gives them. Synchronous, like Node's.
 */

function sha1(bytes: Uint8Array): string {
  const length = bytes.length;
  const words = new Uint32Array((((length + 8) >> 6) + 1) * 16);
  const or = (i: number, bits: number) => {
    words[i] = (words[i] as number) | bits;
  };
  for (let i = 0; i < length; i++) or(i >> 2, (bytes[i] as number) << (24 - (i % 4) * 8));
  or(length >> 2, 0x80 << (24 - (length % 4) * 8));
  words[words.length - 1] = length * 8;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[block + t] as number;
    for (let t = 16; t < 80; t++) {
      const x =
        (w[t - 3] as number) ^ (w[t - 8] as number) ^ (w[t - 14] as number) ^ (w[t - 16] as number);
      w[t] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + (w[t] as number)) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

export function createHash(algorithm: string) {
  if (algorithm !== 'sha1') throw new Error(`Only sha1 is available here, not ${algorithm}`);
  const chunks: string[] = [];
  const hash = {
    update(data: string) {
      chunks.push(data);
      return hash;
    },
    digest(encoding: string) {
      if (encoding !== 'hex')
        throw new Error(`Only hex digests are available here, not ${encoding}`);
      return sha1(new TextEncoder().encode(chunks.join('')));
    },
  };
  return hash;
}
