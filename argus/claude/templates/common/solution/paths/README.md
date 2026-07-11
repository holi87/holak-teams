# solution/paths

Path analysts write one immutable mapping artifact per journey, operation group, or
data-flow slice here. Each artifact records the route, role, preconditions, stable
markers, oracle citations, covered surface IDs, and privacy-safe evidence so the lane
hunter and automation engineer can retrace what was exercised.

These files are coverage inputs, not proof of a confirmed defect. Incidental
divergences become leads in `../findings/`; generated path artifacts remain separate
from canonical reports and ledgers.
