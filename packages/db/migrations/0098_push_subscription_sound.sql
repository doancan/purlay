-- A device's sound choice applies while its page is closed as well as while it is open (#1348).
ALTER TABLE push_subscriptions ADD COLUMN sound boolean NOT NULL DEFAULT true;
