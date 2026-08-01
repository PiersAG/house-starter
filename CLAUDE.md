# Session rules (non-negotiable)

Read DESIGN.md before writing any UI code.
Read docs/responsive.md before writing any UI code — components ask their
container (@sm:/@roomy:), pages ask the viewport (sm:/md:), sizes are fluid.
Tabular data goes in components/ui/data-table.tsx — read docs/data-tables.md.
Never hand-roll a <table>: it is the one thing that cannot reflow, and a wide
one pushes the whole page sideways rather than just itself.
Read BUILD-BRIEF.md before writing any feature code.
Never touch production credentials.
Never delete data without explicit human approval.
Never skip tests.
Ask before any destructive operation.
Commit after each working increment, not at end of session.
