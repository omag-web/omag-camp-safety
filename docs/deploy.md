# Deploying Ranger

Ranger is its own system: its own GitHub repo (`omag-web/omag-camp-safety`), its own AWS stack (`ranger-camp-safety`), and its own address on OMAG's domain. It shares nothing with Pip except the AWS account. Deploying, changing or deleting Ranger never touches Pip's stack, database, admin users or site.

| | Pip (HR) | Ranger (camp safety) |
|---|---|---|
| Repo | `omag-web/omag-hr` | `omag-web/omag-camp-safety` |
| AWS stack | `pip-hr` | `ranger-camp-safety` |
| Deploy role | `pip-hr-github-deploy` | `ranger-camp-safety-github-deploy` |
| Address | hr.omag.org | e.g. campsafety.omag.org |
| Admin users | Pip's user pool | `ranger-camp-safety-admins` (separate sign-in) |

The one thing in the account both use is GitHub's identity provider (`token.actions.githubusercontent.com`). Pip's role stack created it; Ranger's role reuses it and never changes or deletes it.

First-time setup takes about 45 minutes, nearly all of it waiting. Nothing here needs `sam deploy` from your PC, so the office firewall doesn't matter.

## 1. Create the repo and push

1. On GitHub, create `omag-web/omag-camp-safety` (empty: no README, no .gitignore).
2. Push this code to its `main` branch.

## 2. Build the statute library once

**Actions → Build statute library (developer copy) → Run workflow.** It downloads Title 63 (the camp safety law and § 681), Title 51 (Tort Claims Act) and Title 82 (Floodplain Management Act) from the Legislature, plus the enrolled HB 1675 as a fallback, and commits `backend/data/library.json`. Open the run's log: it should list each source, and say whether the HB 1675 sections came from Title 63 or from the enrolled bill.

If it stops on a **required section**, the log shows the raw PDF text around it. Send it to whoever maintains the code. (The deploy also builds the library itself if this step was skipped, but doing it first lets you check the log.)

## 3. Turn on the model in Bedrock

Ranger uses the same model as Pip, **OpenAI GPT-5.6 Terra** through Amazon Bedrock (`us.openai.gpt-5.6-terra`). Model access is per account and region, and Pip already turned it on in us-east-1, so there's normally nothing to do. To switch models later, use the admin panel's **Settings → AI model**.

## 4. Create Ranger's deploy role

From the `omag-camp-safety` folder, with your AWS profile:

```
aws cloudformation deploy --template-file deploy/github-deploy-role.yaml --stack-name ranger-camp-safety-github-deploy --capabilities CAPABILITY_NAMED_IAM --profile omag --region us-east-1
```

This creates a role only the `main` branch of `omag-web/omag-camp-safety` can use. It reuses the GitHub identity provider Pip set up (`CreateGitHubOidcProvider` defaults to `false`). OMAG's GitHub identifies repos to AWS by ID number, so the role's `RepositoryWithIds` must match this repo's ID (`1461522876`). If the deploy says *Not authorized to perform sts:AssumeRoleWithWebIdentity*, check that value.

You can also do this in the AWS console: **CloudFormation → Create stack → Upload a template file**, choose `deploy/github-deploy-role.yaml`, name it `ranger-camp-safety-github-deploy`, keep the defaults, and tick the IAM acknowledgment.

## 5. First deploy

**Actions → Deploy backend → Run workflow.** Fill in:
- **admin_email**: your OMAG email. You'll get an admin panel invitation.
- **contact_email**: who gets "Talk to OMAG" messages and alarm emails (for example `rmsinfo@omag.org`). AWS emails it a confirmation link; click it.
- Leave the web address fields blank for now.

A green check after about 10 minutes means Ranger is live. Open the run's **Deploy** step to find the **ApiUrl** and **AdminUrl** outputs (also in **CloudFormation → ranger-camp-safety → Outputs**).

From then on, merging anything that changes `backend/` deploys automatically, after the tests pass. Settings you change later in the admin panel are never reset by a deploy.

## 6. Connect the web page

Set `apiUrl` in `web/config.js` to the ApiUrl (no trailing slash), then commit and push. Until Ranger has its own address, the page is at `https://omag-web.github.io/omag-camp-safety/web/` (turn on **Settings → Pages → Deploy from branch → main** for the repo).

## 7. Give Ranger its own address (campsafety.omag.org)

Like Pip's hr.omag.org, this serves the pages from AWS (private S3 bucket + CloudFront) with its own certificate and DNS records.

