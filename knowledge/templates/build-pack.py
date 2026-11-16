#!/usr/bin/env python3
"""
Builds Ranger's starter document templates as one template pack:
  knowledge/templates/ranger-camp-safety-templates.zip

Import it in the admin panel: Document templates -> Import pack. After that, OMAG edits the
templates there (questions, wording, Word files). Re-run this script only to start over.

  pip install python-docx
  python3 knowledge/templates/build-pack.py

Inside the Word files, {{field}} is an answer, {{#field}}...{{/field}} shows only when a yes/no
answer is yes, and {{program_type}} {{today}} {{year}} are filled automatically.
Every document is marked as a draft: Ranger never produces an approved or "compliant" plan.
"""
import io
import json
import zipfile
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Inches

NAVY = RGBColor(0x16, 0x32, 0x4F)
GOLD = RGBColor(0x9A, 0x74, 0x10)
GREY = RGBColor(0x55, 0x5F, 0x6B)
DRAFT = 'DRAFT pending municipal and applicable external review'
OUT = Path(__file__).with_name('ranger-camp-safety-templates.zip')


# ---------- Word helpers ----------
def new_doc(title, subtitle, cite):
    d = Document()
    sec = d.sections[0]
    sec.left_margin = sec.right_margin = Inches(1)
    sec.top_margin = sec.bottom_margin = Inches(0.9)
    st = d.styles['Normal']
    st.font.name = 'Calibri'
    st.font.size = Pt(11)
    st.paragraph_format.space_after = Pt(6)
    for lvl, size in ((1, 14), (2, 12)):
        h = d.styles[f'Heading {lvl}']
        h.font.name = 'Calibri'
        h.font.size = Pt(size)
        h.font.bold = True
        h.font.color.rgb = NAVY
        h.paragraph_format.space_before = Pt(14 if lvl == 1 else 10)
        h.paragraph_format.space_after = Pt(4)

    hp = sec.header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r = hp.add_run(DRAFT.upper())
    r.font.size = Pt(8)
    r.font.bold = True
    r.font.color.rgb = GOLD
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = fp.add_run(f'{title} · {{{{municipality_name}}}} · {{{{site_name}}}} · Prepared with Ranger, OMAG’s camp safety assistant (AI), {{{{today}}}}')
    r.font.size = Pt(8)
    r.font.color.rgb = GREY

    p = d.add_paragraph()
    r = p.add_run(title)
    r.font.size = Pt(20)
    r.font.bold = True
    r.font.color.rgb = NAVY
    p.paragraph_format.space_after = Pt(2)
    p = d.add_paragraph()
    r = p.add_run(subtitle)
    r.font.size = Pt(12)
    r.font.color.rgb = GREY
    p = d.add_paragraph()
    r = p.add_run(cite)
    r.font.size = Pt(9.5)
    r.italic = True
    r.font.color.rgb = GREY
    box(d, f'{DRAFT}. This draft was prepared from information the municipality provided. '
           'It is not a legal opinion, an engineering or shelter certification, or a determination of compliance. '
           'Verify every item, walk the site, and have it reviewed by the municipal attorney, local emergency responders and county emergency management before relying on it.')
    return d


def box(d, text):
    t = d.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    c = t.rows[0].cells[0]
    shade(c, 'FFF6DD')
    c.paragraphs[0].add_run(text).font.size = Pt(9.5)
    d.add_paragraph()


def shade(cell, hexfill):
    tcPr = cell._tc.get_or_add_tcPr()
    s = OxmlElement('w:shd')
    s.set(qn('w:val'), 'clear')
    s.set(qn('w:color'), 'auto')
    s.set(qn('w:fill'), hexfill)
    tcPr.append(s)


def h1(d, t):
    d.add_heading(t, level=1)


def h2(d, t):
    d.add_heading(t, level=2)


def para(d, t, italic=False, size=None):
    p = d.add_paragraph()
    r = p.add_run(t)
    r.italic = italic
    if size:
        r.font.size = Pt(size)
    return p


def label(d, lab, val):
    p = d.add_paragraph()
    r = p.add_run(f'{lab}: ')
    r.bold = True
    p.add_run(val)
    p.paragraph_format.space_after = Pt(3)


