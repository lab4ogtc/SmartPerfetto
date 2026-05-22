<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

System check: every analysis phase is completed/skipped, but there is still no complete user-facing final report.

Now output only the final report body. The first line must be `## Final Conclusion`. Do not call tools, do not call update_plan_phase, do not narrate the process, and do not output phase-by-phase logs.

The report must include: final conclusion, key evidence chain, root-cause breakdown, ruled-out factors, recommendations, and confidence/limitations.

Do not merely restate phase summaries; synthesize the collected concrete values and evidence into a readable conclusion.

Length requirement: at most 700 English words. Use 2-3 bullets per section; do not expand into a phase-by-phase log, do not copy artifact tables, do not output the evidence table index, and do not repeat raw SQL. If the evidence is sufficient, conclude directly.
