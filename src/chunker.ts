import {Chunk, digest, SyncError} from './types';

export interface ChunkParameters { min: number; avg: number; max: number }
export const defaults: ChunkParameters = {min:16384, avg:65536, max:262144};
// MindSync's deterministic 32-bit Gear table. Changing it changes boundaries,
// but never object identity (always SHA-256 of the actual bytes).
const gear = (() => {
  const table = new Uint32Array(256); let seed = 0x6d696e64;
  for (let i=0;i<256;i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    table[i] = seed >>> 0;
  }
  return table;
})();
export function validateParameters(p: ChunkParameters) {
  if (![p.min,p.avg,p.max].every(Number.isSafeInteger) || p.min < 64 || p.min > p.avg || p.avg > p.max || p.max > defaults.max || (p.avg & (p.avg-1)) !== 0)
    throw new SyncError('PROTOCOL_MISMATCH','Incompatible server chunk parameters');
}
// FastCDC: skip cuts below min, use a stricter mask before avg, a looser
// mask after avg, and force a cut at max. No Node APIs, including on mobile.
export async function chunk(bytes: Uint8Array, p: ChunkParameters = defaults): Promise<Chunk[]> {
  validateParameters(p);
  if (bytes.length < p.min * 4) return [{hash:await digest(bytes),size:bytes.length}];
  const bits = Math.log2(p.avg);
  const mask = (count: number) => ((2**count-1) * 2**(32-count)) >>> 0;
  const strict = mask(bits+1), loose = mask(bits-1);
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < bytes.length) {
    const limit = Math.min(start+p.max,bytes.length), normal = Math.min(start+p.avg,limit);
    let end = Math.min(start+p.min,limit), hash = 0;
    for (;end<limit;) {
      hash = ((hash << 1) + gear[bytes[end]]) >>> 0;
      end++;
      if ((hash & (end <= normal ? strict : loose)) === 0) break;
    }
    chunks.push({hash:await digest(bytes.subarray(start,end)),size:end-start});
    start=end;
  }
  return chunks;
}
