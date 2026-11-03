import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePreferences, readPreferences } from '../src/lib/company-preferences.ts';
import { walkingOrder } from '../src/lib/walking-order.ts';

test('company preferences validate stored values, recover corrupt JSON, and tolerate unavailable storage',()=>{
  assert.deepEqual(parsePreferences('{broken'),{});
  assert.deepEqual(parsePreferences(JSON.stringify({version:2,companies:{x:{saved:true}}})),{});
  assert.deepEqual(parsePreferences(JSON.stringify({version:1,companies:{x:{saved:true,visited:'yes',notes:'Recruiter\nFollow-up'},bad:null}})),{x:{saved:true,visited:false,notes:'Recruiter\nFollow-up'}});
  assert.equal(readPreferences({getItem(){throw Error('denied')}}).persisted,false);
});
test('walking order is stable by booth column then entrance-side Y, excluding queue spaces as representatives',()=>{
  const booth=(id,x,y,spaceType='unclassified')=>({id,spaceType,polygons:[[[x,y],[x+10,y],[x+10,y+10],[x,y+10]]]});
  const booths=[booth('a',0,20),booth('b',0,80),booth('c',40,80),booth('q',-100,200,'queue')];
  const companies=[{id:'one',name:'One',boothIds:['a','q']},{id:'two',name:'Two',boothIds:['b']},{id:'three',name:'Three',boothIds:['c']}];
  const original=JSON.stringify(booths);
  assert.deepEqual(walkingOrder(companies,booths).map(c=>c.id),['two','one','three']);
  assert.equal(JSON.stringify(booths),original);
});
