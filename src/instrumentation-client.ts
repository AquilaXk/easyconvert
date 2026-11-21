import { installClientErrorReporting } from '@/lib/client-errors/reporter';

/**
 * Runs in the browser before the page hydrates (the Next.js `instrumentation-client` file), so the handlers are in place for an error
 * of the first render. Its script is a chunk of the page, which the nonce policy of entry 370 already allows; it adds no inline script.
 */
installClientErrorReporting();
