# 42 Students Tracker Logic

This repository contains the core logic and scripts used to track student transfers across the 42 Network campuses. It serves as a public example of the backend sync process, while the main project repository remains private.

## How it Works: Step-by-Step

Here is a detailed breakdown of the data pipeline:

### 1. The Authentication Phase
Before doing anything, the server needs permission to talk to the 42 Network.
- We take your `FORTY_TWO_CLIENT_ID` and `FORTY_TWO_CLIENT_SECRET`.
- We send a `POST` request to `https://api.intra.42.fr/oauth/token` using the Client Credentials grant type.
- The API replies with a temporary Bearer Token that acts as our VIP pass for the next 2 hours.

### 2. Step One: Gathering the Moroccan Base
We need to know who the Moroccan students are before we can see if they left.
- We target the exact ID numbers for the 1337 campuses: 16 (Khouribga), 21 (Benguerir), 55 (Tétouan), and 75 (Rabat).
- We query the endpoint `/v2/campuses/{id}/users`.
- Because there are thousands of students, the API only gives us 100 at a time. The script automatically paginates (loops through page 1, page 2, page 3...) until it has securely downloaded the basic profiles of every single person who has ever touched a Moroccan campus.

### 3. Step Two: The Transfer Detection (The Core Logic)
Now that we have thousands of Moroccan student IDs, we need to find the "L7araga" (the transfers). We do this by investigating their Campus History.
- We query the `/v2/campus_users` endpoint and filter by the student IDs we just collected.
- The API returns an array of every campus a student has ever been assigned to.
- **The Check**: We look through this array. If a student's history only contains Moroccan campuses, we ignore them. But, if we detect a "foreign" campus in their history (like Paris or Seoul), the radar catches them!

### 4. Step Three: Calculating the Status
Once we know a student has a foreign campus in their history, we need to know if they are still preparing to leave, or if they are already gone.
- We sort their campus history chronologically by ID.
- If their currently active (primary) campus is still in Morocco, but they have a foreign campus attached to their profile, we mark them as **IN PROCESS**.
- If their currently active (primary) campus is now the foreign campus (e.g., they officially moved to Paris), we mark them as **COMPLETED** (Relocated).

### 5. Step Four: The Staff Blocklist
Because the 42 Network has global staff members (like `boulon` or `tguiter`) who are assigned to 15 different campuses around the world just to test features, our logic naturally catches them as "Super Transfers".
- To fix this, we pass the final list through a Hardcoded Blocklist. If the student's login matches `tguiter`, `boulon`, `jiezhang`, etc., the script instantly drops them so they don't pollute your dashboard. *(Note: This is omitted in the simplified example script, but runs in production).*

### 6. Step Five: Saving to the Database
Finally, we take the clean list of actual transfer students and push them to your Supabase PostgreSQL database using Prisma. We use an "Upsert" command:
- If the student is already in the database, it **Updates** their status (e.g., moving them from IN PROCESS to COMPLETED).
- If the student is brand new, it **Inserts** them.

---

## 🪄 Do You Wanna Try This Magic?

If you have 42 API access and want to test the core logic yourself without setting up a database or running scripts, you can do it right in your terminal. Here is how to test the raw tracking logic from scratch:

### 1. Get Your Access Token
First, you need to generate a temporary token. Run this in your terminal (replace `YOUR_UID` and `YOUR_SECRET` with your actual 42 API app credentials):

```bash
curl -X POST https://api.intra.42.fr/oauth/token \
  -d "grant_type=client_credentials&client_id=YOUR_UID&client_secret=YOUR_SECRET"
```

### 2. Check a Student's Campus History
Now that you have your token, you can test the exact endpoint we use to find out if someone transferred. Replace `USER_LOGIN` with the login of a student you want to investigate:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  https://api.intra.42.fr/v2/users/USER_LOGIN/campus_users
```

If the array returned contains only Moroccan campus IDs (16, 21, 55, 75), they are still local. If you see foreign campus IDs in that array... the radar caught them!
