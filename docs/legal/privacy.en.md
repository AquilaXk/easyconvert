# Privacy Policy

This policy explains which personal data EasyConvert processes, why, for how long, who helps us process it, and how you exercise your rights. It follows the Korean Personal Information Protection Act and, for visitors in the European Union, the General Data Protection Regulation (GDPR). The operator of EasyConvert is the controller of the personal data described here.

## 1. Why we process personal data

We process personal data only for these purposes:

- **To convert your files.** We receive your file or the link you give us, convert it, and deliver the result.
- **To run accounts and API keys.** We create and secure your account, sign you in, and let you manage API keys and webhooks.
- **To apply the free allowance and protect the service.** We count conversions per day, limit request bursts, and find and stop abuse.
- **To answer your requests.** We answer questions, reports and requests to exercise your rights.

Under the GDPR, the legal basis for the first two purposes is the performance of our contract with you (Art. 6(1)(b)). The basis for the third is our legitimate interest in keeping a free service available and secure (Art. 6(1)(f)). Answering a request from an authority is a legal obligation (Art. 6(1)(c)). We do not process personal data for advertising or profiling.

## 2. What we process

| Category | Items | When |
| --- | --- | --- |
| Files | The files you upload, the links you import and the pages you capture, the options you choose, and the converted results | When you convert |
| Conversion records | File name, formats, file size, status and times of each conversion | When you convert |
| Connection data | IP address (for IPv6, the /64 network), time, request method and path, response status, bytes sent | On every request |
| Account | Email address, display name, password hash, sign-in method, plan, the accepted version of the terms, creation and update times, number of conversions | When you create an account |
| Sign in with Google | Name, email address and profile picture, received from Google | Only if you sign in with Google |
| API keys | Key name, key prefix and hash, scopes, allowed IP addresses, webhook URL and encrypted signing secret, expiry, time of last use, daily usage | When you create an API key |
| Contact | Your email address and what you write to us | When you contact us |

Your files can contain personal data of you or of other people. We process that content only to convert it, by machine. We do not read it, analyse it or keep it longer than the result.

We do not ask for sensitive data or unique identification numbers. We do not sell personal data, and we do not use your files to train any model.

## 3. How long we keep it

| Data | Retention |
| --- | --- |
| Uploaded file | Deleted 10 minutes after the last conversion that reads it ends. An upload that no conversion uses is deleted after at most 1 day. |
| Converted result | Deleted 10 minutes after its first complete download, or 1 hour after it was made if nobody downloads it. Conversions on the website that return the result in the same response keep no copy. |
| Temporary files of a conversion | Deleted at the latest 2 hours after the conversion started. |
| File list entry of an account | Expires with its file. |
| Conversion records | Not deleted automatically at present. We delete them on request. |
| Daily allowance counters by IP address or account | Until the end of the day (UTC). |
| Upload allowance records by IP address or account | 2 days. |
| Sign-in attempt limits | 5 minutes. |
| Server access log (connection data) | Up to 14 days. |
| Account, API keys and usage | Until you ask us to delete your account. |
| Contact messages | Until your request is answered, then deleted. |

When the disk of the server runs full, results can be deleted before their time.

## 4. How we delete it

When a retention period ends, the system deletes the file or the record automatically, and it cannot be restored. When you ask us to delete your account, we delete the account, its API keys and its usage records without delay. We keep no backups of files.

## 5. Provision to third parties

We do not give your personal data to third parties. The exception is a request that a law requires us to answer, such as a warrant.

## 6. Processors

These companies process personal data on our behalf, only for the task we give them:

| Processor | Task | Location |
| --- | --- | --- |
| Oracle Corporation (Oracle Cloud Infrastructure) | Hosting of the servers, the files and the records | Seoul, Republic of Korea |
| Cloudflare, Inc. | Delivery and protection of the website and the API. Every request, files included, passes through its network | Data centres worldwide, see section 7 |

When sign-in with Google is offered and you use it, Google LLC receives your sign-in under its own privacy policy. Google is not our processor.

## 7. Transfers abroad

Cloudflare processes your requests in its data centre nearest to you, which can be outside Korea.

- **Data transferred.** Connection data, and the content of the requests and responses, files included.
- **Countries.** The countries of Cloudflare's network. Cloudflare, Inc. is based in the United States.
- **When and how.** At each request, over an encrypted connection (TLS).
- **Recipient.** Cloudflare, Inc., 101 Townsend St., San Francisco, CA 94107, USA, privacyquestions@cloudflare.com.
- **Purpose and retention.** To deliver and protect the service. Cloudflare keeps the data for the time its own customer terms allow.
- **How to refuse.** The service cannot be used without this network. If you refuse the transfer, do not use EasyConvert.

The legal ground is the disclosure in this policy of a processing that the contract with you requires (Korean Personal Information Protection Act, Art. 28-8(1)(3)). For visitors in the European Union, the Republic of Korea has an adequacy decision of the European Commission, and Cloudflare's customer terms include the EU standard contractual clauses.

## 8. Security

- Every connection is encrypted (TLS).
- Passwords are stored only as salted hashes. API keys are stored only as keyed hashes. Webhook signing secrets are encrypted at rest.
- The external conversion programs run in an isolated sandbox without network access. The files of a conversion are deleted on the schedule in section 3.
- Only the operator has access to the servers.

## 9. Cookies and local storage

| Name | Purpose | Lifetime |
| --- | --- | --- |
| `easyconvert_session` | Keeps you signed in | 7 days, or until you sign out |
| `easyconvert_oauth_state` | Protects the sign-in with Google | 10 minutes |
| `NEXT_LOCALE` | Remembers the language you chose | Until you close the browser |
| `theme` (local storage) | Remembers the light or dark theme | Until you clear it |

These are strictly necessary. We use no advertising or analytics cookies. You can block or delete cookies in your browser settings. Without the session cookie, you cannot sign in.

## 10. Your rights

You can ask to see, correct or delete your personal data, to stop its processing, and, under the GDPR, to receive it in a portable format or to object to processing based on our legitimate interest. To exercise a right, send a request through the [contact page](/contact). A legal representative or a person you authorise can make the request for you.

We answer within 10 days. If we refuse a request, we tell you why and how to object. If you are in the European Union, you can also complain to the data protection authority of your country.

## 11. Children

Children under 14 cannot create an account. If we learn that an account belongs to a child under 14, we delete it.

## 12. Other processing

We do not process pseudonymised data. We do not make decisions about you by automated means that have legal or similar effects.

## 13. Privacy officer

The operator of EasyConvert is the privacy officer. Send privacy questions, requests and complaints through the [contact page](/contact).

## 14. Remedies

If you need help with a privacy problem, you can also contact these Korean bodies:

- Personal Information Dispute Mediation Committee: 1833-6972, www.kopico.go.kr
- Personal Information Infringement Report Center: 118, privacy.kisa.or.kr
- Korean National Police Agency, cyber crime: 182, ecrm.police.go.kr

## 15. Changes to this policy

The date at the top of this page is the version of this policy. We announce changes on this website before they take effect, and we keep earlier versions available. This is the first version.
