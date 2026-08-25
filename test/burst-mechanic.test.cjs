// BURST TAP MECHANIC TEST
// Verifies: unused taps → burst allowance (no 2s wait), normal taps → 2s wait
// This is a logic test — simulates the burst calculation without DB.

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; results.push(name); console.log(`  FAIL  ${name} -> ${detail}`); }
}

// Simulate getBurstAllowance (mirrors app.js exactly)
function getBurstAllowance(elapsedSeconds, tapsUsed) {
  const expected = Math.min(Math.floor(elapsedSeconds / 2), 15);
  return Math.max(0, expected - tapsUsed);
}

console.log('=== BURST MECHANIC TEST ===\n');

// ---- Scenario 1: User doesn't tap for 6 seconds ----
console.log('Scenario 1: User idle for 6s, then taps');
let tapsUsed = 0;
let burst = getBurstAllowance(6, tapsUsed);
check('After 6s idle: burst = 3', burst === 3, `got ${burst}`);
// User uses 3 burst taps
tapsUsed += 3;
burst = getBurstAllowance(6, tapsUsed);
check('After using 3 burst taps: burst = 0', burst === 0, `got ${burst}`);

// ---- Scenario 2: User idle for 10 seconds, uses 3 taps ----
console.log('\nScenario 2: User idle for 10s, uses 3 taps');
tapsUsed = 0;
burst = getBurstAllowance(10, tapsUsed);
check('After 10s idle: burst = 5', burst === 5, `got ${burst}`);
tapsUsed += 3;
burst = getBurstAllowance(10, tapsUsed);
check('After using 3 of 5: burst = 2', burst === 2, `got ${burst}`);

// ---- Scenario 3: Normal pace (1 tap every 2s) ----
console.log('\nScenario 3: Normal pace — 1 tap every 2s');
for (let t = 2; t <= 30; t += 2) {
  const expected = t / 2;
  tapsUsed = expected;
  burst = getBurstAllowance(t, tapsUsed);
  check(`T=${t}s, used=${tapsUsed}: burst = 0`, burst === 0, `got ${burst}`);
}

// ---- Scenario 4: Mixed — some idle, some fast ----
console.log('\nScenario 4: Mixed usage');
// T=0: start
// T=4: user taps 1 time (should have used 2 by now)
tapsUsed = 1;
burst = getBurstAllowance(4, tapsUsed);
check('T=4s, used=1: burst = 1', burst === 1, `got ${burst}`);
// Use the burst tap
tapsUsed = 2;
burst = getBurstAllowance(4, tapsUsed);
check('T=4s, used=2: burst = 0', burst === 0, `got ${burst}`);
// Wait until T=8 without tapping
tapsUsed = 2;
burst = getBurstAllowance(8, tapsUsed);
check('T=8s, used=2: burst = 2', burst === 2, `got ${burst}`);
// Use 2 burst taps
tapsUsed = 4;
burst = getBurstAllowance(8, tapsUsed);
check('T=8s, used=4: burst = 0', burst === 0, `got ${burst}`);

// ---- Scenario 5: User taps very fast early, then waits ----
console.log('\nScenario 5: Fast early, then waits');
// User taps 5 times in first 4 seconds
tapsUsed = 5;
burst = getBurstAllowance(4, tapsUsed);
check('T=4s, used=5: burst = 0 (over-achieved)', burst === 0, `got ${burst}`);
// Wait until T=12
burst = getBurstAllowance(12, tapsUsed);
check('T=12s, used=5: burst = 1 (caught up 1)', burst === 1, `got ${burst}`);
// Wait until T=20
burst = getBurstAllowance(20, tapsUsed);
check('T=20s, used=5: burst = 5 (caught up 5)', burst === 5, `got ${burst}`);

// ---- Scenario 6: Cap at 15 taps ----
console.log('\nScenario 6: Cap at 15 taps');
burst = getBurstAllowance(40, 10);
check('T=40s, used=10: burst capped at 5 (not 10)', burst === 5, `got ${burst}`);
burst = getBurstAllowance(40, 15);
check('T=40s, used=15: burst = 0 (maxed out)', burst === 0, `got ${burst}`);
burst = getBurstAllowance(100, 0);
check('T=100s, used=0: burst capped at 15 (max taps)', burst === 15, `got ${burst}`);

// ---- Scenario 7: Burst vs normal tap rule ----
console.log('\nScenario 7: Burst = no wait, Normal = 2s wait');
// After 6s idle, user has 3 burst taps → can use ALL 3 instantly
tapsUsed = 0;
burst = getBurstAllowance(6, tapsUsed);
check('Burst taps skip 2s wait', burst > 0, `burst=${burst}`);
// After using burst taps, remaining taps need 2s wait
tapsUsed = 3;
burst = getBurstAllowance(6, tapsUsed);
check('After burst, normal taps need 2s wait', burst === 0, `burst=${burst}`);

// ---- Scenario 8: User doesn't tap at all for 30 seconds ----
console.log('\nScenario 8: User idle entire game (30s)');
burst = getBurstAllowance(30, 0);
check('After 30s idle: burst = 15 (all taps available)', burst === 15, `got ${burst}`);
// User can use all 15 in rapid succession
tapsUsed = 15;
burst = getBurstAllowance(30, tapsUsed);
check('After using all 15: burst = 0', burst === 0, `got ${burst}`);

console.log(`\n========== RESULT: ${pass} passed, ${fail} failed ==========`);
if (results.length) console.log('FAILED:', results.join(', '));

// Write results to file (node stdout swallowed in this shell)
const fs = require('fs');
fs.writeFileSync('test-results-burst.txt', `RESULT: ${pass} passed, ${fail} failed\n` + (results.length ? 'FAILED: ' + results.join(', ') : 'ALL PASS'));
process.exit(fail > 0 ? 1 : 0);
