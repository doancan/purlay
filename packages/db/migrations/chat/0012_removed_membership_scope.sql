-- chat/0012_removed_membership_scope
-- Retained module data obeys core membership removal even when this module's runtime is not loaded.
-- No core column or core-to-module foreign key; a core-only database has neither this function nor trigger.
CREATE FUNCTION chat_forget_removed_membership() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    DELETE FROM channel_members AS member
    USING channels AS channel
    WHERE member.channel_id = channel.id
      AND channel.workspace_id = OLD.workspace_id
      AND member.user_id = OLD.user_id;

    DELETE FROM channel_departures AS departure
    USING channels AS channel
    WHERE departure.channel_id = channel.id
      AND channel.workspace_id = OLD.workspace_id
      AND departure.user_id = OLD.user_id;
    RETURN OLD;
END;
$$;

CREATE TRIGGER chat_removed_membership_scope
AFTER DELETE ON workspace_members
FOR EACH ROW EXECUTE FUNCTION chat_forget_removed_membership();
