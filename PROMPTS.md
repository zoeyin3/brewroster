# PROMPTS

How BrewRoster's app code was built with an AI tool (Claude). These are the prompts used, in the order they were sent, copied as written.

---

## Prompt 1: Problem statement and first prototype

> FINAL PROBLEM STATEMENT
>
> The problem is that owners of small independent cafes decide each week's roster from habit and memory. They can't easily see when customers actually arrive and the sales they lose when understaffed.
>
> It affects owners of small cafes with small teams who build the roster themselves. Busiest periods hit hardest during peak hours and whenever demand shifts.
>
> This gap between when customers arrive and how the week is staffed needs to close, so the right number of staff work at the right times without the owner analysing data manually.
>
> This matters because a mismatched roster wastes wages when overstaffed and loses customers when understaffed. The owner then scrambles for cover instead of growing the business.
>
> Feature Ideas
>
> Predictability →
> Linked to transaction history POS live
> Factors of events, school terms/holidays, weather
> Leave & availability management - People send leave requests and the AI bot registers that so they can create the best roster schedule which needs to business owner to approve
> Two interfaces - employee and business owner
> Staff standby system/alerts
>
> Make a fully functional, clickable proof-of-concept model for a rostering platform for small cafes. It uses transaction history from the cafe's POS system to determine busy periods so the cafe owner can roster accordingly.  There are two interfaces. Create the business owner POV, where they can see all leave requests submitted by employees. The AI bot will automatically consider the employees who are away and optimise best schedule for the owner. Make the interface clean, simple font, dark navy blue and white.

---

## Prompt 2: Mobile-first redesign

> make the ui less basic and for iphone viewing. Also make it look like an actual app

---

## Prompt 3: Late opt-out alert feature

> Add a new feature to BrewRoster: "Late opt-out alert". It flags to the owner when an employee repeatedly opts out of shifts at short notice, because each late opt-out forces the standby process and costs the café money.
>
> CONTEXT
> - Existing flow: an employee can opt out of a shift. With 48 hours to 14 days notice the shift goes to team chat. With under 48 hours notice, it goes to standby, and the owner alerts available standby staff.
> - This feature only counts the second case: opt-outs made with under 48 hours notice that trigger the standby procedure.
> - The agent follows the existing limits: it can flag and draft, but it cannot publish, change the roster, approve leave, contact staff, or reduce anyone's hours.
>
> TRIGGER RULE
> - Count, per employee per calendar month, each opt-out made less than 48 hours before the shift start that moved the shift into standby.
> - When an employee's count reaches 3 in a month, create one alert for the owner. Do not create a new alert for the 4th, 5th and so on. Instead, update the existing alert's count.
> - The threshold (default 3) and the notice window (default 48 hours) are owner-editable settings.
> - The count resets at the start of each calendar month.
>
> WHAT DOES NOT COUNT
> - Opt-outs with 48 hours or more notice.
> - Shifts covered by approved leave (14 days or more notice).
> - Shifts the owner cancelled or changed.
> - Any opt-out the owner marks as "Excused" (for example, illness). Excused events stay in the history but are removed from the count. If the count drops below the threshold, the alert closes automatically.
>
> ALERT CONTENT (owner view only)
> - Show it on the owner's briefing home screen, in the "needs your attention" list, and in the leave and cover section.
> - Neutral wording, for example: "Sam has opted out of 3 shifts with under 48 hours notice in November. Each one triggered standby."
> - Under it, list each event: date, shift, how much notice was given, and who covered it.
> - Show an estimated cost to the café for each event and in total, based on the cover shift's hours and pay rates. Label it clearly as an estimate. If pay data is missing, hide the cost and show the events only.
> - Owner actions: "Mark event as excused", "Add a note", "Dismiss alert", "Keep watching". Dismissing stores who dismissed it and when.
> - Do not give the employee a score, ranking or label such as "unreliable".
>
> PRIVACY AND RESPONSIBLE AI
> - Only the owner can see this alert. Employees never see it, and it never appears in the team chat or employee portal.
> - The alert is information only. The agent must never penalise, message, remove shifts from, or lower the hours of the flagged employee.
> - Keep an audit log of every counted event, excused event and alert action.
> - Show a short line on the alert: "This is a flag for your judgement, not a decision. Check the reason with the employee before acting."
>
> DATA
> - Use the existing opt-out records. Store notice given (hours), whether it triggered standby, the excused flag, the note, and the alert state (open, dismissed, closed).
> - Use sample data only in the demo.
>
> TESTS TO ADD TO THE AGENT TEST TABLE
> 1. Normal: 3 late opt-outs in one month for the same employee creates exactly one alert showing 3 events.
> 2. Normal: 2 late opt-outs creates no alert.
> 3. Normal: a 3rd opt-out made with 3 days notice does not count, so no alert.
> 4. Boundary: the owner marks one of three events as excused, and the alert closes.
> 5. Boundary: a 4th late opt-out updates the existing alert rather than creating a second one.
> 6. Escalation or refusal: asked to remove the flagged employee's shifts or message them, the agent refuses and says only the owner can act.
> 7. Month rollover: counts reset on the 1st.

---

## Prompt 4: Finding the screenshots

> wheres the image of the flagging thing new feature we added?

---

## Prompt 5: Less AI-looking interface

> Can you redesign the current user interface so it feels less AI-generated and more like a realistic, professionally designed café management app?
> Please keep all existing functionality, but refine the visual design and layout.
> Focus on:
>
> A simpler and more natural layout with clearer visual hierarchy
> Less excessive use of rounded cards, gradients, large empty spaces and decorative elements
> More consistent spacing, typography and button styles
> A practical dashboard that feels designed for a small café owner rather than a generic SaaS/AI product
> More compact presentation of information where appropriate
> Clear and familiar navigation
> Subtle styling rather than overly polished or futuristic visuals
> Realistic labels, tables, roster views and data displays that resemble actual workforce management software
> Avoid excessive icons, emojis, floating elements and unnecessary animations
> Add a different font
> The interface should feel functional, credible and human-designed, with the emphasis on usability rather than showing off the design.
> Please do not remove or change any existing features or functionality. Only improve the UI/UX and visual presentation. Do not rewrite the underlying logic or Supabase functionality

---

## Prompt 6: Fair standby order

> and for standby if there are more option, allocate it to the one that has worked the least that week etc.
