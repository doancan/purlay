-- D-306: capture source changes from every writer, including a previous node during a rolling upgrade.
-- The source is already locked by its INSERT/UPDATE before the derived child is touched.
CREATE FUNCTION enqueue_message_shared_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO message_shared_jobs (message_id, workspace_id, channel_id)
        VALUES (NEW.id, NEW.workspace_id, NEW.channel_id)
        ON CONFLICT (message_id) DO NOTHING;
    RETURN NEW;
END;
$$;
CREATE TRIGGER messages_shared_links_changed
    AFTER INSERT OR UPDATE OF content, metadata, deleted_at, message_type ON messages
    FOR EACH ROW EXECUTE FUNCTION enqueue_message_shared_links();
