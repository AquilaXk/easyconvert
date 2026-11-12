# Sources of the legal texts

This file cites the source of every clause of the four legal pages: the terms of service, the privacy policy, the data processing terms and the acceptable use policy. The texts are `terms`, `privacy`, `dpa` and `acceptable-use` in this folder, each in English (`.en.md`) and Korean (`.ko.md`). The two languages carry the same clauses under the same section numbers. The site renders them at `/terms`, `/privacy`, `/dpa` and `/acceptable-use` (`src/lib/legal/`), with the parser and policy of the Markdown conversion (`src/lib/markdown/safe-markdown.ts`). The texts link to pages of the site without a language prefix, and the renderer adds the prefix of the page's language. The four pages share one version, the date shown at their top (`LEGAL_TEXTS_VERSION`, `src/lib/legal/documents.ts:7`), since they cite each other's sections. Version of this set: 2026-11-12 (the session cookie names; the backup wording is of 2026-11-08, and the law texts above were read on 2026-11-03).

The numbers the texts state (the daily allowance, the retention periods, the cookie and counter lifetimes) are read from the code in `tests/legal-values.test.ts`, which fails when a text and the value in force differ. A test also holds the two languages to the same sections, list items and table rows.

The texts were written from this research. Counsel has not reviewed them (policy entry 146).

## Sources

Law texts were read on law.go.kr on 2026-11-03, in the version in force on that day.

| Key | Source |
| --- | --- |
| PIPA | 개인정보 보호법, [시행 2026. 9. 11.] 법률 제21445호. https://www.law.go.kr/법령/개인정보보호법 |
| PIPA-D | 개인정보 보호법 시행령, [시행 2026. 9. 11.] 대통령령 제36671호. https://www.law.go.kr/법령/개인정보보호법시행령 |
| PIPC-G | 개인정보보호위원회, 개인정보 처리방침 작성지침 (2026.4. 개정), table "개인정보 처리방침 기재 사항" (items 1 to 24), items 20 and 24, and the section on publication. https://www.pipc.go.kr/np/cop/bbs/selectBoardArticle.do?bbsId=BS217&mCode=D010030000&nttId=12018 |
| GDPR | Regulation (EU) 2016/679 (General Data Protection Regulation). https://eur-lex.europa.eu/eli/reg/2016/679/oj |
| ADQ | Commission Implementing Decision (EU) 2022/254 of 17 December 2021 on the adequate protection of personal data by the Republic of Korea under the Personal Information Protection Act. https://eur-lex.europa.eu/eli/dec_impl/2022/254/oj |
| NET | 정보통신망 이용촉진 및 정보보호 등에 관한 법률, [시행 2026. 10. 2.] 법률 제21988호. https://www.law.go.kr/법령/정보통신망이용촉진및정보보호등에관한법률 |
| ECOM | 전자상거래 등에서의 소비자보호에 관한 법률, [시행 2026. 7. 21.] 법률 제21312호. https://www.law.go.kr/법령/전자상거래등에서의소비자보호에관한법률 |
| TERMS | 약관의 규제에 관한 법률, [시행 2024. 8. 7.] 법률 제20239호. https://www.law.go.kr/법령/약관의규제에관한법률 |
| COPY | 저작권법, [시행 2026. 10. 29.] 법률 제21595호. https://www.law.go.kr/법령/저작권법 |
| FTC | 공정거래위원회 전자상거래(인터넷사이버몰) 표준약관 제10023호, article 3 (notice of changes 7 days before, 30 days for unfavourable changes). Read from a published translation and from service terms that reproduce it; the official text was not retrieved. |
| CF | Cloudflare, Inc. Privacy Policy, effective 2025-11-04 (processor role, address, privacyquestions@cloudflare.com), and Cloudflare Customer Data Processing Addendum v6.4, effective 2026-04-03 (EU standard contractual clauses, clause 6.2). https://www.cloudflare.com/privacypolicy/ , https://www.cloudflare.com/cloudflare-customer-dpa/ |
| CF-MAIL | Cloudflare Email Routing documentation, read 2026-11-04: "Cloudflare will not store or access the emails routed to your inbox." https://developers.cloudflare.com/email-routing/ . The mail exchangers of `aquilaxk.site` are `route1.mx.cloudflare.net` to `route3.mx.cloudflare.net` (checked 2026-11-03), and the route forwards `support@aquilaxk.site` to the operator's own mailbox (QA, 2026-11-03). |
| HOST | The production host, checked 2026-11-03: `/etc/logrotate.d/nginx` rotates `/var/log/nginx/*.log` daily with `rotate 14`, `compress` and `delaycompress`, so a line is kept for up to 15 days. |
| ORA | Oracle Services Privacy Policy, last updated 2026-02-25. https://www.oracle.com/legal/privacy/services-privacy-policy/ |
| RUN | `docs/operations/backup-and-restore.md` and `deploy/oci/redis-backup.sh` (every 6 hours, kept at most 7 days, same server, no copy elsewhere, erasures re-applied after a restore), and docs/policy-decisions.md entry 186, which cites the UK data protection authority's guide to the right to erasure (section on backups: a copy may stay in a backup until it is overwritten, if it is used for nothing else and the erasure is applied again on a restore). The 7-day period and the 2-day erasure target are checked against the texts in `tests/redis-backup.test.ts`. |
| REF | The terms, privacy policy and security pages of a comparable conversion service, read 2026-11-03: placement of acceptable use and copyright in the terms, processors and retention in the privacy policy, a processing agreement on request on the security page, the date above the title, a table of contents beside the sections, and an "I accept the terms" box on sign-up. |
| CODE | This repository at the commit of the pull request, cited by file and line. |