def block(d, lab, val, hint=None):
    p = d.add_paragraph()
    r = p.add_run(lab)
    r.bold = True
    if hint:
        r2 = p.add_run(f'  ({hint})')
        r2.italic = True
        r2.font.size = Pt(9)
        r2.font.color.rgb = GREY
    p.paragraph_format.space_after = Pt(1)
    d.add_paragraph(val)


def table(d, headers, rows, widths=None):
    t = d.add_table(rows=1, cols=len(headers))
    t.style = 'Table Grid'
    for i, h in enumerate(headers):
        c = t.rows[0].cells[i]
        shade(c, 'E7EDF3')
        run = c.paragraphs[0].add_run(h)
        run.bold = True
        run.font.size = Pt(9.5)
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].paragraphs[0].add_run(v).font.size = Pt(9.5)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Inches(w)
    d.add_paragraph()


def blank_rows(n, cols):
    return [[''] * cols for _ in range(n)]


def save(d):
    b = io.BytesIO()
    d.save(b)
    return b.getvalue()


# ---------- question helpers (manifest fields) ----------
def F(key, lab, type='text', group='', help='', required=False, prefill='', default=None, options=None):
    f = {'key': key, 'label': lab, 'type': type, 'help': help, 'required': required, 'group': group, 'prefill': prefill}
    if default is not None:
        f['default'] = default
    if options:
        f['options'] = options
    return f


