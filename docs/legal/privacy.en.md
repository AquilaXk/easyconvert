# Privacy Policy

This policy explains which personal data EasyConvert processes, why, for how long, who helps us process it, and how you exercise your rights. It follows the Korean Personal Information Protection Act and, for visitors in the European Union, the General Data Protection Regulation (GDPR).

The operator of EasyConvert, Dongin Jeong (정동인, support@aquilaxk.site), is the controller of the personal data described here.

## 1. Why we process personal data

We process personal data only for these purposes:

- **To convert your files.** We receive your file or the link you give us, convert it, and deliver the result.
- **To run accounts and API keys.** We create and secure your account, sign you in, and let you manage API keys and webhooks.
- **To sell and manage paid plans.** We pass the email address of your account to the checkout, record your subscription and its status, and apply the limits of your plan.
- **To apply the allowance of your plan and protect the service.** We count conversions per day on the free plan and per month on a paid plan, limit request bursts, and find and stop abuse.
- **To answer your requests.** We answer questions, reports and requests to exercise your rights.

Under the GDPR, the legal basis for the first three purposes is the performance of our contract with you (Art. 6(1)(b)). The basis for the fourth is our legitimate interest in keeping a free service available and secure (Art. 6(1)(f)). Answering a request from an authority is a legal obligation (Art. 6(1)(c)). We do not process personal data for advertising or profiling.

No law requires you to give us personal data. A conversion on our servers needs the file. An account needs an email address and a password, or a sign-in with Google, because the contract for an account cannot be made without them. A paid plan also needs the payment data that you give to Paddle (section 6). Without an account you can still use EasyConvert within the free allowance.

## 2. What we process

A conversion that your browser supports runs on your device: its file is not uploaded, and we receive nothing of it. The table lists what reaches our servers.

| Category | Items | When |
| --- | --- | --- |
| Files | The files you upload, the links you import and the pages you capture, the options you choose, and the converted results | When a conversion runs on our servers |
| Conversion jobs | Job id, file name, formats, file size, the options you chose (passwords encrypted), webhook URL and signing secret, your account or, without an account, your IP address (for IPv6, the /64 network), status, times, progress, the link, size and type of the result, and the reason of a failure | When a conversion is queued on our servers |
| Edge server log | IP address, time, request method and path, response status, bytes sent | Only for requests that fail (status 400 to 599) |
| Allowance and request counters | Your account or, without an account, your IP address (for IPv6, the /64 network), and a count | When you convert or call the API |
| Account | Email address, display name, password hash, sign-in method, plan, the accepted version of the terms, creation and update times, number of conversions | When you create an account |
| Sign in with Google | Name, email address and profile picture, received from Google | Only if you sign in with Google |
| API keys | Key name, key prefix and hash, scopes, allowed IP addresses, webhook URL and encrypted signing secret, the accepted version of the terms, expiry, time of last use, usage | When you create an API key |
| Subscription | Paddle's customer id and subscription id, the plan, the status, the end of the paid period, and the date a cancellation takes effect. No card number, address or amount | When you subscribe, and each time Paddle reports a change |
| Payment data held by Paddle | Name, email address, billing country and address, payment method, tax data, transaction history, IP address. Paddle collects them at checkout, and we do not receive them | When you pay for a paid plan |
| Failed webhook deliveries | Target URL, event, the message (job id, file name, result link, failure), the encrypted signing secret, status and error, times | When a delivery to your webhook fails |
| Contact | Your email address and what you write to us | When you write to support@aquilaxk.site |

Your files can contain personal data of you or of other people. We process that content only to convert it, by machine. We do not read it, analyse it or keep it longer than the result.

We do not ask for sensitive data or unique identification numbers. We do not sell personal data, and we do not use your files to train any model.

## 3. How long we keep it

