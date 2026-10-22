import {test,expect} from 'vitest';
import {chunk,defaults} from '../src/chunker';
import {digest} from '../src/types';
import {sample} from './helpers';
test.each([0,1,65535])('small file %i is a single exact object',async size=>{
  const bytes=sample(size);expect(await chunk(bytes)).toEqual([{hash:await digest(bytes),size}]);
});
test('deterministic cuts cover bytes exactly and respect bounds',async()=>{
  const bytes=sample(2*1024*1024),parts=await chunk(bytes);expect(parts).toEqual(await chunk(bytes));
  let offset=0;
  for(let i=0;i<parts.length;i++){
    expect(parts[i].size).toBeLessThanOrEqual(defaults.max);
    if(i<parts.length-1)expect(parts[i].size).toBeGreaterThanOrEqual(defaults.min);
    expect(await digest(bytes.subarray(offset,offset+parts[i].size))).toBe(parts[i].hash);offset+=parts[i].size;
  }
  expect(offset).toBe(bytes.length);expect(parts.length).toBeGreaterThan(8);
});
test('insertion resynchronizes boundaries and reuses most bytes',async()=>{
  const before=sample(2*1024*1024),after=new Uint8Array(before.length+17),at=300000;
  after.set(before.subarray(0,at));after.set(sample(17),at);after.set(before.subarray(at),at+17);
  const known=new Set((await chunk(before)).map(p=>p.hash));
  const reused=(await chunk(after)).filter(p=>known.has(p.hash)).reduce((s,p)=>s+p.size,0);
  expect(reused).toBeGreaterThan(before.length*0.8);
});
test('invalid negotiated parameters are refused',async()=>{
  await expect(chunk(sample(1),{min:0,avg:65536,max:262144})).rejects.toMatchObject({code:'PROTOCOL_MISMATCH'});
  await expect(chunk(sample(1),{min:16384,avg:12345,max:262144})).rejects.toMatchObject({code:'PROTOCOL_MISMATCH'});
});