# ======================================================================
# 1. Site-specific hazard assessment
# ======================================================================
def hazard_assessment():
    d = new_doc('Site-Specific Hazard Assessment', '{{site_name}} · {{municipality_name}}',
                'Prepared for the site-specific hazard assessment requirement of 63 O.S. § 683.24E (HB 1675). Program type: {{program_type}}.')
    h1(d, '1. Site profile')
    label(d, 'Municipality', '{{municipality_name}}')
    label(d, 'Facility or program', '{{site_name}}')
    label(d, 'Location', '{{site_address}}')
    label(d, 'Responsible department', '{{responsible_department}}')
    label(d, 'Operating periods', '{{operating_period}}')
    label(d, 'Maximum participants / staff on site', '{{max_participants}} participants / {{max_staff}} staff')
    block(d, 'Who operates programs here', '{{operators}}', 'municipal staff, outside groups, leases or use agreements')
    block(d, 'Boundaries, layout and accessibility', '{{site_layout}}')

    h1(d, '2. Severe weather hazards')
    para(d, 'Hazards considered for this site, whether each applies, and the evidence for it.', italic=True, size=9.5)
    block(d, 'Hazards and applicability', '{{hazards}}', 'tornado, high/straight-line wind, thunderstorm and lightning, hail, flash/river flooding, extreme heat, winter storm/cold, wildfire/smoke, other')
    block(d, 'Evidence and sources', '{{hazard_evidence}}', 'flood maps, local emergency management, past events, staff observations')
    block(d, 'Hazard exposure zones near the site', '{{exposure_zones}}')

    h1(d, '3. Buildings, structures and shelter')
    block(d, 'Buildings and structures and their vulnerabilities', '{{structures}}')
    block(d, 'Shelter-in-place locations', '{{shelter_locations}}', 'location, capacity, accessibility, and any verified rating or documentation')
    para(d, 'Do not describe a building as storm-rated or a shelter as certified without documentation. Mark anything not yet verified as “needs verification”.', italic=True, size=9)

    h1(d, '4. Evacuation')
    block(d, 'Primary evacuation route and destination', '{{evacuation_primary}}')
    block(d, 'Alternate route and destination', '{{evacuation_alternate}}')
    block(d, 'Transportation and accessibility', '{{transportation}}')

    h1(d, '5. Findings and actions')
    block(d, 'Risk reduction actions', '{{actions}}', 'action, owner (position), target date')
    para(d, '{{#has_risk_scores}}')
    h2(d, 'Supplemental planning priorities (optional)')
    para(d, 'Likelihood × consequence scores (1–5 each). These are a planning aid only; they are not a statutory scoring requirement.', italic=True, size=9)
    d.add_paragraph('{{risk_scores}}')
    para(d, '{{/has_risk_scores}}')

    h1(d, '6. Missing information and verification needed')
    d.add_paragraph('{{missing_information}}')

    h1(d, '7. Statutory crosswalk')
    para(d, 'Mark each item Documented, Needs verification, Missing, or Not applicable, with a short reason. Confirm against the current statute and any rules adopted by the regulating authority.', italic=True, size=9)
    table(d, ['Element (63 O.S. § 683.24E)', 'Where addressed', 'Status', 'Notes'], [
        ['Applicable severe weather hazards identified', 'Section 2', '', ''],
        ['Proximity to hazard exposure zones', 'Section 2', '', ''],
        ['Structural vulnerabilities of buildings and shelters', 'Section 3', '', ''],
        ['Evacuation routes and shelter-in-place locations', 'Sections 3–4', '', ''],
        ['Copy filed with the regulating authority', 'Section 9', '', ''],
        ['Review schedule (at least every 3 years and after material changes)', 'Section 9', '', ''],
        ['Hosted programs use this facility’s assessment (if a camp facility)', 'Section 1', '', ''],
    ], widths=[2.6, 1.1, 1.1, 1.7])

    h1(d, '8. Attachments')
    for a in ['Site map with buildings, shelters, hazard exposure zones and routes', 'Flood map or floodplain excerpt (with source and date)',
              'Shelter documentation (construction, ratings, capacity)', 'Photos from the site walkthrough', 'Agreements with outside operators']:
        d.add_paragraph(f'☐ {a}')

    h1(d, '9. Review and filing')
    label(d, 'Prepared by (position)', '{{prepared_by}}')
    label(d, 'Assessment date', '{{assessment_date}}')
    label(d, 'Next review due', '{{next_review_date}}')
    label(d, 'Filed with', '{{filed_with}}')
    label(d, 'Date filed', '{{filed_date}}')
    h2(d, 'Revision history')
    table(d, ['Date', 'Change', 'By (position)'], blank_rows(4, 3), widths=[1.2, 3.8, 1.5])

    G1, G2, G3, G4, G5, G6 = 'Site', 'Hazards', 'Buildings and shelter', 'Evacuation', 'Findings', 'Review and filing'
    fields = [
        F('municipality_name', 'Municipality', group=G1, required=True, prefill='municipality'),
        F('site_name', 'Facility or program name', group=G1, required=True),
        F('site_address', 'Location or address', group=G1),
        F('responsible_department', 'Responsible department', group=G1),
        F('operating_period', 'Operating periods', group=G1, help='e.g. June–July, weekdays 8–5; or year-round with overnight cabins'),
        F('max_participants', 'Maximum participants on site', 'number', group=G1),
        F('max_staff', 'Maximum staff on site', 'number', group=G1),
        F('operators', 'Who operates programs here', 'textarea', group=G1),
        F('site_layout', 'Boundaries, layout and accessibility', 'textarea', group=G1),
        F('hazards', 'Hazards and whether each applies', 'textarea', group=G2),
        F('hazard_evidence', 'Evidence and sources', 'textarea', group=G2),
        F('exposure_zones', 'Hazard exposure zones near the site', 'textarea', group=G2),
        F('structures', 'Buildings and structures and their vulnerabilities', 'textarea', group=G3),
        F('shelter_locations', 'Shelter-in-place locations', 'textarea', group=G3),
        F('evacuation_primary', 'Primary evacuation route and destination', 'textarea', group=G4),
        F('evacuation_alternate', 'Alternate route and destination', 'textarea', group=G4),
        F('transportation', 'Transportation and accessibility', 'textarea', group=G4),
        F('actions', 'Risk reduction actions, owners and dates', 'textarea', group=G5),
        F('has_risk_scores', 'Include optional likelihood × consequence scores?', 'yesno', group=G5),
        F('risk_scores', 'Risk scores and reasons', 'textarea', group=G5, help='Only where both likelihood and consequence are supported'),
        F('missing_information', 'Missing information and verification needed', 'textarea', group=G5),
        F('prepared_by', 'Prepared by (position)', group=G6),
        F('assessment_date', 'Assessment date', 'date', group=G6, prefill='today'),
        F('next_review_date', 'Next review due', 'date', group=G6),
        F('filed_with', 'Filed with', group=G6, help='e.g. the county emergency management director'),
        F('filed_date', 'Date filed', 'date', group=G6),
    ]
    return {
        'id': 'hazard-assessment', 'title': 'Site-Specific Hazard Assessment', 'order': 1, 'enabled': True,
        'description': 'A draft site-specific hazard assessment for one facility or program: hazards and evidence, exposure zones, buildings and shelters, evacuation routes, actions, missing information and a statutory crosswalk.',
        'notes': ['This is a draft pending municipal and external review. Walk the site and verify every shelter, route and capacity before relying on it.',
                  'File a copy with county emergency management and review it on the required schedule.'],
        'fields': fields, 'variants': {'all': ('hazard-assessment.docx', save(d))},
    }


