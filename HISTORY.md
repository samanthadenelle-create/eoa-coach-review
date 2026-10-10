# Changesets

Measured from the game repository and from this snapshot.

## Game repository

| | |
|---|---|
| Changesets | 5829 |
| First | `d0863ac11d20c2976b934dbb9b3fb649515be13c` · 2026-05-18 · Initial spec + reference docs from React project |
| Tip used for these files | `5afe186a310cfc3f79f8919dc8b06c57a7478ef7` · 2026-10-06 · WO-2232: Prospectors' Hall entrance (demo screen 1/5) |

The other changesets are art, scenes, work orders, and gameplay code that this review tree leaves out so the coach can read the payment and combat paths.

## This snapshot

252 changesets, replayed with the original author, author date, and message. One source changeset produced an empty tree here and was not replayed.

| Month | Changesets in this snapshot |
|---|---|
| 2026-05 | 14 |
| 2026-06 | 20 |
| 2026-07 | 18 |
| 2026-08 | 47 |
| 2026-09 | 148 |
| 2026-10 | 5 |

Authors on these 252 commits:

| Author | Changesets |
|---|---|
| Samantha DeNelle | 226 |
| samanthadenelle-create | 26 |

First snapshot changeset: `2026-05-18` · chore: scaffold Unity 6 LTS project.
Last snapshot changeset: `2026-10-06` · WO-2232.

Confirm with:

```
git rev-list --count HEAD
git shortlog -sn HEAD
git log --format='%h %aI %s'
```
