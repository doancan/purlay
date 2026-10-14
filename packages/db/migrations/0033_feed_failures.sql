-- 0033_feed_failures
--
-- A feed past its bucket says so where it was set up (#79, D-134 §8): GitHub does not retry on its
-- own, so a delivery refused for being one too many is lost unless somebody is told. One more reason
-- the feed may show, beside the three of 0031.
--
-- A check replaced on a table of a few rows per channel: one transaction, as 0026.

ALTER TABLE github_repo_feeds DROP CONSTRAINT github_repo_feeds_failure_known;
ALTER TABLE github_repo_feeds ADD CONSTRAINT github_repo_feeds_failure_known CHECK (
    last_failure IN ('channel_archived', 'repository_mismatch', 'payload_invalid', 'rate_limited')
);