# ======================================================================
# 2. Emergency action plan (youth camp / outdoor program / camp facility)
# ======================================================================

def eap_youth():
    d = new_doc('Emergency Action Plan', '{{site_name}} · {{municipality_name}}',
                'Prepared for the emergency action plan, warning and alert, shelter, training and disclosure provisions of 63 O.S. §§ 683.24F–683.24J (HB 1675). Program type: {{program_type}}.')
    h1(d, '1. Plan scope')
    label(d, 'Municipality', '{{municipality_name}}')
    label(d, 'Facility or program', '{{site_name}}')
    label(d, 'Location', '{{site_address}}')
    label(d, 'Responsible department', '{{responsible_department}}')
    block(d, 'Programs and groups this plan covers', '{{plan_scope}}', 'including outside groups hosted here, who use this plan')
    para(d, 'This plan is consistent with the site-specific hazard assessment for {{site_name}} dated {{assessment_date}}.', size=10)

    h1(d, '2. Authority and chain of command')
    label(d, 'Position with authority to activate this plan and order shelter or evacuation', '{{activation_authority}}')
    block(d, 'Backups and chain of command', '{{chain_of_command}}')
    block(d, 'Coordination', '{{coordination}}', 'police, fire, public works, county emergency management, 911, outside operators')

    h1(d, '3. Monitoring and warning')
    label(d, 'Who monitors the weather, and when', '{{monitoring}}')
    label(d, 'Warning method 1', '{{warning_method_1}}')
    label(d, 'Warning method 2 (independent; at least one method must not depend on cellular service)', '{{warning_method_2}}')
    block(d, 'How warnings are confirmed', '{{warning_confirmation}}')
    block(d, 'How staff and participants are alerted on site', '{{internal_alert}}')
    block(d, 'Backup power and communications', '{{backup_comms}}')

    h1(d, '4. Hazard-specific response protocols')
    para(d, 'One protocol for each hazard identified in the assessment: the trigger (official warning or observed condition), who decides, shelter-in-place or evacuate, primary and backup locations, and who gives the all-clear.', italic=True, size=9.5)
    d.add_paragraph('{{hazard_protocols}}')
    table(d, ['Hazard', 'Trigger', 'Decision-maker', 'Action', 'Primary / backup location', 'All-clear by'], blank_rows(6, 6))

    h1(d, '5. Shelter and evacuation')
    block(d, 'Primary shelter (location, capacity, accessibility)', '{{shelter_primary}}')
    block(d, 'Backup shelter', '{{shelter_backup}}')
    block(d, 'Evacuation routes (primary and secondary) and destinations', '{{evacuation_routes}}')
    block(d, 'Transportation and traffic control', '{{transportation}}')
    block(d, 'Headcount points', '{{headcount_points}}')
    block(d, 'Night-time procedures', '{{night_procedures}}')
    block(d, 'If routes are blocked by water or debris', '{{blocked_routes}}')

    h1(d, '6. People and accountability')
    block(d, 'Staff assignments (by position)', '{{staff_assignments}}')
    block(d, 'Roster and headcount procedure', '{{accountability}}', 'describe the procedure; keep rosters separately')
    block(d, 'Missing-person response', '{{missing_person}}')
    block(d, 'People with mobility, medical or communication needs', '{{access_needs}}')
    block(d, 'Reunification with parents or guardians', '{{reunification}}')

    h1(d, '7. Communication and continuity')
    block(d, 'Call tree', '{{call_tree}}')
    block(d, 'Notifying parents or guardians', '{{guardian_notification}}')
    block(d, 'Backup communication channels', '{{backup_channels}}')
    block(d, 'Emergency supplies', '{{supplies}}')
    block(d, 'Power or water outage', '{{outage_plan}}')
    block(d, 'Recording decisions and an incident timeline', '{{documentation}}')

    h1(d, '8. Training, drills and disclosures')
    block(d, 'Staff training (annual, and for new staff)', '{{training}}')
    block(d, 'Drills', '{{drills}}')
    label(d, 'Where training and drill records are kept', '{{records_location}}')
    block(d, 'Written hazard disclosure and acknowledgment before participation', '{{disclosure_process}}')
    para(d, 'Do not mark training, drills or disclosures as complete until there is a record.', italic=True, size=9)

    h1(d, '9. Missing information and verification needed')
    d.add_paragraph('{{missing_information}}')

    h1(d, '10. Statutory crosswalk')
    para(d, 'Mark each item Documented, Needs verification, Missing, or Not applicable, with a short reason. Confirm against the current statute and any rules adopted by the regulating authority.', italic=True, size=9)
    table(d, ['Element', 'Where addressed', 'Status', 'Notes'], [
        ['Hazard monitoring and detection (§ 683.24F)', 'Section 3', '', ''],
        ['Decision-making authority and chain of command (§ 683.24F)', 'Section 2', '', ''],
        ['Evacuate vs. shelter-in-place criteria (§ 683.24F)', 'Section 4', '', ''],
        ['Primary and secondary evacuation routes (§ 683.24F)', 'Section 5', '', ''],
        ['Shelter standards (§§ 683.24F, 683.24H)', 'Section 5', '', ''],
        ['Accountability for participants and staff (§ 683.24F)', 'Section 6', '', ''],
        ['Post-event communication and reunification (§ 683.24F)', 'Sections 6–7', '', ''],
        ['Separate protocol for each applicable hazard (§ 683.24F)', 'Section 4', '', ''],
        ['Two independent alert methods, one not cellular (§ 683.24G)', 'Section 3', '', ''],
        ['Internal alert system and guardian notification (§ 683.24G)', 'Sections 3, 7', '', ''],
        ['Annual staff training, drills, records (§ 683.24I)', 'Section 8', '', ''],
        ['Written disclosure and acknowledgment (§ 683.24J)', 'Section 8', '', ''],
        ['Filed with the regulating authority; review schedule', 'Section 12', '', ''],
    ], widths=[2.8, 1.1, 1.1, 1.5])

    h1(d, '11. Attachments')
    for a in ['Site map with shelters, routes and headcount points', 'Hazard assessment', 'Emergency contact list (positions and phone numbers)',
              'Training and drill records', 'Disclosure and acknowledgment form']:
        d.add_paragraph(f'☐ {a}')

    h1(d, '12. Approval, filing and review')
    label(d, 'Plan owner (position)', '{{plan_owner}}')
    block(d, 'Internal approval path', '{{approval_path}}')
    label(d, 'Plan date', '{{plan_date}}')
    label(d, 'Next review due', '{{next_review_date}}')
    label(d, 'Filed with', '{{filed_with}}')
    label(d, 'Date filed', '{{filed_date}}')
    h2(d, 'Revision history')
    table(d, ['Date', 'Change', 'By (position)'], blank_rows(4, 3), widths=[1.2, 3.8, 1.5])
    return save(d)


