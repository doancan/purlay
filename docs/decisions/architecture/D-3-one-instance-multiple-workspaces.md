# D-3. One instance, multiple workspaces

A single deployment hosts multiple workspaces. A user has one identity across them and
switches with a sidebar, Discord/Linear style.

**Why keep multi-tenancy in a self-hosted tool?** Because the dogfood team already has more
than one context (company / side project / community), and because it preserves the option in
D-1. The cost is one indexed `workspace_id` column and one query-builder guard — cheap when
built in, expensive to retrofit.

**Reversibility:** removing tenancy later is easy; adding it later is a full migration.
