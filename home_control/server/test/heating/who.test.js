// Who changed a radiator, from the change's context in Home Assistant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Engine } from '../../src/heating/engine.js';
import { Store } from '../../src/heating/store.js';

test('a change on the radiator, by a person, through Alexa or Google, or by an automation', () => {
  const ha = Object.assign(new EventEmitter(), { states: new Map(), get: () => null });
  const engine = new Engine(ha, new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-who-'))), () => {});
  engine.users = new Map([['u1', 'Tom'], ['u2', 'Home Assistant Cloud']]);
  assert.equal(engine.whoChanged({ id: 'x', parent_id: null, user_id: null }), 'on the radiator itself, or in its own app (Hive)');
  assert.equal(engine.whoChanged(undefined), 'on the radiator itself, or in its own app (Hive)');
  assert.equal(engine.whoChanged({ user_id: 'u1' }), 'by Tom in Home Assistant');
  assert.equal(engine.whoChanged({ user_id: 'u2' }), 'through Home Assistant Cloud (Alexa or Google)');
  assert.equal(engine.whoChanged({ user_id: 'u9' }), 'in Home Assistant');
  assert.equal(engine.whoChanged({ parent_id: 'p' }), 'by an automation, script or voice assistant');
});