def eap_campground():
    d = new_doc('Emergency Action Plan', '{{site_name}} · {{municipality_name}}',
                'Prepared for the recreational campground emergency action plan provisions of 63 O.S. § 681 as amended by HB 1675. Program type: {{program_type}}.')
    box(d, 'If this campground also hosts youth camps or outdoor programs, the youth camp provisions (63 O.S. §§ 683.24C–683.24K) may also apply. Ask Ranger or OMAG.')
    h1(d, '1. Campground')
    label(d, 'Municipality', '{{municipality_name}}')
    label(d, 'Campground', '{{site_name}}')
    label(d, 'Location', '{{site_address}}')
    label(d, 'Responsible department', '{{responsible_department}}')
    label(d, 'Operating season', '{{operating_period}}')
    label(d, 'Campsites, cabins and RV spaces', '{{campsite_count}}')

    h1(d, '2. Location-specific hazards')
    block(d, 'Natural hazards for this location', '{{hazards}}', 'flooding, tornado, high wind, lightning, wildfire/smoke, extreme heat or cold, other')
    block(d, 'Evidence and sources', '{{hazard_evidence}}')

    h1(d, '3. Authority and coordination')
    label(d, 'Position with authority to order shelter or evacuation', '{{activation_authority}}')
    block(d, 'Backups and chain of command', '{{chain_of_command}}')
    block(d, 'Coordination', '{{coordination}}', 'police, fire, public works, county emergency management, 911, concessionaires')

    h1(d, '4. Alerting campers')
    block(d, 'How the campground receives warnings', '{{warning_methods}}')
    block(d, 'How campers are alerted', '{{camper_alerts}}', 'sirens, PA, patrols, text sign-up, signage; including at night')
    block(d, 'How campers learn the plan on arrival', '{{camper_orientation}}')

    h1(d, '5. Hazard response')
    d.add_paragraph('{{hazard_protocols}}')
    table(d, ['Hazard', 'Trigger', 'Action', 'Location / route', 'All-clear by'], blank_rows(5, 5))

    h1(d, '6. Evacuation and shelter')
    block(d, 'Evacuation routes and procedures', '{{evacuation_routes}}')
    block(d, 'If routes are blocked by water or debris', '{{blocked_routes}}')
    block(d, 'Shelter options', '{{shelter_options}}')
    block(d, 'Campers with mobility, medical or communication needs', '{{access_needs}}')
    block(d, 'Staff assignments (by position)', '{{staff_assignments}}')

    h1(d, '7. Missing information and verification needed')
    d.add_paragraph('{{missing_information}}')

    h1(d, '8. Statutory crosswalk')
    para(d, 'Mark each item Documented, Needs verification, Missing, or Not applicable. Confirm against the current statute and county requirements.', italic=True, size=9)
    table(d, ['Element (63 O.S. § 681)', 'Where addressed', 'Status', 'Notes'], [
        ['Written plan for natural disasters and severe weather', 'Whole plan', '', ''],
        ['Location-specific hazards identified', 'Section 2', '', ''],
        ['Evacuation routes and procedures', 'Section 6', '', ''],
        ['Methods for alerting campers', 'Section 4', '', ''],
        ['Annual review; filed with local emergency management; updated after significant changes', 'Section 9', '', ''],
    ], widths=[2.8, 1.1, 1.1, 1.5])

    h1(d, '9. Approval, filing and review')
    label(d, 'Plan owner (position)', '{{plan_owner}}')
    block(d, 'Internal approval path', '{{approval_path}}')
    label(d, 'Plan date', '{{plan_date}}')
    label(d, 'Next annual review due', '{{next_review_date}}')
    label(d, 'Filed with', '{{filed_with}}')
    label(d, 'Date filed', '{{filed_date}}')
    h2(d, 'Review and filing log')
    table(d, ['Year', 'Reviewed on', 'Filed on', 'Changes', 'By (position)'], blank_rows(4, 5))
    return save(d)


