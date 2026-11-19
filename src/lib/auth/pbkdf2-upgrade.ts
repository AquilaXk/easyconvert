/*
 * Django, BSD 3-Clause License
 *
 * Copyright (c) Django Software Foundation and individual contributors.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 *     1. Redistributions of source code must retain the above copyright notice,
 *        this list of conditions and the following disclaimer.
 *
 *     2. Redistributions in binary form must reproduce the above copyright
 *        notice, this list of conditions and the following disclaimer in the
 *        documentation and/or other materials provided with the distribution.
 *
 *     3. Neither the name of Django nor the names of its contributors may be used
 *        to endorse or promote products derived from this software without
 *        specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * When a stored PBKDF2 hash is upgraded to the current number of iterations, and what keeps the time of a sign-in the same until it is
 * (docs/policy-decisions.md, entry 341).
 *
 * Both functions are TypeScript translations of methods of `PBKDF2PasswordHasher` in `django/contrib/auth/hashers.py` of
 * django/django (the file at commit e78991410b78391bc07a4b5010b273dfec814ff6), BSD-3-Clause, Copyright (c) Django Software
 * Foundation and individual contributors: `mustUpdate` is `must_update` (the stored iterations differ from the current ones) and
 * `extraIterations` is the count of `harden_runtime` (the current iterations less the stored ones, run again so that a hash stored
 * with fewer iterations takes as long to check as a current one and an answer does not tell the two apart). The rule that a
 * successful check upgrades the stored hash is the `setter` of `check_password` and is applied by the sign-in route.
 */

/** Whether a hash stored with `storedIterations` is to be replaced by one made with `currentIterations`: Django's `must_update`. */
export function mustUpdate(storedIterations: number, currentIterations: number): boolean {
  return storedIterations !== currentIterations;
}

/** The iterations to run again after checking a hash stored with `storedIterations`, so that the check costs `currentIterations` in all: Django's `harden_runtime`. */
export function extraIterations(storedIterations: number, currentIterations: number): number {
  return Math.max(0, currentIterations - storedIterations);
}
