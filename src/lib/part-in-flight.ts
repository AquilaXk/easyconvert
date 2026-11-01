/**
 * How the server tells a client that a part is refused because an earlier attempt of the same part is still being
 * written (docs/policy-decisions.md, entry 137). The routes that receive parts and the browser that sends them both read
 * these two values, so the answer and the wait behind it cannot drift apart.
 */

export const PART_IN_FLIGHT_STATUS = 503;

export const PART_IN_FLIGHT_PROBLEM_TYPE = 'https://api.easyconvert.io/problems/part-in-flight';
