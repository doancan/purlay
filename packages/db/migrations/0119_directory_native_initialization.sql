-- Retain first native binding independently of session/binding purge. User-authorized relinking stays explicit.
CREATE TABLE workspace_directory_native_initializations (
    link_reference UUID PRIMARY KEY REFERENCES workspace_directory_identity_links(id) ON DELETE CASCADE,
    binding_reference UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION retain_directory_native_initialization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'directory native initialization is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_directory_native_initializations_immutable
    BEFORE UPDATE ON workspace_directory_native_initializations
    FOR EACH ROW EXECUTE FUNCTION retain_directory_native_initialization();