The privacy texts name the processors (Oracle, Cloudflare, Google) because PIPA 26(2), PIPA 28-8(2)(3) and GDPR 13(1)(e) require the recipients to be named.

GDPR 27 asks a controller outside the EU that offers services to people in the EU to designate a representative there, unless the processing is occasional, does not include special categories of data on a large scale and is unlikely to result in a risk (27(2)(a)). No representative is designated: the service is free, is not directed at a market in the EU, and processes no special categories. This is a known risk (policy entry 146), to be revisited with the counsel review.

## Terms of service

| Clause | Content | Sources |
| --- | --- | --- |
| Intro | Use means agreement; the accepted version is recorded at sign-up and API key creation; the other three pages are part of the terms | TERMS 3(2); REF (terms incorporate the privacy policy); issue #901; CODE `src/app/api/auth/register/route.ts`, `src/app/api/keys/route.ts`, `src/app/api/auth/google/callback/route.ts` |
| 1 | Free service, 10 server conversions a day without an account and on the free plan, no paid plans; plan limits shown before converting; no evasion by several accounts | CODE `src/lib/plan-limits.ts:30`, `:44` (`FREE_DAILY_CONVERSIONS`, `ANONYMOUS_DAILY_CONVERSIONS`); docs/policy-decisions.md entry 16; REF (Allowed Usage: limits, no multiple accounts) |
| 2 | Accounts from age 14; keep credentials secret; stop at any time; deletion on request within 10 days | PIPA 22-2 (children under 14); TERMS 9(1) (no limit on the customer's right to terminate); PIPA-D 41(4) (10 days); REF (Termination); docs/deploy-oci.md "Deleting an account" |
| 3 | Files stay the user's; processed by machine only; deletion schedule; no backups of files and results, only the record backups of the privacy policy; user keeps a copy and holds the rights | REF (Purpose of the processing; Limitation of Liability: no backups); RUN; docs/policy-decisions.md entries 125 and 186; COPY 103 |
| 4 | Acceptable use policy applies | NET 44-2(5) (the measures taken against infringing content stated in the terms in advance); REF (Allowed Usage) |
| 5 | No availability guarantee for a free service; 30 days' notice before the whole service stops | REF (Termination: 30 days' notice before discontinuing the service); TERMS 7(3) (a limit needs a reasonable ground: the service is free) |
| 6 | No liability for lost files or failed conversions, except intent or gross negligence | TERMS 7(1) (a clause excluding liability for intent or gross negligence is void); REF (Limitation of Liability) |
| 7 | Suspension for a breach or on a legal requirement, reason given first unless the law or urgency prevents it | TERMS 9(2), 9(3) (no termination right beyond what is fair); REF (Termination); NET 44-7(3), (4) (orders of the authority) |
| 8 | Copyright: notices, stop of reproduction and transmission, notice to the sender | COPY 103(1), (2); REF (Copyright Policy) |
| 9 | Version date at the top; 7 days' notice of changes, 30 days for unfavourable ones; right to leave | FTC article 3; TERMS 3(2); REF (date at the top of the page) |
| 10 | Contact through the contact page | ECOM 10(1)(3) (contact for consumers); CODE `src/components/converter/info-page-sections.tsx:69` (the existing contact page) |

