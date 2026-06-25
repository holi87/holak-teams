# solution/paths

Explored-path / coverage-trail artifacts produced during exploratory hunting go here
(one file per hunt or per surface). Each path file records the route taken, the role,
the selectors/markers used, and the evidence captured, so a reviewer can retrace what
was actually exercised (feeds the recall/coverage story in the strategy).

This directory is part of the Argus QA deliverable contract — keep it in the repo even
when empty (hence this README). Drop generated path files alongside it during the run.
