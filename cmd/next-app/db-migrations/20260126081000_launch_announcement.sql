-- System Announcement: New Features
-- This migration inserts a system announcement to inform users about recent updates.

INSERT INTO "SystemAnnouncement" (title, content, author_id)
VALUES (
    'January 2026 Refresh',
    'We''ve just deployed some improvements to enhance your energy monitoring experience:

*   **Site** Site navigation has been simplified. 
*   **Interactive Charts:** The site page charting is not more granular with 5 minute intervals.
*   **Load Detection and Tagging:** This experimental feature will allow you to tag your electrical loads. The load detector will automatically tag loads near cheaper tariff boundaries with the tag **Arbitrage Candidate**.
*   **About:** There is a handy [About page](/about) that explains why this app exists. 
*   **News** We added a [site news feed](/news) feed for important announcements and updates. We also have a [Discord Server](https://discord.gg/jrdvYbj4CW) you can join.

We would love to hear feedback from you about these changes, and any other suggestions you may have. You can reach us on the [Discord Server](https://discord.gg/jrdvYbj4CW)',
    NULL -- No specific author needed
);
