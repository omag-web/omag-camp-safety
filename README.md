# Ranger — OMAG's Camp Safety Assistant

**Ranger** helps Oklahoma city and town staff prepare for the Oklahoma camp safety law (HB 1675, 63 O.S. §§ 683.24C–683.24K and § 681). It replaces OMAG's "Oklahoma Municipal Camp Safety Planner" CustomGPT. Ranger:

- **finds what may be covered:** inventories a municipality's camps, campgrounds, parks and youth programs, and screens each against the statutory definitions and exemptions;
- **interviews, one question at a time,** through a site-specific hazard assessment and an emergency action plan, reusing every answer;
- **writes custom documents:** emergency action plans, hazard assessments, weather and water safety plans, staff screening and training policies, health and medication procedures, check-in and check-out procedures, parent letters, incident forms and checklists. It interviews the member about their camp (one question at a time, with answer buttons when a question has a short list of answers), researches the law, then writes each document from scratch for that camp. Members preview it, ask for changes in chat, and download a Word file. Every document is marked as a draft for review;
- **cites the law it read:** every legal point links to the actual section text.

**Status:** Built November 2026 from Pip (`omag-web/omag-hr`) and not yet deployed. See [`docs/deploy.md`](docs/deploy.md) for first-time setup.

Ranger is **a separate system from Pip**. It has its own repo, AWS stack (`ranger-camp-safety`), database, storage, admin users, deploy role, alarms and address. The code started as a copy of Pip's, so the two work the same way, but nothing is shared at runtime.

**Name:** "Ranger" is set in one place in each front end (`const BOT = 'Ranger'`) and in `backend/src/prompt.mjs`. Its icon is a gold tent in a chat bubble, in OMAG navy and gold. Always show it with "OMAG's camp safety assistant" and an **AI** label.

## What's in the repo

| Path | What it is |
|---|---|
| [`web/`](web/) | **The member page.** Full-page chat with a **Program type** picker (youth camp or outdoor program, camp facility, recreational campground, not sure). Set the API address in `web/config.js`. |
| [`web/admin/`](web/admin/) | **The admin panel** (sign-in required): analytics, instructions, sample documents, OMAG documents and web pages, conversations, "Talk to OMAG" messages, settings, statute library, answer checks, admins. |
| [`backend/`](backend/) | **The API.** AWS Lambda + OpenAI GPT-5.6 on Amazon Bedrock + DynamoDB, deployed with AWS SAM (`template.yaml`). |
| [`backend/src/prompt.mjs`](backend/src/prompt.mjs) | Ranger's instructions: a locked core (citations, never fabricate findings or approvals, drafts aren't compliance, child privacy, stay on topic) plus OMAG's editable guidance, which carries the GPT's five workflows (discovery, applicability, hazard assessment, EAP, oversight). |
| [`knowledge/sources.json`](knowledge/sources.json) | What the statute library contains: Title 63 (camp safety law, § 681, Emergency Management Act), Title 51 (Tort Claims Act), Title 82 (Floodplain Management Act), and the enrolled HB 1675 as a fallback until Title 63 is republished. |
| [`docs/`](docs/) | [`deploy.md`](docs/deploy.md) (setup and day-to-day), [`scope.md`](docs/scope.md) (plan and decisions), [`gpt-instructions.md`](docs/gpt-instructions.md) (the CustomGPT's original instructions). |

## How it works

1. A member picks a program type and asks a question. The page sends the conversation and program type to `POST /chat`.
2. The Lambda gives the model Ranger's system prompt, starting-point sections for that program type, and tools: `search_law`, `get_sections`, `write_document`, `ask_choice`, and `get_sample` when OMAG has sample documents switched on.
3. Ranger asks one question at a time. When a question has a short list of likely answers (day or overnight, which hazards apply, a select-all checklist), it calls `ask_choice` (`backend/src/choices.mjs`) and the member page shows a pop-up with answer buttons above the message box: pick one, pick several and press Send, type something else, or close it and type. The pick is sent as the member's next message. Every conversation starts with the legal and privacy notice (the **Disclaimer** from **Settings**, plus the privacy line).
4. Ranger researches, then answers, citing sections as `[[63-683.24E]]`. Only citations to sections it actually read are kept and shown as clickable chips.
5. When a member asks for a document, Ranger interviews them about their camp until it has what it needs, researches the law, and writes the document from scratch with `write_document` (`backend/src/drafts.mjs`). The draft comes back with the answer as structured blocks. The member page shows a card with **Preview** (rendered in the browser, [brackets] highlighted) and **Download Word** (built on the server by `POST /documents/docx` with the `docx` package). To revise, the member just asks: the newest draft rides along with their next message and reaches the model in `<current_draft>` tags.
6. OMAG documents and web pages added in the admin panel (OEM's camp safety page and checklist, for example) are searched alongside the statutes and cited as guidance.
7. Each question is logged (with citations, tokens and rating) for analytics and review. There are no accounts: conversation history lives in the member's browser.

## Documents

- **Writing:** `write_document` takes the whole document as blocks (heading, paragraph, bullets, numbered, signature) with `**bold**` and `[[63-683.24E]]` citations. Citations become formal cites ("63 O.S. § 683.24E") only for sections Ranger read with `get_sections` in that conversation; the rest are dropped. Open choices stay in [brackets]. Ranger never invents names, phone numbers, addresses, dates or amounts.
- **Time:** writing a long document can take a few minutes. The member sees "Writing your document. Longer documents take a few minutes"; the stream sends a ping every 15 seconds. Limits: 16,000 output tokens per model call, 8 tool rounds, 4 minutes of research, a 10-minute Lambda timeout (the slow-answer alarm fires at 8 minutes). A document written in the last round is still kept.
- **Logs** keep a document's title, never its text. Word downloads count as documents on the Analytics page.
- **Sample documents:** the admin panel's **Sample documents** page holds plain Word files OMAG trusts (a good water safety plan, say). Each has a title and a short "what it covers" line. When a member asks for that kind of document, Ranger reads the sample with `get_sample` to see what a good one covers and how it's organized, then writes a fresh document for the member's camp. It never copies a sample's wording, names or numbers, and nothing needs to be marked up in the file. Only samples that are switched on are used (`backend/src/samples.mjs`).

## The program type

Pip's "form of government" picker became the **program type**, because it decides which sections and deadlines apply and which document version a member gets. In the code and API the field is still called `form`. The keys are `camp`, `facility`, `campground` and `unsure` (see `FORMS` in `backend/src/prompt.mjs`). A sample document can have one Word file for every type (`all`) or a separate file per type, so recreational campgrounds can get their own version.

## Run it locally

```bash
cd backend
npm install
npm test                 # 78 tests, no AWS needed (uses a small test library in test/fixtures/)
LIBRARY_PATH=test/fixtures/library.json npm run dev:mock
                         # http://localhost:8787 with a scripted stand-in model
                         # admin panel at http://localhost:8787/admin/ (no sign-in locally)
```

The test library's text is marked as a fixture and is never deployed. The real library (`backend/data/library.json`) is built from the official sources by the *Build statute library* workflow, or by the first deploy.
