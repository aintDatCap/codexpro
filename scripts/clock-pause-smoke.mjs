import assert from 'node:assert/strict';
import { EventLoopPauseTracker } from '../dist/clockPause.js';

let now = 0;
const tracker = new EventLoopPauseTracker(() => now, 60_000);
assert.equal(tracker.check(), 0);
now += 60_000;
assert.equal(tracker.check(), 0, 'normal polling does not extend leases');
now += 3_600_000;
assert.equal(tracker.check(), 3_600_000, 'a suspended event loop grants resume grace');
assert.equal(tracker.check(), 0, 'pause is reported only once');
now += 60_000;
assert.equal(tracker.check(), 0);
now -= 3_600_000;
assert.equal(tracker.check(), 0, 'clock moving backwards is not a sleep');
console.log('clock pause smoke passed');
