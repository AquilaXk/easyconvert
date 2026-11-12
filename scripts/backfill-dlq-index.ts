import { allConversionQueues } from '../src/lib/queue/conversion-queue';

/**
 * Indexes the dead letters that were written before the dead-letter index existed (docs/policy-decisions.md, entry 256), so the
 * removal of a job's letters stops reading the whole list. Until it runs, a queue whose list held letters when the index arrived
 * removes them as before (it reads the list), so no erasure is incomplete either way. The default run only counts; `--apply` indexes.
 * It reads the list of a queue in one Redis step, which holds Redis for about 6 ms per 1,000 letters: run it when the queue is quiet.
 */
async function main(argv: readonly string[]): Promise<number> {
  const apply = argv.includes('--apply');
  let failed = false;
  for (const queue of allConversionQueues) {
    if (!queue.backfillDeadLetterIndex) {
      console.error(`${queue.name}: not a Redis queue (REDIS_URL is not set), nothing to index.`);
      failed = true;
      continue;
    }
    const result = await queue.backfillDeadLetterIndex(apply);
    if (result.alreadyCovered) console.log(`${queue.name}: the index covers the list already (${result.letters} letters).`);
    else if (result.applied) console.log(`${queue.name}: indexed ${result.indexable} of ${result.letters} letters.`);
    else console.log(`${queue.name}: ${result.indexable} of ${result.letters} letters would be indexed.`);
  }
  if (!apply) console.log('Dry run: nothing was written. Run again with --apply to index.');
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