ECOM articles 10 and 13 apply to an operator of an online shop that sells goods or services. The service sells nothing today, so the identity items of ECOM 10(1) (business name, representative, address, telephone, business registration number) and the sale terms of ECOM 13 are not in the terms. They must be added before paid plans start (#902).

## Privacy policy

The Korean text follows the order of PIPC-G (items 1 to 24). Items that do not apply are stated as not processed, as PIPC-G allows ("해당시").

| Section | Content | Sources |
| --- | --- | --- |
| Intro | Purpose of the policy; the operator is the controller | PIPC-G item 1 (title and preamble); PIPA 30(1); GDPR 13(1)(a) |
| 1 | Purposes, and the legal basis of each; whether the data must be given and what follows when it is not | PIPA 30(1)(1); PIPA 15(1)(2) (legal obligation), 15(1)(4) (contract) and 15(1)(6) (legitimate interest); GDPR 13(1)(c), 6(1)(b), (c), (f), 13(2)(e); PIPC-G item 2 |
| 2 | Items processed: files, conversion jobs, the edge log, allowance and request counters, account, Google sign-in, API keys, failed webhook deliveries, contact; a conversion in the browser sends nothing | PIPA-D 31(1)(1); GDPR 13(1), 14(1)(d) and 14(2)(f) (data received from Google); PIPC-G item 3. CODE: browser conversions `src/lib/client-converter.ts:84` (`tryProcessClientEdge`, no upload); job fields `src/lib/types.ts:409` (`ConversionJobData`, an anonymous owner is `anon:` and its address bucket, `src/lib/auth/anonymous-identity.ts:13`); edge log `deploy/oci/nginx-easyconvert.conf:18` (only status 4xx and 5xx), `:32` (fields, the full `$remote_addr`); counters `src/lib/api-keys/guard.ts:398`, IPv6 /64 `src/lib/security/client-ip.ts:60`; account fields `src/lib/auth/types.ts`; Google profile `src/app/api/auth/google/callback/route.ts`; key fields `src/lib/api-keys/types.ts`; failed deliveries `src/lib/api-keys/types.ts:96` (`WebhookDlqEntry`); contact CF-MAIL |
| 2 | No sensitive data or identification numbers asked; no sale; no model training | PIPC-G items 12 and 13; PIPA 30(1)(3-3) |
| 3 | Retention of each item; the values are the settings in force; the backup of the account and job records (every 6 hours, at most 7 days, same server, the file of an API job in a backup) | PIPA 30(1)(2); GDPR 13(2)(a); PIPC-G item 5; RUN; docs/policy-decisions.md entry 186. CODE and records: uploads and results, docs/policy-decisions.md entry 125 and `src/lib/config/schema.ts:723`, `:734`; temporary files, docs/deploy-oci.md "Delete on delivery" (sweep after two hours); conversion jobs, `src/lib/queue/enqueue.ts:42` (`endedJobRetentionMs`: `RESULT_UNDELIVERED_TTL_SECONDS` plus `GONE_RECORD_MS`, `src/lib/storage/result-retention.ts:23`), the inline input and the webhook secret dropped at the end, `src/lib/queue/enqueue.ts:35`, and the sweep, `src/lib/queue/conversion-queue.ts:484`; jobs of several steps, `src/lib/queue/graph/redis-scheduler.ts:236`; failed job copies, the dead letters `clean` trims with the failed jobs; failed webhook deliveries, `src/lib/api-keys/webhook-dispatcher.ts:21`; usage counters, `src/lib/api-keys/redis-key-store.ts:215` (one key per UTC day); request burst counters, `src/lib/api-keys/redis-key-store.ts:45`; upload budget, `src/lib/api-keys/upload-budget-store.ts:26`; sign-in limits, `src/lib/auth/login-rate-limiter.ts:5`; edge log, HOST; contact messages, the operator's mailbox (QA question, see Open points). docs/policy-decisions.md entry 147 |
| 4 | Destruction procedure and method; no backups of files; backups of records expire within 7 days; the deletion of an account within 2 days of a verified request, its backup copies within the following 7 days and 6 hours, inside the 10 days; a restore re-applies the deletions | PIPA 30(1)(3-2); PIPA 21(1), (2) (destroy the data when it is no longer needed); PIPA-D 16(1)(1) (permanent deletion of electronic files); PIPA-D 41(4); PIPC-G item 6; RUN; docs/policy-decisions.md entry 186. CODE `scripts/erase-account.ts`; docs/deploy-oci.md "Deleting an account" |
| 5 | No provision to third parties except a legal requirement | PIPA 30(1)(3); GDPR 13(1)(e); PIPC-G item 7 |
| 6 | Processors and their tasks, the mail route among them; Google is not a processor | PIPA 30(1)(4); PIPA 26(2); PIPA-D 28(2) (published on the website); GDPR 13(1)(e); PIPC-G item 9. Hosting region: docs/deploy-oci.md "Cost" (ap-seoul-1) and "Delete on delivery" (no bucket). CDN in front: docs/deploy-oci.md "What runs" and steps 5 and 6, `deploy/oci/nginx-easyconvert.conf` (`set_real_ip_from` the CDN's ranges), and the `server: cloudflare` header of the live site on 2026-11-03. Mail: CF-MAIL. Google sign-in: `docker-compose.prod.yml` (`GOOGLE_CLIENT_ID`), not configured in production on 2026-11-03 (`/api/auth/google/url` answered that the client id is not configured). No email, analytics, advertising or payment provider is configured: `docs/configuration.example.env`, `deploy/oci/env-allowlist.txt` |
| 7 | Transfer abroad: items (the mail included), countries, time and method, recipient and contact, purpose and retention, how to refuse; legal ground; the EU adequacy decision for the transfer to Korea and the SCCs for the onward transfer to Cloudflare | PIPA 28-8(1)(3)(가), 28-8(2)(1) to (5); PIPA-D 31(1)(2); PIPC-G item 10; GDPR 13(1)(f), 44 (onward transfers), 45, 46(2)(c); ADQ; CF; CF-MAIL |
| 8 | Security measures | PIPA-D 31(1)(3) and PIPA-D 30; PIPC-G item 11; GDPR 32. CODE: password PBKDF2 with salt `src/lib/auth/crypto.ts:17`; API key HMAC `src/lib/api-keys/key-store.ts:53`, `src/lib/auth/crypto.ts:76`; webhook secret encryption `src/lib/api-keys/secret-encryption.ts:26`, with the key `src/lib/api-keys/key-store.ts:198` and in a failed delivery `src/lib/api-keys/webhook-dispatcher.ts:701`; a queued job holds the secret until it ends, `src/lib/queue/enqueue.ts:35`; conversion sandbox without network `unshare -r -n`, docs/deploy-oci.md step 7; TLS, `deploy/oci/nginx-easyconvert.conf` |
| 9 | Cookies and storage on the device, purpose, lifetime, how to refuse | PIPA 30(1)(7); PIPC-G item 14. CODE: `src/lib/auth/session-cookie.ts:12`, `:13` (`LEGACY_SESSION_COOKIE_NAME`, `HOST_SESSION_COOKIE_NAME`), `:16` (the names read) and `:19` (the prefixed one is written in production), `src/lib/auth/session.ts:56` (`createSessionCookie`, `Max-Age`); `src/lib/auth/oauth.ts:6`, `:7`; `src/i18n/routing.ts:4` (no max-age, so a session cookie); `src/hooks/useThemeToggle.ts:19`; the program cache `src/lib/edge/pipelines/wasm-simd-pipeline.ts:50`; the session files `src/lib/edge/opfs/storage-gc.ts:23`, `:25` |
| 10 | Rights and how to exercise them; representatives; 10 days; objection to a refusal; EU complaint | PIPA 30(1)(5); PIPA 35 to 38, 38(1) (representative), 38(4) (no harder than the collection), 38(5) (objection); PIPA-D 41(4) (10 days); GDPR 13(2)(b), (d), 15 to 21, 77; PIPC-G item 16 |
| 11 | No accounts under 14 | PIPA 22-2; PIPC-G item 4 |
| 12 | No pseudonymised data, no automated decisions | PIPA 30(1)(4-2); PIPC-G items 13 and 17; GDPR 13(2)(f) |
| 13 | Privacy officer and contact | PIPA 30(1)(6); PIPA 31(1), 31(2) (the owner is the officer when none is designated); PIPC-G item 18; GDPR 13(1)(a), (b). A domestic representative (PIPA 31-2) does not apply: the operator is in Korea |
| 14 | Remedy bodies and their numbers | PIPC-G item 20 (the bodies and numbers are copied from its example) |
| 15 | Version date, changes announced, earlier versions kept | PIPA 30(2); PIPA-D 31(2); PIPC-G item 24 |
| Footer | The link is named "개인정보 처리방침" and set out in bold | PIPC-G section "개인정보 처리방침의 공개" (표준지침 제20조: name it so and set it apart by size, colour or weight) |

## Data processing terms

| Section | Content | Sources |
| --- | --- | --- |
| Intro | Applies when the user is the controller; part of the terms; takes effect on use | GDPR 28(3) (a contract binding the processor), 28(9) (in writing, including electronic form); PIPA 26(1); REF (processing agreement on request) |
| 1 | Subject, duration, nature, purpose, types of data, categories of data subjects | GDPR 28(3) first sentence; PIPA-D 28(1)(1) |
| 2 | Documented instructions, transfers included; notice of a legal requirement; notice of an unlawful instruction | GDPR 28(3)(a), 28(3) last paragraph; PIPA 26(1)(1), 26(5) |
| 3 | Confidentiality | GDPR 28(3)(b) |
| 4 | Security measures | GDPR 28(3)(c), 32; PIPA 26(1)(2); PIPA-D 28(1)(3) |
| 5 | Listed subprocessors, the mail route among them; 30 days' notice of changes, objection, flow-down, responsibility, no further delegation without consent | GDPR 28(2), 28(3)(d), 28(4); PIPA 26(6) (re-delegation needs the delegator's consent); PIPA-D 28(1)(2); CF-MAIL |
| 6 | Help with data subject requests, security, breaches, impact assessments; breach notice without undue delay | GDPR 28(3)(e), (f), 33(2) |
| 7 | Return or deletion at the end, at the controller's choice; no copies except the record backups of the privacy policy, deleted within 7 days | GDPR 28(3)(g) (deletes or returns all the personal data at the choice of the controller); PIPA-D 28(1)(4); docs/policy-decisions.md entries 125 and 186; RUN |
| 8 | Information and audits | GDPR 28(3)(h); PIPA 26(4); PIPA-D 28(1)(4), 28(6) |
| 9 | Liability | PIPA-D 28(1)(5); PIPA 26(7) |
| 10 | Signed copy on request | REF (processing agreement on request) |

## Acceptable use policy

| Section | Content | Sources |
| --- | --- | --- |
| Intro | Part of the terms | NET 44-2(5); REF (allowed usage inside the terms) |
| 1 | Forbidden content | NET 44-7(1)(1) to (9) (illegal information), 44(1) (rights of others); COPY 103 |
| 2 | Forbidden actions: limit evasion, disruption, unauthorised access through URL import or capture, key sharing, other uses | REF (Allowed Usage: no evasion of limits); NET 44-7(1)(4) (disrupting systems); CODE `src/lib/security/ssrf.ts` (the URL import refuses private addresses) |
| 3 | How to report and what to include; the operator receives every report and is the recipient of copyright notices | NET 44-2(1) (the request shows the infringement and names how to answer); COPY 103(1), 103(4) (a designated recipient made known to users); CODE `src/components/converter/info-page-sections.tsx` (the existing contact page) |
| 4 | Review, stop, delete, suspend; copyright stop, notice and resumption; reports to authorities; answer to the reporter; files may be gone | NET 44-2(2), (4); COPY 103(2), (3); NET 44-7(4); docs/policy-decisions.md entry 125 |

## Open points

- The privacy policy names the operator and privacy officer, Jeong Dongin, with the contact address `support@aquilaxk.site` (QA decision 2026-11-03), for PIPA 30(1)(6) and GDPR 13(1)(a). No telephone number is published; an e-mail address is the contact the service offers.
- The contact page and every request and report path show `support@aquilaxk.site`. Mail to it is forwarded by Cloudflare Email Routing to the operator's own mailbox (CF-MAIL). The provider of that mailbox is not named: if it is a service, it receives the messages as the operator's processor, and the privacy policy has to name it (PIPA 26(2), GDPR 13(1)(e)). QA to decide.
- Contact messages have no deletion period: they stay in the operator's mailbox until deleted on request. PIPA 21(1) asks for deletion once a message is no longer needed; a period has to be chosen. QA to decide.
- Accounts and API keys created before these terms are not asked to accept them; they are given notice of the terms on the website, and their records carry no `acceptedTermsVersion` (policy entry 146).
