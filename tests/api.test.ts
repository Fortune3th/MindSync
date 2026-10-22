import {test,expect,vi} from 'vitest';
import {Api} from '../src/api';
const reply=(status:number,value:unknown)=>({status,body:new TextEncoder().encode(JSON.stringify(value)).buffer});
test('chunk retry resends only the failed request and keeps the same hash',async()=>{
  vi.useFakeTimers();
  try {
    const send=vi.fn().mockResolvedValueOnce(reply(503,{error:{code:'STORAGE_ERROR'}})).mockResolvedValueOnce(reply(200,{}));
    const task=new Api(send).uploadChunk('a'.repeat(64),new Uint8Array([1]));
    await vi.runAllTimersAsync();await task;expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  } finally {vi.useRealTimers();}
});
test('invalid chunk body is not retried',async()=>{
  const send=vi.fn().mockResolvedValue(reply(422,{error:{code:'HASH_MISMATCH',message:'bad hash'}}));
  await expect(new Api(send).uploadChunk('a'.repeat(64),new Uint8Array([1]))).rejects.toMatchObject({code:'HASH_MISMATCH'});expect(send).toHaveBeenCalledTimes(1);
});
test('missing hashes are negotiated in one request',async()=>{
  const send=vi.fn().mockResolvedValue(reply(200,{missing:[],present:2}));await new Api(send).missing(['a'.repeat(64),'b'.repeat(64)]);
  expect(send.mock.calls[0]).toEqual(['POST','/v1/chunks/missing',JSON.stringify({hashes:['a'.repeat(64),'b'.repeat(64)]})]);
});
test('configuration routes scope metadata while sharing object, chunk and info endpoints',async()=>{
  const send=vi.fn().mockResolvedValue(reply(200,{files:[],cursor:0,versions:[],missing:[],present:0})),api=new Api(send,'configuration');
  await api.info();await api.snapshot();await api.changes(0);await api.history('id');await api.result('op');await api.missing([]);
  expect(send.mock.calls.map(call=>call[1])).toEqual(['/v1/info','/v1/configuration/snapshot','/v1/configuration/changes?after=0&limit=100','/v1/configuration/files/id/history','/v1/configuration/operations/op','/v1/chunks/missing']);
});
