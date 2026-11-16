# Ranger — OMAG's Camp Safety Assistant

**Ranger** helps Oklahoma city and town staff prepare for the Oklahoma camp safety law (HB 1675, 63 O.S. §§ 683.24C–683.24K and § 681). It replaces OMAG's "Oklahoma Municipal Camp Safety Planner" CustomGPT. Ranger:

- **finds what may be covered:** inventories a municipality's camps, campgrounds, parks and youth programs, and screens each against the statutory definitions and exemptions;
- **interviews, one question at a time,** through a site-specific hazard assessment and an emergency action plan, reusing every answer;
- **builds the documents:** fills OMAG's Word templates (hazard assessment, emergency action plan with a campground version, hazard disclosure and acknowledgment, training and drill record) with what the member told it, each marked as a draft pending review;
- **cites the law it read:** every legal point links to the actual section text.

**Status:** Built November 2026 from Pip (`omag-web/omag-hr`) and not yet deployed. See [`docs/deploy.md`](docs/deploy.md) for first-time setup.

Ranger is **a separate system from Pip**. It has its own repo, AWS stack (`ranger-camp-safety`), database, storage, admin users, deploy role, alarms and address. The code started as a copy of Pip's, so the two work the same way, but nothing is shared at runtime.

**Name:** "Ranger" is set in one place in each front end (`const BOT = 'Ranger'`) and in `backend/src/prompt.mjs`. Its icon is a gold tent in a chat bubble, in OMAG navy and gold. Always show it with "OMAG's camp safety assistant" and an **AI** label.

## What's in the repo

| Path | What it is |
|---|---|
| [`web/`](web/) | **The member page.** Full-page chat with a **Program type** picker (youth camp or outdoor program, camp facility, recreational campground, not sure). Set the API address in `web/config.js`. |
| [`web/admin/`](web/admin/) | **The admin panel** (sign-in required): analytics, instructions, document templates, OMAG documents and web pages, conversations, "Talk to OMAG" messages, settings, statute library, answer checks, admins. |
| [`backend/`](backend/) | **The API.** AWS Lambda + OpenAI GPT-5.6 on Amazon Bedrock + DynamoDB, deployed with AWS SAM (`template.yaml`). |
| [`backend/src/prompt.mjs`](backend/src/prompt.mjs) | Ranger's instructions: a locked core (citations, never fabricate findings or approvals, drafts aren't compliance, child privacy, stay on topic) plus OMAG's editable guidance, which carries the GPT's five workflows (discovery, applicability, hazard assessment, EAP, oversight). |
| [`knowledge/sources.json`](knowledge/sources.json) | What the statute library contains: Title 63 (camp safety law, § 681, Emergency Management Act), Title 51 (Tort Claims Act), Title 82 (Floodplain Management Act), and the enrolled HB 1675 as a fallback until Title 63 is republished. |
| [`knowledge/templates/`](knowledge/templates/) | The starter Word templates as an importable pack, and the script that builds it. |
| [`docs/`](docs/) | [`deploy.md`](docs/deploy.md) (setup and day-to-day), [`scope.md`](docs/scope.md) (plan and decisions), [`gpt-instructions.md`](docs/gpt-instructions.md) (the CustomGPT's original instructions). |

## How it works

1. A member picks a program type and asks a question. The page sends the conversation and program type to `POST /chat`.
2. The Lambda gives the model Ranger's system prompt, starting-point sections for that program type, and tools: `search_law`, `get_sections`, and `offer_document`.
3. Ranger researches, then answers, citing sections as `[[63-683.24E]]`. Only citations to sections it actually read are kept and shown as clickable chips.
4. When an interview has gathered enough, Ranger offers a document. The member gets a form already filled in with what they said, checks it, and downloads the Word file.
5. OMAG documents and web pages added in the admin panel (OEM's camp safety page and checklist, for example) are searched alongside the statutes and cited as guidance.
6. Each question is logged (with citations, tokens and rating) for analytics and review. There are no accounts: conversation history lives in the member's browser.

## The program type

Pip's "form of government" picker became the **program type**, because it decides which sections and deadlines apply and which document version a member gets. In the code and API the field is still called `form`. The keys are `camp`, `facility`, `campground` and `unsure` (see `FORMS` in `backend/src/prompt.mjs`). Document templates can have a file for every type (`all`) or a separate file per type. The emergency action plan uses this to give recreational campgrounds their own version.

## Run it locally

```bash
cd backend
npm install
npm test                 # 65 tests, no AWS needed (uses a small test library in test/fixtures/)
LIBRARY_PATH=test/fixtures/library.json npm run dev:mock
                         # http://localhost:8787 with a scripted stand-in model
                         # admin panel at http://localhost:8787/admin/ (no sign-in locally)
```

The test library's text is marked as a fixture and is never deployed. The real library (`backend/data/library.json`) is built from the official sources by the *Build statute library* workflow, or by the first deploy.
