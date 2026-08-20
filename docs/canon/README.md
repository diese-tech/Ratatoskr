# YSL Canon Knowledge Base

This directory is reserved for **approved Yggdrasil Smite League source-of-truth documents** that Ratatoskr may later retrieve from when answering league questions.

## Intended contents

- Rulebook
- League terminology and naming canon
- Roster / trade policy
- Match procedures
- Competitive rulings
- Staff-approved FAQ
- Seasonal policy documents

## RAG rules

Documents in this directory should be treated as authoritative only when explicitly approved by league staff.

Future retrieval behavior should:

1. Search only approved canon sources for league-policy answers.
2. Return the source document and section used.
3. Prefer newer explicitly-versioned policy when sources conflict.
4. Refuse to invent a ruling when canon is silent.
5. Separate league canon from proposals, implementation notes, and staff discussion.

## Suggested document metadata

Use a short frontmatter header when practical:

```yaml
---
title: YSL Rulebook
status: approved
season: 1
version: 1.0
effective_date: YYYY-MM-DD
supersedes: null
---
```

Store drafts and unapproved ideas under `docs/proposals/`, not here.
