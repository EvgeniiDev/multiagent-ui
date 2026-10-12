import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BridgeProcessOwner } from '../deploy/bridge-process-owner.mjs';

class FakeStream extends EventEmitter {
  setEncoding(encoding) { this.encoding = encoding; }
  write(value) { this.lastWrite = value; return true; }
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdin = new FakeStream();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.kills = [];
  }
  kill(signal) { this.kills.push(signal); return true; }
}

function makeOwner() {
  const children = [];
  const owner = new BridgeProcessOwner({
    spawnImpl: (...args) => {
      const child = new FakeChild(children.length + 1);
      children.push({ child, args });
      return child;
    },
  });
  return { owner, children };
}

{
  const { owner, children } = makeOwner();
  const events = [];
  const child = owner.start(['agent', '--acp'], { stdio: ['pipe', 'pipe', 'pipe'] }, {
    onExit: (code, signal, state) => events.push({ code, signal, current: state.current }),
  });
  assert.equal(owner.current, child);
  assert.deepEqual(children[0].args, ['agent', ['--acp'], { stdio: ['pipe', 'pipe', 'pipe'] }]);
  child.emit('exit', 0, null);
  assert.equal(owner.current, null);
  assert.deepEqual(events, [{ code: 0, signal: null, current: true }]);
}

{
  const { owner, children } = makeOwner();
  const oldExit = [];
  const first = owner.start(['agent'], {}, {
    onExit: (_code, _signal, state) => oldExit.push(state.current),
  });
  assert.equal(owner.stop(first, 'SIGKILL'), true);
  assert.equal(owner.current, null);
  assert.deepEqual(first.kills, ['SIGKILL']);

  const second = owner.start(['agent'], {});
  first.emit('exit', null, 'SIGKILL');
  assert.equal(owner.current, second, 'late exit from detached generation cannot clear the replacement');
  assert.deepEqual(oldExit, [false], 'caller can ignore stale lifecycle events');
  assert.equal(children.length, 2);
}

{
  const { owner } = makeOwner();
  const first = owner.start(['agent'], {});
  assert.equal(owner.stop(new FakeChild(99), 'SIGKILL'), false, 'cannot signal an unowned child');
  assert.equal(owner.current, first);
  first.kill = () => false;
  assert.equal(owner.stop(first, 'SIGKILL'), false, 'unsuccessful signal reports no stop');
  assert.equal(owner.current, first, 'unsuccessful signal must not orphan a possibly live process');
  first.kill = () => { throw new Error('signal denied'); };
  assert.equal(owner.stop(first, 'SIGKILL'), false, 'failed signal leaves the workload owned');
  assert.equal(owner.current, first, 'failed signal must not orphan a possibly live process');
}

console.log('PASS bridge process owner tracks generations, exits and exact-child stop');
