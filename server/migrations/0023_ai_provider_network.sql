-- Whether data sent to an AI provider leaves the installation's own network, as the
-- administrators say: `yes`, `no`, or NULL for an estimate from the provider's address
-- (`ai::service::stays_in_network`). A gateway in the own network may forward to a cloud model,
-- which only the administrators know.
ALTER TABLE ai_providers ADD COLUMN leaves_network TEXT;