| Data | Retention |
| --- | --- |
| Uploaded file | Deleted 10 minutes after the last conversion that reads it ends. An upload that no conversion uses is deleted after at most 1 day. |
| Converted result | Deleted 10 minutes after its first complete download, or 1 hour after it was made if nobody downloads it. Conversions on the website that return the result in the same response keep no copy. |
| Temporary files of a conversion | Deleted at the latest 2 hours after the conversion started. |
| Conversion job, also one of several steps | Deleted 25 hours after the job ends: 1 hour while its result can be downloaded, then 1 day in which a download of the deleted result answers that it was deleted. The file content sent with the job and its webhook signing secret are deleted when the job ends. A backup can still hold them, see the backup row. |
| Copy of a failed job, kept to find the cause | Deleted 25 hours after the failure. |
| Failed webhook delivery | Deleted 30 days after the delivery failed, or earlier when you delete it in the dashboard. |
| File list entry of an account | Expires with its file. |
| Daily allowance counters | Until the end of the day (UTC). |
| Monthly allowance counters of a paid plan | Until the end of the month of the subscription, so for at most a month after the first conversion in it. |
| Subscription record | Until you ask us to delete your account. Paddle keeps the payment data under its own privacy notice. |
| Request burst counters | 1 hour after the last request. |
| Upload allowance records | 2 days. |
| Sign-in attempt limits | 5 minutes. |
| Edge server log | Up to 15 days. The log is rotated daily and 14 earlier files are kept. |
| Account, API keys and usage | Until you ask us to delete your account. |
| Backup of the account and job records | A backup is made every 6 hours, kept on the same server and not copied elsewhere, and deleted at the latest 7 days after it was made. It holds the account, API key and job records as they were at that time. A job sent through the API with the file in the request body keeps that file in its record until the job ends, so a backup made while such a job runs keeps the file until the backup is deleted, at most 7 days. Uploaded files and converted results are not backed up. |
| Contact messages | Kept in the operator's mailbox. We delete them on request. |

These periods are the settings in force on the date at the top of this page. When the disk of the server runs full, results can be deleted before their time.

## 4. How we delete it

When a retention period ends, the system deletes the file or the record automatically, and it cannot be restored from the system. The one exception is a copy in a backup of the records (section 3), which stays until that backup is deleted, at most 7 days after it was made. We make no backups of uploaded files or results, and we use a backup only to restore the service after a failure.

When you ask us to delete your account, the operator checks that the request comes from the account's email address. The operator then deletes the account, its API keys and their signing secrets, its conversion jobs and their files, its failed webhook deliveries, its subscription record and its usage records with a tool that removes each of these records, and tells you when it is done. The operator does this within 2 days of the verified request. Copies of the account in backups are deleted within the following 7 days and 6 hours, so everything is gone within 10 days of your request. When the service is restored from a backup, the operator deletes again every account that was deleted after that backup was made. Deleting an account does not cancel a subscription. Cancel it first from your dashboard, or tell us, so that Paddle does not charge you again. The payment data held by Paddle is deleted by Paddle, as its privacy notice describes.

## 5. Provision to third parties

We do not give your personal data to third parties, with two exceptions. When you open the checkout of a paid plan, we pass the email address of your account to Paddle (section 6), so that Paddle can send you the receipt. And we answer a request that a law requires us to answer, such as a warrant.

## 6. Processors

These companies process personal data on our behalf, only for the task we give them:

| Processor | Task | Location |
| --- | --- | --- |
| Oracle Corporation (Oracle Cloud Infrastructure) | Hosting of the servers, the files and the records | Seoul, Republic of Korea |
| Cloudflare, Inc. | Delivery and protection of the website and the API: every request, files included, passes through its network. Forwarding of the mail sent to support@aquilaxk.site to the operator's mailbox, without keeping it | Data centres worldwide, see section 7 |

The mail you send to support@aquilaxk.site arrives in the operator's own mailbox, where the operator reads and answers it.

When sign-in with Google is offered and you use it, Google LLC receives your sign-in under its own privacy policy. Google is not our processor.