def emergency_action_plan():
    G = ['Scope', 'Authority', 'Monitoring and warning', 'Hazard protocols', 'Shelter and evacuation', 'People', 'Communication', 'Training and disclosures', 'Gaps', 'Approval and filing']
    fields = [
        F('municipality_name', 'Municipality', group=G[0], required=True, prefill='municipality'),
        F('site_name', 'Facility, program or campground name', group=G[0], required=True),
        F('site_address', 'Location or address', group=G[0]),
        F('responsible_department', 'Responsible department', group=G[0]),
        F('operating_period', 'Operating season', group=G[0]),
        F('campsite_count', 'Campsites, cabins and RV spaces', group=G[0]),
        F('plan_scope', 'Programs and groups this plan covers', 'textarea', group=G[0]),
        F('assessment_date', 'Date of the hazard assessment this plan follows', 'date', group=G[0]),
        F('hazards', 'Location-specific hazards', 'textarea', group=G[0]),
        F('hazard_evidence', 'Evidence and sources for the hazards', 'textarea', group=G[0]),
        F('activation_authority', 'Position that activates the plan', group=G[1]),
        F('chain_of_command', 'Backups and chain of command', 'textarea', group=G[1]),
        F('coordination', 'Coordination with responders and others', 'textarea', group=G[1]),
        F('monitoring', 'Who monitors the weather, and when', group=G[2]),
        F('warning_method_1', 'Warning method 1', group=G[2]),
        F('warning_method_2', 'Warning method 2 (independent of method 1)', group=G[2], help='At least one method must not depend on cell service'),
        F('warning_methods', 'How the campground receives warnings', 'textarea', group=G[2]),
        F('warning_confirmation', 'How warnings are confirmed', 'textarea', group=G[2]),
        F('internal_alert', 'How staff and participants are alerted on site', 'textarea', group=G[2]),
        F('camper_alerts', 'How campers are alerted', 'textarea', group=G[2]),
        F('camper_orientation', 'How campers learn the plan on arrival', 'textarea', group=G[2]),
        F('backup_comms', 'Backup power and communications', 'textarea', group=G[2]),
        F('hazard_protocols', 'Protocol for each hazard', 'textarea', group=G[3], help='For each: trigger, decision-maker, action, locations, all-clear'),
        F('shelter_primary', 'Primary shelter', 'textarea', group=G[4]),
        F('shelter_backup', 'Backup shelter', 'textarea', group=G[4]),
        F('shelter_options', 'Shelter options', 'textarea', group=G[4]),
        F('evacuation_routes', 'Evacuation routes and destinations', 'textarea', group=G[4]),
        F('transportation', 'Transportation and traffic control', 'textarea', group=G[4]),
        F('headcount_points', 'Headcount points', 'textarea', group=G[4]),
        F('night_procedures', 'Night-time procedures', 'textarea', group=G[4]),
        F('blocked_routes', 'If routes are blocked', 'textarea', group=G[4]),
        F('staff_assignments', 'Staff assignments (by position)', 'textarea', group=G[5]),
        F('accountability', 'Roster and headcount procedure', 'textarea', group=G[5]),
        F('missing_person', 'Missing-person response', 'textarea', group=G[5]),
        F('access_needs', 'People with mobility, medical or communication needs', 'textarea', group=G[5]),
        F('reunification', 'Reunification with parents or guardians', 'textarea', group=G[5]),
        F('call_tree', 'Call tree', 'textarea', group=G[6]),
        F('guardian_notification', 'Notifying parents or guardians', 'textarea', group=G[6]),
        F('backup_channels', 'Backup communication channels', 'textarea', group=G[6]),
        F('supplies', 'Emergency supplies', 'textarea', group=G[6]),
        F('outage_plan', 'Power or water outage', 'textarea', group=G[6]),
        F('documentation', 'Recording decisions and a timeline', 'textarea', group=G[6]),
        F('training', 'Staff training', 'textarea', group=G[7]),
        F('drills', 'Drills', 'textarea', group=G[7]),
        F('records_location', 'Where training and drill records are kept', group=G[7]),
        F('disclosure_process', 'Written disclosure and acknowledgment process', 'textarea', group=G[7]),
        F('missing_information', 'Missing information and verification needed', 'textarea', group=G[8]),
        F('plan_owner', 'Plan owner (position)', group=G[9]),
        F('approval_path', 'Internal approval path', 'textarea', group=G[9]),
        F('plan_date', 'Plan date', 'date', group=G[9], prefill='today'),
        F('next_review_date', 'Next review due', 'date', group=G[9]),
        F('filed_with', 'Filed with', group=G[9], help='e.g. the county emergency management director'),
        F('filed_date', 'Date filed', 'date', group=G[9]),
    ]
    return {
        'id': 'emergency-action-plan', 'title': 'Emergency Action Plan', 'order': 2, 'enabled': True,
        'description': 'A draft emergency action plan: authority, monitoring and two independent warning methods, a protocol for each hazard, shelter and evacuation, accountability and reunification, communications, training, drills and disclosures, with a statutory crosswalk. Recreational campgrounds get a campground version.',
        'notes': ['This is a draft pending municipal and external review. Have local emergency responders review it and practice it before relying on it.',
                  'Keep it consistent with the site’s hazard assessment, and file it with county emergency management.'],
        'fields': fields,
        'variants': {'all': ('emergency-action-plan.docx', eap_youth()), 'campground': ('emergency-action-plan-campground.docx', eap_campground())},
    }


