-- Pending relay attempts, without rewriting historical letters (D-302).
-- No row means a legacy or settled letter; NULL lease_until retains a released
-- attempt's stop link without consuming the person's next hourly slot.
CREATE TABLE missed_mail_claims (
    letter_id UUID PRIMARY KEY REFERENCES missed_mail_letters(id) ON DELETE CASCADE,
    notification_ids UUID[] NOT NULL,
    lease_until TIMESTAMPTZ,
    CONSTRAINT missed_mail_claims_size CHECK (cardinality(notification_ids) BETWEEN 1 AND 200)
);

CREATE INDEX idx_missed_mail_claims_due
    ON missed_mail_claims (lease_until, letter_id)
    WHERE lease_until IS NOT NULL;