Paddle.com sells the paid plans as our reseller and merchant of record. Paddle is not our processor. It collects and uses your payment data for its own purposes, such as taking the payment, taxes, fraud prevention and accounting, and it is an independent controller of that data. Its controllers are Paddle.com Market Limited (United Kingdom), Paddle.com Inc. (United States), Paddle Payments Limited (Ireland) and Paddle.com Canada Ltd. Read [Paddle's privacy notice](https://www.paddle.com/legal/privacy) to learn what it does with your data and how to exercise your rights against it.

## 7. Transfers abroad

Cloudflare processes your requests, and the mail you send to the support address, in its data centre nearest to you, which can be outside Korea.

- **Data transferred.** Connection data, the content of the requests and responses, files included, and the mail you send to support@aquilaxk.site.
- **Countries.** The countries of Cloudflare's network. Cloudflare, Inc. is based in the United States.
- **When and how.** At each request and each mail, over an encrypted connection (TLS).
- **Recipient.** Cloudflare, Inc., 101 Townsend St., San Francisco, CA 94107, USA, privacyquestions@cloudflare.com.
- **Purpose and retention.** To deliver and protect the service and to forward mail. Cloudflare keeps request data for the time its own customer terms allow, and does not store the mail it forwards.
- **How to refuse.** The service cannot be used without this network. If you refuse the transfer, do not use EasyConvert.

The email address that we pass to Paddle at checkout, and the payment data you give to Paddle, go to Paddle's entities in the United Kingdom, the United States, Ireland and Canada. Paddle is responsible for those transfers under its own privacy notice.

The legal ground is the disclosure in this policy of a processing that the contract with you requires (Korean Personal Information Protection Act, Art. 28-8(1)(3)). For visitors in the European Union, the European Commission's adequacy decision for the Republic of Korea covers the transfer of your data to the operator in Korea. The onward transfer to Cloudflare in the United States and other countries is made under Cloudflare's customer terms, which include the EU standard contractual clauses (GDPR Art. 46(2)(c)).

## 8. Security

- Every connection is encrypted (TLS).
- Passwords are stored only as salted hashes. API keys are stored only as keyed hashes. Webhook signing secrets are encrypted at rest, with the key and in a failed delivery. A queued conversion carries the secret given with it until it ends.
- The external conversion programs run in an isolated sandbox without network access. The files of a conversion are deleted on the schedule in section 3.
- Only the operator has access to the servers.

## 9. Cookies and storage on your device

| Name | Purpose | Lifetime |
| --- | --- | --- |
| `__Host-easyconvert_session` | Keeps you signed in | 7 days, or until you sign out |
| `easyconvert_session` | The earlier name of the same cookie. We no longer set it, and still read it for a session that began under it | Until that session ends, at most 7 days |
| `easyconvert_oauth_state` | Protects the sign-in with Google | 10 minutes |
| `NEXT_LOCALE` | Remembers the language you chose | Until you close the browser |
| `theme` (local storage) | Remembers the light or dark theme | Until you clear it |
| `easyconvert_wasm_cache` (IndexedDB) | Keeps the conversion programs your browser runs, so they are not downloaded again. It holds no personal data | Until you clear the site's data |
| `easyconvert/sessions` (origin private file system) | Holds the files of a conversion that runs in your browser, while it runs | Deleted when the conversion ends. Files left by a closed tab are deleted at the next conversion in your browser, once they are 2 hours old |

These are strictly necessary. We use no advertising or analytics cookies. You can block or delete cookies and site data in your browser settings. Without the session cookie, you cannot sign in. When you open the checkout of a paid plan, Paddle loads it from its own servers and can use its own cookies and storage, which its privacy notice describes.

## 10. Your rights

You can ask to see, correct or delete your personal data, to stop its processing, and, under the GDPR, to receive it in a portable format or to object to processing based on our legitimate interest. To exercise a right, send a request through the [contact page](/contact). A legal representative or a person you authorise can make the request for you.

We answer within 10 days. If we refuse a request, we tell you why and how to object. If you are in the European Union, you can also complain to the data protection authority of your country.

## 11. Children

Children under 14 cannot create an account. If we learn that an account belongs to a child under 14, we delete it.

## 12. Other processing

We do not process pseudonymised data. We do not make decisions about you by automated means that have legal or similar effects.

## 13. Privacy officer

The privacy officer is Dongin Jeong (정동인), the operator of EasyConvert. Send privacy questions, requests and complaints to support@aquilaxk.site or through the [contact page](/contact).

## 14. Remedies

If you need help with a privacy problem, you can also contact these Korean bodies:

- Personal Information Dispute Mediation Committee: 1833-6972, www.kopico.go.kr
- Personal Information Infringement Report Center: 118, privacy.kisa.or.kr
- Korean National Police Agency, cyber crime: 182, ecrm.police.go.kr

## 15. Changes to this policy

The date at the top of this page is the version of this policy. We announce changes on this website before they take effect, and we keep earlier versions available. This version adds Paddle as the payment provider of the paid plans.
