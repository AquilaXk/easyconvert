/** A process that never says hello and stays alive: only a kill stops it. */
setTimeout(() => undefined, 1 << 30);
