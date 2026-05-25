// Test fixture for tests/hook-prettier-write.test.ts ETIMEDOUT branch.
// Hangs the event loop with setInterval so spawnSync (timeout: N) kills
// it via SIGTERM. The 5s belt-and-braces self-exit guards against the
// Windows zombie-process scenario where the parent's spawnSync returns
// before the OS reaps the child — even if kill fails, the child dies on
// its own within 5s, preventing CI accumulation of hung node processes.
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 5000);
