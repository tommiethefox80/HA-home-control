import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EntityMemory } from '../src/renames.js';

const entry = (entity_id, id, unique_id = entity_id, platform = 'zha', extra = {}) => ({ entity_id, id, unique_id, platform, name: null, original_name: null, ...extra });

test('notes each entity in use with its permanent ID and name', () => {
  const m = new EntityMemory();
  const moves = m.reconcile(['switch.kettle'], [entry('switch.kettle', 'a1'), entry('light.other', 'b2')], new Map([['switch.kettle', 'Kettle']]));
  assert.deepEqual(moves, []);
  assert.deepEqual(m.known, { 'switch.kettle': { rid: 'a1', uid: 'zha:switch.kettle', name: 'Kettle' } });
  assert.equal(m.lastName('switch.kettle'), 'Kettle');
});

test('an entity ID that changed is found by its permanent ID', () => {
  const m = new EntityMemory();
  m.reconcile(['switch.kettle'], [entry('switch.kettle', 'a1')], new Map([['switch.kettle', 'Kettle']]));
  const moves = m.reconcile(['switch.kettle'], [entry('switch.kitchen_kettle', 'a1', 'switch.kettle')], new Map());
  assert.deepEqual(moves, [{ from: 'switch.kettle', to: 'switch.kitchen_kettle' }]);
  assert.equal(m.known['switch.kettle'], undefined);
  assert.equal(m.known['switch.kitchen_kettle'].rid, 'a1');
  assert.equal(m.lastName('switch.kitchen_kettle'), 'Kettle', 'keeps the name it had');
});

test('even when something else now has the old entity ID', () => {
  const m = new EntityMemory();
  m.reconcile(['switch.kettle'], [entry('switch.kettle', 'a1')]);
  const moves = m.reconcile(['switch.kettle'], [entry('switch.kitchen_kettle', 'a1', 'k1'), entry('switch.kettle', 'z9', 'k2')]);
  assert.deepEqual(moves, [{ from: 'switch.kettle', to: 'switch.kitchen_kettle' }]);
});

test('removed and added back (a new permanent ID): matched by integration and unique ID', () => {
  const m = new EntityMemory();
  m.reconcile(['switch.kettle'], [entry('switch.kettle', 'a1', 'plug-42')]);
  const moves = m.reconcile(['switch.kettle'], [entry('switch.kettle_2', 'c3', 'plug-42')]);
  assert.deepEqual(moves, [{ from: 'switch.kettle', to: 'switch.kettle_2' }]);
  // but the same unique ID from another integration isn't the same thing
  const n = new EntityMemory();
  n.reconcile(['switch.kettle'], [entry('switch.kettle', 'a1', 'plug-42', 'tplink')]);
  assert.deepEqual(n.reconcile(['switch.kettle'], [entry('switch.kettle_2', 'c3', 'plug-42', 'shelly')]), []);
});

test('never moves onto an entity ID that is already in use', () => {
  const m = new EntityMemory();
  m.reconcile(['switch.a', 'switch.b'], [entry('switch.a', 'a1'), entry('switch.b', 'b1')]);
  assert.deepEqual(m.reconcile(['switch.a', 'switch.b'], [entry('switch.b', 'a1', 'x'), entry('switch.c', 'b1', 'y')]), [{ from: 'switch.b', to: 'switch.c' }]);
});

test('an entity not in Home Assistant at all is noted once, with nothing to match on', () => {
  const m = new EntityMemory();
  m.reconcile(['switch.gone'], [entry('light.other', 'b2')]);
  assert.deepEqual(m.known['switch.gone'], { rid: null, uid: null, name: null });
  assert.equal(m.missing(['switch.gone']), false, "so it isn't looked up again and again");
  // and if it turns up later, it's noted properly
  m.reconcile(['switch.gone'], [entry('switch.gone', 'g1')]);
  assert.equal(m.known['switch.gone'].rid, 'g1');
});

test('a registry that cannot be read changes nothing', () => {
  const m = new EntityMemory();
  m.reconcile(['switch.kettle'], [entry('switch.kettle', 'a1')]);
  assert.deepEqual(m.reconcile(['switch.kettle'], null), []);
  assert.equal(m.known['switch.kettle'].rid, 'a1');
});

test('entities no longer in use are forgotten; a live rename moves the record', () => {
  const m = new EntityMemory();
  m.reconcile(['switch.a', 'switch.b'], [entry('switch.a', 'a1'), entry('switch.b', 'b1')]);
  m.reconcile(['switch.a'], [entry('switch.a', 'a1'), entry('switch.b', 'b1')]);
  assert.deepEqual(Object.keys(m.known), ['switch.a']);
  m.moved('switch.a', 'switch.aa');
  assert.deepEqual(Object.keys(m.known), ['switch.aa']);
  assert.equal(m.known['switch.aa'].rid, 'a1');
});