1. In **Route 53 → Hosted zones → omag.org**, copy the **Hosted zone ID** (starts with `Z`). It's the same zone Pip uses; Ranger only adds its own records.
2. **Actions → Deploy backend → Run workflow** with **site_domain** `campsafety.omag.org` (or whatever name you choose) and the hosted zone ID. The first run takes 10–25 minutes while the certificate and CloudFront are set up.
3. Open `https://campsafety.omag.org/` and `/admin/`. Then update the link on omag.org/camp-safety.

After that, every change to `web/` publishes itself. To make the repo private, follow "Making the GitHub repo private" below.

## 8. Set a budget

Bedrock bills by model, not by app, so Pip's and Ranger's AI usage show up together on the AWS bill. Two ways to watch Ranger's share:
- **In Ranger's admin panel:** set the Bedrock token prices under **Settings**, and **Analytics** shows Ranger's own estimated cost.
- **In AWS:** if Pip's $40 budget is filtered to Amazon Bedrock, it now covers both. Raise it to cover both (for example $60), or add a second budget filtered to **Tag `app` = `ranger`** for Ranger's Lambda, storage and database costs (activate the `app` tag under **Billing → Cost allocation tags**).

Ranger's own daily question limits (**Settings**) cap its AI spend regardless.

## 9. Sign in and load the starter content

