// Idle worker entry — queue polling lands with later checkpoints.
// Checkpoint 5 recording: `npm run record` (see src/run-checkpoint5.js).
console.log("[demobro-worker] idle — use npm run record for checkpoint 5");

setInterval(() => {
  console.log("[demobro-worker] heartbeat — waiting for jobs");
}, 60_000);
