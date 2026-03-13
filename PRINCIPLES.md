# Project Principles

1. **Specification First** — All features MUST have a specification before implementation begins.
2. **Test First** — All features MUST have a valid passing test before being considered complete.
3. **DRY & SOLID** — Implementation MUST follow DRY (Don't Repeat Yourself) and SOLID principles.
4. **Structure Compliance** — Code MUST be organized according to the project STRUCTURE.md guide.
5. **Platform Best Practices** — All code contributions MUST follow Safari Extension best practices (event listener lifecycle, cancellable promises, BFCache handling, MV2 non-persistent risks) as documented in CLAUDE.md, and MUST comply with STRUCTURE.md file layout and naming conventions.
6. **Deviation Requires Approval** — ANY deviations from these rules MUST be validated by the user.
7. **Iterative Commits** — Work MUST be done in small iterative batches and commit work as we go.
8. **PR Merge Gate** — A full manual regression (all sections of `docs/regression-tests.md`) MUST be completed and every checklist item confirmed before a PR is merged. No checklist item may be left unchecked at merge time.
