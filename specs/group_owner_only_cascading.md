# Group Owner Only + Cascading

Date: 2026-08-03
Status: Planned, not yet implemented.

## Goal

1. Let an Admin set the existing "Owner Only" flag on a **Group** node (a `Wiki Document` with `is_group: 1`) from the sidebar tree UI, not just on regular pages.
2. Make Owner Only actually **cascade**: a Group marked Owner Only hides the group and every document nested under it — from direct read access, list/search results, the public reader nav tree, and the space-management (editor) tree — not just the group's own row.

## Problem

`owner_only` already exists on `Wiki Document` (shared by pages and groups) and is enforced by `wiki/permissions.py`, but three gaps were found:

1. **No UI for groups.** `PageSettings.vue`'s Owner Only switch is only reachable from `WikiDocumentPanel.vue`, which opens for regular pages. Clicking a group row in `WikiTree.vue` just expands/collapses it; the group's dropdown menu has no Settings entry.
2. **No cascading in enforcement.** `_document_owner_only_blocks()` in `wiki/permissions.py` only ever consults a document's own flag, never an ancestor's. A page nested under an Owner-Only group is not blocked by the group's flag.
3. **No cascading in tree building, and a leak.** `build_nested_wiki_tree()` (backs the cached public reader nav) filters an owner-only group's own DB row out of its query, but children whose `parent_wiki_document` pointed at that now-missing row become **orphaned root nodes** instead of disappearing — so they still surface in navigation and remain directly reachable by URL. Separately, `get_cr_tree()` (backs the space-management/editor tree in `WikiTree.vue`) applies **no** per-document Owner Only filtering at all — documented as an explicit prior out-of-scope decision in `specs/owner_only_and_guest_lockout.md:36`, now being closed.

## Settled semantics

- Owner Only on a Group is layered the same way space-level Owner Only already is (see `owner_only_and_guest_lockout.md`): a document is hidden from a user if its own `owner_only` is set, **or** any ancestor group's `owner_only` is set, **or** the parent space's `owner_only` is set. The user who can still see it is the union of `{that record's owner, Admin-role users, managers}`.
- Cascading blocks are evaluated per-ancestor: a user who owns an ancestor group bypasses that ancestor's block, but is still subject to any other ancestor's (or the space's) flag if they don't also own/aren't Admin for those.
- Applies uniformly across: single-document permission checks (`wiki_document_has_permission`, `check_space_access`), bulk list queries (`wiki_document_query_conditions`), search (`search.py`), the cached public reader tree (`build_nested_wiki_tree`/`get_public_wiki_tree`), and the space-management/editor tree (`get_cr_tree`).

## Enforcement points

- `wiki/permissions.py`: new `_ancestor_owner_only_blocks(doc, user)` — walks `parent_wiki_document` via cached lookups. Wired into `wiki_document_has_permission` (OR'd with the existing self-check) and `wiki_document_query_conditions` (a `lft`/`rgt` NestedSet correlated subquery, since a per-row Python walk isn't expressible in a SQL WHERE fragment).
- `wiki/frappe_wiki/doctype/wiki_document/wiki_document.py`: `check_space_access` OR-in `_ancestor_owner_only_blocks`. `build_nested_wiki_tree` stops filtering `owner_only` at the SQL level and instead does a recursive subtree-prune pass after the tree is assembled, so a hidden group's children are dropped with it rather than orphaned to root.
- `wiki/frappe_wiki/doctype/wiki_document/search.py`: `_filter_hits_by_space_visibility` gains the same ancestor check alongside its existing self-only one.
- `wiki/frappe_wiki/doctype/wiki_change_request/wiki_change_request.py`: `get_cr_tree`'s `doc_names` join query gains `owner_only`/`owner`/`parent_wiki_document`; a self/ancestor prune pass (mirroring `build_nested_wiki_tree`'s) removes blocked nodes and their subtrees before the tree is returned.

## Frontend

- New `frontend/src/components/GroupSettings.vue`: a minimal dialog (title, Owner Only switch, save) modeled on the relevant slice of `PageSettings.vue`, not a reuse of that component (its meta-title/description/image/OG-preview fields don't apply to groups).
- `WikiTree.vue`: group dropdown gains an Owner-Only-gated (`userStore.isAdmin && node.document_name`) menu entry emitting `owner-only-settings`; optionally a red "Owner Only" badge on group rows, admin-gated, mirroring the existing page badge.
- `WikiDocumentList.vue` (sole caller of `WikiTree.vue`): wires the new event to create a `Wiki Document` resource for the clicked group and open `GroupSettings.vue`. This is a direct/immediate save via `docResource.setValue.submit()`, deliberately outside the draft/change-request workflow (`useTreeDialogs.js`/`draftWorkspace.js`) that backs structural tree edits — same treatment as the existing page-level toggle, since this is a permission flag, not content.
- `treeModel.js`: `normalizeNode`/`denormalizeNode` gain `owner_only`, sourced from `get_cr_tree`'s now-extended `doc_names` query, so the frontend can render the badge.

## Out of scope

- `Wiki Space`'s own Owner Only toggle and its cascading to its documents — already implemented (see `owner_only_and_guest_lockout.md`), unchanged here.
- `CrawlerRenderer` (`.md`/`llms.txt`/`sitemap.xml`) — same carve-out as the original feature; not addressed here either.

## Regression tests

- `wiki/test_permissions.py`: a group-flavored version of `test_owner_only_space_cascades_to_its_documents` — a child document not itself owner-only is still blocked when its parent group is; plus a `wiki_document_query_conditions`/`frappe.get_list` version exercising the `lft`/`rgt` subquery path.
- A `get_cr_tree` test asserting a blocked group/child pair is absent from the returned tree for a non-owner/non-admin, present for the owner/an Admin.
- `e2e/tests/owner-only-and-guest-lockout.spec.ts`: new `Owner Only — Group` block covering the dropdown entry's visibility, direct-URL 404 for a non-owner/non-admin, and — the newly-closed gap — absence from the editor's own sidebar tree for that same user.