# ======================================================================
# 3. Hazard disclosure and acknowledgment
# ======================================================================
def disclosure():
    d = new_doc('Severe Weather Hazard Disclosure and Acknowledgment', '{{program_name}} · {{municipality_name}}',
                'Prepared for the written disclosure and acknowledgment provision of 63 O.S. § 683.24J (HB 1675).')
    label(d, 'Program', '{{program_name}}')
    label(d, 'Dates', '{{program_dates}}')
    label(d, 'Location', '{{site_name}}')
    h1(d, 'Severe weather hazards at this site')
    d.add_paragraph('{{material_hazards}}')
    h1(d, 'What we do in an emergency')
    d.add_paragraph('{{procedures_summary}}')
    label(d, 'Where participants shelter', '{{shelter_summary}}')
    label(d, 'How we contact parents and guardians', '{{guardian_notification}}')
    label(d, 'Questions', '{{contact_position}}, {{contact_phone}}')
    h1(d, 'Acknowledgment')
    para(d, 'I received and read this disclosure of severe weather hazards and emergency procedures before participation.')
    table(d, ['Participant name', 'Parent or guardian name (if participant is under 18)', 'Signature', 'Date'], blank_rows(1, 4))
    para(d, 'Keep signed acknowledgments with program records. Don’t enter them into Ranger.', italic=True, size=9)
    G = 'Disclosure'
    fields = [
        F('municipality_name', 'Municipality', group=G, required=True, prefill='municipality'),
        F('program_name', 'Program name', group=G, required=True),
        F('program_dates', 'Program dates', group=G),
        F('site_name', 'Location', group=G),
        F('material_hazards', 'Material severe weather hazards, in plain language', 'textarea', group=G),
        F('procedures_summary', 'General emergency procedures, in plain language', 'textarea', group=G),
        F('shelter_summary', 'Where participants shelter', group=G),
        F('guardian_notification', 'How parents and guardians are contacted', group=G),
        F('contact_position', 'Contact (position)', group=G),
        F('contact_phone', 'Contact phone', group=G),
    ]
    return {
        'id': 'hazard-disclosure', 'title': 'Hazard Disclosure and Acknowledgment', 'order': 3, 'enabled': True,
        'description': 'A plain-language disclosure of a program’s severe weather hazards and emergency procedures, with an acknowledgment for participants or their parents or guardians to sign before participation.',
        'notes': ['Hand this out and collect signatures before participation. Keep signed copies with your records, not in Ranger.'],
        'fields': fields, 'variants': {'all': ('hazard-disclosure.docx', save(d))},
    }


