-- Migration: 0006_extend_error_message
-- Description: Extend error_message to store detailed validation errors (up to 2000 chars)

-- SQLite doesn't have a TEXT size limit, so this is just for documentation
-- The actual storage is already TEXT which can hold up to 1 billion characters
-- But we'll add a validation_errors column for structured error data

ALTER TABLE text_chunks ADD COLUMN validation_errors TEXT;

-- Add note: error_message and validation_errors can now store detailed information
-- error_message: human-readable error description
-- validation_errors: JSON string with structured validation details
