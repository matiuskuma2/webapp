-- Add error tracking columns to projects table
-- Migration: 0003_add_error_tracking
-- Description: Add error_message and last_error columns for better error handling

ALTER TABLE projects ADD COLUMN error_message TEXT;
ALTER TABLE projects ADD COLUMN last_error DATETIME;
