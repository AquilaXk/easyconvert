import { allConversionQueues } from '../src/lib/queue/conversion-queue';

/**
 * Moves the dead letters that an older build wrote to the list `{queue}:dlq` into the hash-by-id layout (docs/policy-decisions.md,
 * entry 265), so the removal of a job's letters stops reading the list. Until it has run, a removal reads the list while it holds letters,
 * so no erasure is incomplete either way. Run it once every worker of an older build is gone: such a worker appends to the list, which a
 * later run moves. The default run only counts; `--apply` moves, 500 letters to a Redis step, oldest first, and can be stopped and run
 * again (a second run finds nothing to move).
 */
async function main(argv: readonly string[]): Promise<number> {
  const apply = argv.includes('--apply');
  let failed = false;
  for (const queue of allConversionQueues) {
    if (!queue.migrateDeadLetters) {
      console.error(`${queue.name}: not a Redis queue (REDIS_URL is not set), nothing to move.`);
      failed = true;
      continue;
    }
    const found = await queue.migrateDeadLetters(apply);
    const detail = `${found.indexed} found by job or user, ${found.unindexed} by neither, ${found.unreadable} not JSON`;
    if (found.letters === 0) console.log(`${queue.name}: the list holds no letters.`);
    else if (apply) console.log(`${queue.name}: moved ${found.moved} of ${found.letters} letters (${detail}).`);
    else console.log(`${queue.name}: ${found.letters} letters would be moved (${detail}).`);
  }
  if (!apply) console.log('Dry run: nothing was written. Run again with --apply to move the letters.');
  return failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    }
  );
}
