/**
 * A failure only the browser sees (a dropped connection, a script that threw) has no server log, and the interface words it
 * in the page's language without the reason. The English reason goes to the console, so a person who reports the problem
 * can read it there (entry 141 of docs/policy-decisions.md).
 */
export function warnBrowserFailure(what: string, cause: unknown): void {
  console.warn(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
}
