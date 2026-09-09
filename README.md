# 42 Students Tracker Logic

This repository contains the core logic used to track student transfers across the 42 Network campuses. It serves as a public example of the backend sync process, while the main project repository remains private.

## How It Works

Here is a simple explanation of how the script runs:

1. **API Access**: By using the 42 API, we get access to the global student database.
2. **Batch Fetching**: We fetch the Moroccan students 100 students at a time. Doing this in chunks with a slight delay prevents us from spamming the API and getting rate-limited.
3. **Data Collection**: We keep fetching until we have gathered all 3000+ students from the local campuses.
4. **Transfer Detection**: After getting all the Moroccan students, we check their `campus_users` history to see their primary campus and their destination. 
5. **Status Update**: If their primary campus has changed to a foreign destination, they are marked as **RELOCATED**. If they have a foreign destination in their history but it isn't primary yet, they are marked as **IN PROCESS**.

This entire script runs automatically on a daily cron job, meaning the data stays perfectly up-to-date without any manual interaction!
