/** A process that says hello and then spins, so it cannot read a request to end: only a kill stops it. */
if (process.send) process.send({ type: 'hello' });
for (;;) {
  // Spin.
}