# ======================================================================
# 4. Staff training and drill record
# ======================================================================
def training_log():
    d = new_doc('Staff Training and Drill Record', '{{site_name}} · {{municipality_name}} · {{season}}',
                'Prepared for the training, drill and records provision of 63 O.S. § 683.24I (HB 1675).')
    label(d, 'Program or facility', '{{site_name}}')
    label(d, 'Season or year', '{{season}}')
    label(d, 'Records kept by (position)', '{{records_owner}}')
    label(d, 'Records location', '{{records_location}}')
    h1(d, 'Training topics')
    d.add_paragraph('{{training_topics}}')
    h1(d, 'Training sessions')
    table(d, ['Date', 'Topic', 'Trainer (position)', 'Staff trained (count or attached sign-in)', 'Notes'], blank_rows(8, 5))
    h1(d, 'Drills')
    para(d, 'Planned drills: {{drill_plan}}')
    table(d, ['Date', 'Hazard / drill type', 'Time to shelter or evacuate', 'Headcount complete?', 'Issues and fixes'], blank_rows(8, 5))
    para(d, 'Record only training and drills that actually happened. Keep sign-in sheets with this record for inspection.', italic=True, size=9)
    G = 'Record'
    fields = [
        F('municipality_name', 'Municipality', group=G, required=True, prefill='municipality'),
        F('site_name', 'Program or facility', group=G, required=True),
        F('season', 'Season or year', group=G),
        F('records_owner', 'Records kept by (position)', group=G),
        F('records_location', 'Records location', group=G),
        F('training_topics', 'Training topics', 'textarea', group=G, help='Emergency procedures and hazard recognition for this site'),
        F('drill_plan', 'Planned drills', 'textarea', group=G),
    ]
    return {
        'id': 'training-drill-record', 'title': 'Staff Training and Drill Record', 'order': 4, 'enabled': True,
        'description': 'A record of annual staff training on emergency procedures and hazard recognition, and of drills, ready for inspection.',
        'notes': ['Fill in sessions and drills as they happen. Don’t mark anything complete without a record.'],
        'fields': fields, 'variants': {'all': ('training-drill-record.docx', save(d))},
    }


def main():
    templates = [hazard_assessment(), emergency_action_plan(), disclosure(), training_log()]
    manifest = {'format': 'ranger-templates', 'version': 1, 'exportedAt': '2026-11-16T00:00:00.000Z', 'templates': []}
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        for t in templates:
            entry = {k: v for k, v in t.items() if k != 'variants'}
            entry['variants'] = {}
            for name, (filename, data) in t['variants'].items():
                path = f"{t['id']}/{name}.docx"
                z.writestr(path, data)
                entry['variants'][name] = {'file': path, 'filename': filename}
            manifest['templates'].append(entry)
        z.writestr('manifest.json', json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB, {len(templates)} templates)')


if __name__ == '__main__':
    main()
