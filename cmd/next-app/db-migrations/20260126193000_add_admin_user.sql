-- Grant admin role to the primary user
-- We use a safe update that appends the role if not present

UPDATE "User"
SET roles = CASE 
    WHEN roles @> ARRAY['admin'] THEN roles
    ELSE array_append(COALESCE(roles, ARRAY[]::text[]), 'admin')
END
WHERE id = '656038e1-a229-44ed-96c4-4737f1799e94';
