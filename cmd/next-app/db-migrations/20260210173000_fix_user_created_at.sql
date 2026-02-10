-- Fix User created_at column type from BIGINT to TIMESTAMP
-- This migration converts the BIGINT (milliseconds) to proper TIMESTAMP

-- Convert BIGINT milliseconds to TIMESTAMP
ALTER TABLE "User" ALTER COLUMN created_at TYPE TIMESTAMP 
USING CASE 
    WHEN created_at IS NOT NULL THEN to_timestamp(created_at / 1000.0)
    ELSE NULL
END;

-- Set default for new rows
ALTER TABLE "User" ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
