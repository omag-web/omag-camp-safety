# Scope and plan

Assistant name: **Ranger** (working name), shown as "Ranger · OMAG's camp safety assistant" with an AI label on every answer.

Ranger replaces the "Oklahoma Municipal Camp Safety Planner" CustomGPT with the same custom-built setup as Pip, OMAG's HR assistant, so members don't need a ChatGPT account and OMAG gets citations, analytics, an admin panel and Word documents. It's a separate deployment from Pip.

## Who it's for

Oklahoma city and town staff (parks and recreation, clerks, managers, risk and emergency staff) whose municipality runs or hosts youth camps, outdoor programs, camp facilities or recreational campgrounds. County emergency management is where plans are filed and who regulates compliance. It's not a user of Ranger.

## The law

HB 1675 (2026), effective November 1, 2026:
- 63 O.S. § 683.24C definitions; § 683.24D applicability and exemptions; § 683.24E site-specific hazard assessment; § 683.24F emergency action plan; § 683.24G warnings and alerts; § 683.24H shelters and sleeping facilities; § 683.24I training, drills and records; § 683.24J disclosure and acknowledgment; § 683.24K rules and enforcement.
- 63 O.S. § 681 (amended) adds emergency action plans for recreational campgrounds.

Ranger reads deadlines, review cycles and filing requirements from the sections each time rather than from its instructions. Rules from the regulating authority may add requirements; if OMAG gets them, upload them under **OMAG documents**.

## What the CustomGPT contained

One instruction file (five workflows: discovery, applicability screening, hazard assessment, EAP, oversight; see [`gpt-instructions.md`](gpt-instructions.md)) and links to three sources: the enrolled bill, OEM's camp safety page, and OEM's checklist. It had no knowledge files and no statute text, so it relied on the model's memory and browsing for the law.

The new build:
- **Workflows** → OMAG's editable guidance in the admin panel (`DEFAULT_GUIDANCE` in `backend/src/prompt.mjs`).
- **Guardrails** (never fabricate hazard findings, ratings, approvals or drills; drafts aren't compliance; protect children's information; label drafts as pending review) → the locked part of the prompt.
- **Statute text** → the library (`knowledge/sources.json`), with the enrolled bill as a fallback until Title 63 is republished.
- **OEM guidance** → added in the admin panel as web pages and documents, cited separately from the statute.
- **Drafts written in chat** → documents Ranger writes from scratch for each camp after interviewing the member (`write_document`), previewed on the page and downloaded as Word files.

## Decisions

- **Separate system.** Own repo, stack, database, buckets, Cognito user pool, deploy role, alarms (CloudWatch namespace `Ranger`) and subdomain. The only shared item is the account's GitHub identity provider, which Ranger reuses and never modifies.
- **Model:** same as Pip, OpenAI GPT-5.6 Terra on Bedrock, with Luna as the backup. It's a setting in the admin panel.
- **Program type instead of form of government.** It drives starting sections, deadlines and document versions. The API field keeps the name `form`.
- **Library scope:** Title 63 §§ 681 and 683.x, Title 51 §§ 151–200 (municipal tort liability, which matters to a risk pool), and Title 82 §§ 1601–1619 (floodplain management, for hazard exposure zones). No federal parts yet; add 44 C.F.R. Part 60 (NFIP) on the Statute library page if members ask about flood maps.
- **Documents are drafts.** Every Word file's footer says it's a draft prepared with Ranger, to review with the municipal attorney or OMAG before use. The starter templates in `knowledge/templates/` carry "Draft pending municipal and applicable external review", a missing-information section and a statutory crosswalk whose status column the municipality fills in. Nothing is marked complete or compliant by Ranger.

## Open decisions

- [ ] Final subdomain (suggested `campsafety.omag.org`)
- [ ] Whether to keep the name "Ranger"
- [ ] OMAG Legal review of the privacy notice, disclaimer and a few documents Ranger writes
- [ ] OMAG camp safety samples for `get_sample` (switched off until then)
- [ ] Retention period for conversations (default 2 years, as Pip)
- [ ] Add implementing rules once the regulating authority adopts them