1. Use the invitation email to sign in at the AdminUrl and set up two-step sign-in.
2. **Documents:** nothing to import. Ranger writes each document itself after interviewing the member. To show it what a good one looks like, add plain Word files under **Sample documents** (see the README's "Documents" section).
3. **OMAG documents → Add a web page**: add `https://oklahoma.gov/oem/home/camp-safety.html` (OEM's camp safety page) and `https://www.omag.org/camp-safety`. Upload OEM's HB 1675 checklist PDF and fact sheet as documents, with publisher **OEM**. Ranger re-reads web pages daily and cites these as guidance, separately from the statute.
4. **Instructions**: read the editable guidance (it carries the CustomGPT's five workflows) and adjust anything OMAG wants said differently. Try it in the preview before publishing.
5. **Answer checks → Run checks now** to see how Ranger does on the 30 starter questions.

### Making the GitHub repo private

Do this only after the new address works.

1. **Publish the law library to AWS once.** **Admin panel → Statute library → Rebuild now** (or the *Build statute library* workflow). The admin panel's **Check for updates now** should then say "Already up to date".
2. **Make it private**: **Settings → General → Danger Zone → Change repository visibility → Make private**, and unpublish GitHub Pages.

### Signing in, more admins, two-step sign-in

Ranger's admins are separate from Pip's: being a Pip admin doesn't give access to Ranger, or the other way round. Invite more on the **Admins** page. Every admin must use an authenticator app; if everyone is locked out, open **Cognito → `ranger-camp-safety-admins` → Authentication → Sign-in → Multi-factor authentication** and set it to Optional temporarily.

## Day-to-day

Everything day to day is done in the admin panel, with no GitHub or AWS console and no redeploy:

| To… | Go to |
|---|---|
| Change how Ranger answers (the interview workflows, tone, standing rules, when to send members to OMAG) | **Instructions**: edit the draft, try it in the preview, then **Publish**. Every published version is kept; **Version history → Load into draft** rolls back. |
| Give Ranger guidance to cite (OEM's camp safety page and checklist, OMAG memos, FAQs, web pages) | **OMAG documents**: upload a PDF, Word (.docx) or text file, or add a web page by its address. Ranger re-reads web pages daily and keeps the last good copy if a site is down. Switch an item off to stop Ranger using it without deleting it. Scanned PDFs need OCR first; pages that only show their content with JavaScript can't be read (save them as PDF instead). |
| See usage: questions over time, topics, most-cited laws, busy hours, municipalities, helpful rate, response time, cost; download everything as CSV | **Analytics** (set the Bedrock token prices under **Settings** to see a cost estimate) |
| Read what members asked, and see 👎 answers | **Conversations** |
| Read "Talk to OMAG" messages | **Talk to OMAG** (also emailed to the **"Talk to OMAG" messages** list under **Settings → Who gets Ranger's emails**) |
| Change the welcome text, starter questions, disclaimer, phone, privacy notice, how long conversations are kept (18 months by default), model, backup model or daily limits | **Settings**. Answers to Ranger's own question cards don't count toward the per-person daily limit. |
| Choose who gets "Talk to OMAG" messages, and separately who gets alarm and failure emails | **Settings → Who gets Ranger's emails**: two lists. New addresses must click AWS's confirmation email first. Until someone confirms on the messages list, members' notes go to the alerts list so none are lost. |
| Add, remove or re-invite admins, or change what they can see | **Admins** (Access button) |
| Show Ranger a good example of a document | **Sample documents → New sample**: give it a title and a "what it covers" line, upload a plain Word file (one for every program type, or one per type), then switch it on. Ranger reads it as a guide and writes fresh; it doesn't copy the wording. |
| Change which documents are suggested | The sidebar list is `DOC_IDEAS` in `web/index.html`. The welcome-screen buttons are under **Settings → Starter questions**: tick **Doc** and word it as a request, e.g. "Write a water safety plan for our camp". |
| See or search the statute library, check its source addresses, change them, add a title or CFR part, or rebuild it | **Statute library**: **Check links**, **Edit sources**, **Rebuild now** (about 3–8 minutes; Ranger keeps answering meanwhile) |
| Test Ranger's answers after changing the instructions, model or library; add or edit test questions | **Answer checks**: **Run checks now** (about 5–10 minutes, about $1–2); click a past run to see each answer |

**What each admin can see.** Each admin has one or more areas: **Reports** (Analytics), **Content** (Instructions, OMAG documents, sample documents, statute library, answer checks), **Conversations and messages** (members' conversations and "Talk to OMAG" notes), **Settings** (limits, AI model and prices, welcome screen, privacy notice, retention, email lists), and **Admins** (the Admins page). Pick them when you invite someone (Reports and Content are ticked by default), or click **Access** next to their name later; changes take effect within a minute. The server enforces them, not just the menu. Admins who existed before access levels keep everything. At least one admin always keeps **Admins**, and nobody can take it away from themselves. Someone without **Admins** still sees a **Your account** page for their own two-step sign-in. Areas are stored in DynamoDB under `ADMINACCESS` (`backend/src/permissions.mjs`). To try the panel as a limited admin locally: `LOCAL_ADMIN_AREAS=reports,content npm run dev`.

**Keep me signed in.** Ticking it on the admin sign-in page skips the password and two-step code on that computer for 7 days (the refresh-token lifetime, `RefreshTokenValidity` in `backend/template.yaml`). Without it, sign-in lasts until the tab closes. Don't tick it on a shared computer. Turning someone off still signs them out within a minute.

Some things are built into the code and can't be changed in the panel: Ranger identifies itself as an AI assistant, reads the actual sections before citing them, drops citations it didn't read, never invents hazard findings, ratings, approvals or completed drills, marks every draft as pending review, never says a site is compliant, and never presents itself as legal counsel, an emergency manager or an engineer.

**Privacy.** The AI runs inside OMAG's AWS account through Amazon Bedrock. Members' questions aren't sent to OpenAI or used to train models. Ranger itself saves conversations (for 18 months by default; change it under **Settings → Privacy notice**) so admins can review them, so it also guards against personal details:
- The member page warns before sending a message that looks like it contains a Social Security, card, bank account or driver's license number, a birth date, an email address or a phone number, and offers to remove them.
- The server removes ID numbers, account numbers and birth dates again before anything reaches the AI or the logs. This also covers "Talk to OMAG" messages.
- Ranger never repeats personal details back and refers to people by role.
- Names, medical details and children's information can't be detected reliably by pattern, so the page asks members to leave them out, and Ranger never asks for them (rosters and procedures are described by role and headcount).
- Members can attach a PDF, Word (.docx) or text file (up to 4 MB, about 20,000 words read), such as an existing emergency plan, a use agreement or a checklist, for Ranger to review. The file is read once and isn't stored; ID and account numbers are removed from its text first, and the conversation record shows only the file name. A long document costs more per question (roughly 10–20¢ instead of 6–8¢), and each person can attach 40 files a day.
- The **Privacy** link under the message box opens a plain-language notice: what's kept, how it's used, how long, and a button to clear conversations saved in that browser. Edit it under **Settings → Privacy notice**, where `{retention}` and `{phone}` fill in automatically. Have OMAG Legal review it.

To keep conversations for less time, change **Keep conversations for (days)** under **Settings → Privacy notice**. It applies to records saved from then on.

**Updating the statute library.** A second function in AWS, the *worker*, rebuilds the library from the official sources on the 3rd of each month and whenever someone clicks **Rebuild now** under **Statute library**. It uses the sources edited on that page (the first deploy copies `knowledge/sources.json` there; after that the repo file is only a starting point). When a rebuild finishes, Ranger switches to the new library right away. If a source fails or a **required section** is missing, the rebuild stops, Ranger keeps the library it has, and everyone on the email list gets the details. The page shows what happened step by step.

The worker is a container image with `pdftotext` (`backend/worker.Dockerfile`). Every pull request builds that image and does a real rebuild inside it (the *Test* workflow), so a change that would break rebuilds is caught before it deploys. `knowledge/scripts/build-library.mjs` (or the *Build statute library (developer copy)* workflow) builds the copy that ships with each deploy.

**Changing the built-in rules.** The locked part of Ranger's instructions is in `backend/src/prompt.mjs`. Edit it, run `npm test` and `npm run eval`, then redeploy. The default text of the editable part (`DEFAULT_GUIDANCE`) is in the same file; it's only used until someone publishes from the admin panel.

**Switching models.** Pick one under **Settings → AI model** (or **Another model** to type any Bedrock model ID), then click **Run checks now** under **Answer checks**. To try a model locally first: `MODEL_ID=<new id> npm run dev` and `npm run eval`.

**Raw data.** Conversations are in DynamoDB (`ranger-camp-safety-RangerTable-…`) and delete themselves after the retention period set in **Settings**. Uploaded OMAG documents and the refreshed library are in the S3 bucket `ranger-camp-safety-databucket-…`.

**403 Forbidden from the API URL.** The function's resource policy needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`; the template adds both. In the Lambda console → the function → **Configuration → Permissions → Resource-based policy statements**, you should see two statements allowing `*`. Also check that the page's origin is listed in `AllowedOrigins` (a CORS error shows in the browser console, not as a 403).

**Errors.** CloudWatch → Log groups → `/aws/lambda/ranger-camp-safety-RangerFunction-…`.

## Keeping Ranger healthy

**Alarm emails** go to the **Alerts** list under **Settings → Who gets Ranger's emails**. (Each new address gets a "Subscription Confirmation" email from AWS first. Its link must be clicked, or no alarms arrive.) Each alarm and what to do:

| Alarm | What it means | What to do |
|---|---|---|
| **Ranger is down** | The /health check failed from several places for 1.5 minutes | Check the Lambda log for errors. If the last deploy caused it, revert that PR on GitHub (it redeploys) |
| **Errors** | 5+ failed requests in an hour | Read the Lambda log |
| **Throttled** | AWS refused to run Ranger because too many requests were running at once | Usually a burst; if it repeats, ask AWS for a higher Lambda concurrency limit |
| **Slow answers** | An answer took over 4 minutes | Ranger stops researching at about 3 minutes and answers with what it has. If this repeats, the model is slow that day |
| **Daily limit reached** | The everyone-per-day limit was hit and members were turned away | Raise it under **Settings** if the use is real |
| **Backup model in use** | The main model failed 3+ times in an hour and Ranger switched to the backup | Check the AWS Health dashboard for Bedrock. If the main model was retired, pick a new one under **Settings → AI model** |

**Backup model.** If the main AI model is busy, down or retired, Ranger retries that answer with the backup model (**Settings → Backup model**, default GPT-5.6 Luna) instead of showing members an error. Choose "None" to turn this off.

**Weekly answer check.** Every Monday morning the worker asks the questions on the **Answer checks** page (30 to start, from `backend/eval/questions.json`). It checks that each answer cites the right laws, never repeats a Social Security number, says it's an AI when asked, never calls a site compliant, sends members to 911 in a live emergency, and stays on camp safety. If fewer than 80% pass, everyone on the email list gets the failing questions. Click a run on that page to see every answer. Run it yourself after changing the instructions, the model or the library. Each run costs about $1–2.

**Library safety checks.** If a **required section** (listed under **Statute library → Edit sources**) goes missing, the rebuild stops and Ranger keeps the current library. That can happen, for example, if the Legislature changes its PDF layout. The page shows the raw PDF text around each missing section, and the same goes out by email. Oklahoma laws usually take effect July 1 and November 1, and the monthly rebuild picks them up. Until the Legislature's Title 63 PDF includes HB 1675, the HB 1675 sections come from the enrolled bill (listed under **Enrolled bills** on the Statute library page); once the title includes them, the title's text is used automatically. If 63 O.S. § 681 still lacks the campground amendment, the rebuild log warns about it.

**What still needs GitHub or AWS.** Code changes (anything in the repo), Ranger's own web address (**Actions → Deploy backend → Run workflow**), alarm thresholds, the AWS budget, and turning off the two-step sign-in requirement (`RequireAdminMfa`).

**Package updates.** On Mondays, Dependabot opens pull requests when Ranger's packages or GitHub Actions have updates; security fixes arrive sooner. Each PR runs the tests. Merge it if they pass, and it deploys automatically.

**Deleted or overwritten files.** The S3 bucket keeps old versions of uploaded OMAG documents and sample documents for 90 days. DynamoDB has point-in-time recovery for 35 days. Ask whoever manages AWS to restore either if needed.

**Taking it offline.** In the admin panel, set **Settings → Questions per day, everyone** to 0 (members see a "daily limit" message), or delete the stack with `sam delete`.
