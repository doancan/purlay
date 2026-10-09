-- Populates a freshly migrated database with enough varied data to make a restore
-- mean something (docs/spikes/backup-restore.md). Not a fixture for tests.
--
-- It is deliberately awkward: Turkish dotted and dotless i (the collation trap, D-40),
-- emoji and combining characters, a message at the 16 000-character limit, all multibyte, JSON metadata, soft-deleted rows,
-- threads, and a message id that is a time-ordered UUID (D-8) rather than a random one.
--
--   docker compose -f docker-compose.production.yml --env-file production.env \
--     exec -T postgres psql -U purlay -d purlay -v ON_ERROR_STOP=1 < docs/spikes/backup-restore.seed.sql

BEGIN;

INSERT INTO users (email, username, display_name, github_id, created_at)
SELECT 'user' || n || '@example.test',
       'user' || n,
       CASE n % 5 WHEN 0 THEN 'İrem Yıldız ' || n WHEN 1 THEN 'Ömer Çelik ' || n
                  WHEN 2 THEN 'Zoë 🚀 ' || n       WHEN 3 THEN 'e' || chr(769) || ' combining ' || n
                  ELSE 'Plain Name ' || n END,
       1000 + n,
       now() - make_interval(days => 100 - n)
FROM generate_series(1, 60) AS n;

INSERT INTO workspaces (name, slug, created_by)
SELECT 'Workspace ' || w, 'ws-' || w, (SELECT id FROM users WHERE username = 'user' || w)
FROM generate_series(1, 3) AS w;

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT w.id, u.id, CASE WHEN u.username = 'user' || right(w.slug, 1) THEN 'owner'::user_role ELSE 'member'::user_role END
FROM workspaces w CROSS JOIN users u
WHERE (right(w.slug, 1)::int + substring(u.username from 5)::int) % 2 = 0
   OR u.username = 'user' || right(w.slug, 1);

INSERT INTO channels (workspace_id, name, topic, created_by)
SELECT w.id, c.name, 'topic of ' || c.name || ' — ığüşöç', (SELECT id FROM users WHERE username = 'user' || right(w.slug, 1))
FROM workspaces w
CROSS JOIN (VALUES ('general'), ('engineering'), ('İstanbul'), ('ıspanak'), ('random'), ('deploys'), ('incidents')) AS c(name);

INSERT INTO channel_members (channel_id, user_id)
SELECT c.id, wm.user_id FROM channels c JOIN workspace_members wm ON wm.workspace_id = c.workspace_id;

-- 20 000 root messages with ids that sort by time, as the application's do.
INSERT INTO messages (id, workspace_id, channel_id, sender_id, content, metadata, created_at)
SELECT
  (lpad(to_hex((extract(epoch FROM t) * 1000)::bigint), 12, '0')
     || '7' || substr(md5(n::text), 1, 3) || '8' || substr(md5(n::text), 4, 15))::uuid,
  c.workspace_id,
  c.id,
  (SELECT cm.user_id FROM channel_members cm WHERE cm.channel_id = c.id ORDER BY cm.id OFFSET (n % 3) LIMIT 1),
  CASE n % 7
    WHEN 0 THEN 'Günaydın ekip — İstanbul’dan selam, ıslak çiçek 🌸 #' || n
    WHEN 1 THEN E'```ts\nconst x: number = ' || n || E';\n```'
    WHEN 2 THEN 'looks good to me 👍 ' || repeat('lorem ', n % 40)
    ELSE 'message number ' || n
  END,
  jsonb_build_object('n', n, 'tags', jsonb_build_array('a', n % 3), 'nested', jsonb_build_object('even', n % 2 = 0)),
  t
FROM (
  SELECT n, now() - make_interval(secs => (20000 - n) * 37) AS t,
         (SELECT array_agg(id ORDER BY id) FROM channels) AS ids
  FROM generate_series(1, 20000) AS n
) s
JOIN LATERAL (SELECT id, workspace_id FROM channels ORDER BY id OFFSET (s.n % (SELECT count(*) FROM channels)) LIMIT 1) c ON true;

-- Threads: a reply to every 50th root, and the summary the application keeps (D-13).
WITH roots AS (
  SELECT id, workspace_id, channel_id, sender_id, created_at, row_number() OVER (ORDER BY id) AS rn
  FROM messages WHERE parent_id IS NULL
), replies AS (
  INSERT INTO messages (id, workspace_id, channel_id, sender_id, parent_id, content, created_at)
  SELECT (lpad(to_hex((extract(epoch FROM r.created_at + interval '1 minute') * 1000)::bigint), 12, '0')
            || '7' || substr(md5(r.id::text), 1, 3) || '8' || substr(md5(r.id::text), 4, 15))::uuid,
         r.workspace_id, r.channel_id, r.sender_id, r.id, 'a reply, ışık 🧵', r.created_at + interval '1 minute'
  FROM roots r WHERE r.rn % 50 = 0
  RETURNING parent_id, created_at
)
UPDATE messages m SET thread_reply_count = 1, thread_last_reply_at = replies.created_at
FROM replies WHERE m.id = replies.parent_id;

-- One message at the length limit, a soft-deleted one, and an edited one.
UPDATE messages SET content = repeat('ğ', 16000)
WHERE id = (SELECT id FROM messages WHERE parent_id IS NULL ORDER BY id LIMIT 1);
UPDATE messages SET deleted_at = now() WHERE id = (SELECT id FROM messages WHERE parent_id IS NULL ORDER BY id OFFSET 10 LIMIT 1);
UPDATE messages SET edited_at = now() WHERE id = (SELECT id FROM messages WHERE parent_id IS NULL ORDER BY id OFFSET 20 LIMIT 1);

INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at)
SELECT id, md5(id::text) || md5(username), 'rehearsal/1.0', ('10.0.0.' || (substring(username from 5)::int % 250 + 1))::inet, now() + interval '30 days'
FROM users WHERE substring(username from 5)::int <= 10;

COMMIT;
