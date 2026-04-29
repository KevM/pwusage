-- Drop unused tables that exist in production but are not used in the application

DROP TABLE IF EXISTS "AppSettings";
DROP TABLE IF EXISTS "EnergyUsage";
DROP TABLE IF EXISTS "HeavyApiRateLimit";
