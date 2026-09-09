import prisma from "./prisma";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface Holder42 {
  id: number;
  login: string;
  displayname: string;
  image?: { link?: string };
  pool_month?: string;
  pool_year?: number;
  "staff?"?: boolean;
  kind?: string;
}

interface CampusUser {
  id: number;
  user_id: number;
  campus_id: number;
  is_primary: boolean;
}

interface GlobalCampus {
  id: number;
  name: string;
  country: string;
  city: string;
  isMorocco: boolean;
}

const CAMPUS_NAMES: Record<number, string> = {
  16: "Khouribga",
  21: "Benguerir",
  55: "Tétouan",
  75: "Rabat",
};

const MOROCCAN_CAMPUS_IDS = [16, 21, 55, 75];

const CAMPUS_MAX_PAGES: Record<number, number> = {
  16: 60,
  21: 50,
  55: 30,
  75: 10,
};

let cachedToken: { token: string; expires: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now()) {
    return cachedToken.token;
  }

  const response = await fetch("https://api.intra.42.fr/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.FORTY_TWO_CLIENT_ID!,
      client_secret: process.env.FORTY_TWO_CLIENT_SECRET!,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get access token: ${response.status} - ${body}`);
  }

  const data: TokenResponse = await response.json();
  cachedToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
}

async function fetchAllGlobalCampuses(token: string): Promise<Record<number, GlobalCampus>> {
  const map: Record<number, GlobalCampus> = {};
  let page = 1;
  let retries = 5;
  while (true) {
    const url = `https://api.intra.42.fr/v2/campus?per_page=100&page=${page}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 429) {
      if (retries <= 0) break;
      const retryAfter = response.headers.get("Retry-After");
      const sleepTime = retryAfter ? parseInt(retryAfter) * 1000 : 2000;
      console.log(`Rate limited on campuses. Waiting ${sleepTime}ms...`);
      await new Promise((r) => setTimeout(r, sleepTime));
      retries--;
      continue;
    }
    if (!response.ok) break;
    
    const campuses = await response.json();
    if (campuses.length === 0) break;
    
    for (const c of campuses) {
      map[c.id] = {
        id: c.id,
        name: c.name,
        country: c.country,
        city: c.city,
        isMorocco: c.country.toLowerCase() === 'morocco' || MOROCCAN_CAMPUS_IDS.includes(c.id)
      };
    }
    page++;
    await new Promise((r) => setTimeout(r, 550));
  }
  return map;
}

function extractPromo(user: Holder42): string | null {
  if (user.pool_year) {
    return user.pool_year.toString();
  }
  return null;
}

async function fetchPage(
  campusId: number,
  page: number,
  token: string
): Promise<Holder42[]> {
  const url = `https://api.intra.42.fr/v2/campus/${campusId}/users?per_page=100&page=${page}&filter[kind]=student`;
  
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After") || "2";
    console.log(`Rate limited on fetchPage for campus ${campusId} page ${page}. Waiting ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, parseInt(retryAfter) * 1000));
    return fetchPage(campusId, page, token);
  }

  if (!response.ok) {
    throw new Error(`API ${response.status} for campus ${campusId} page ${page}`);
  }

  return response.json();
}

async function fetchAllCampusUsers(
  campusId: number,
  token: string,
  maxPages: number
): Promise<Holder42[]> {
  const allUsers: Holder42[] = [];
  const CONCURRENCY = 1;

  for (let batch = 0; batch < maxPages; batch += CONCURRENCY) {
    const pages = Array.from(
      { length: Math.min(CONCURRENCY, maxPages - batch) },
      (_, i) => batch + i + 1
    );

    const results = await Promise.all(
      pages.map((p) => fetchPage(campusId, p, token))
    );

    let emptyBatch = false;
    for (const pageUsers of results) {
      if (pageUsers.length === 0) {
        emptyBatch = true;
        break;
      }
      
      const students = pageUsers.filter((u) => 
        u["staff?"] === false && 
        u.kind !== "admin"
      );
      allUsers.push(...students);
    }

    if (emptyBatch) break;
    await new Promise((r) => setTimeout(r, 550));
  }

  return allUsers;
}

// Returns a Map of user_id -> their destination { campusId, status }
async function findGlobalTransfers(
  userIds: number[],
  token: string,
  globalCampusesMap: Record<number, GlobalCampus>
): Promise<Map<number, { originCampusId: number; destCampusId: number; status: string }>> {
  const transferMap = new Map<number, { originCampusId: number; destCampusId: number; status: string }>();
  const chunkSize = 100;
  
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    let page = 1;
    const allCampusUsersForChunk: CampusUser[] = [];
    while (true) {
      const url = `https://api.intra.42.fr/v2/campus_users?filter[user_id]=${chunk.join(',')}&per_page=100&page=${page}`;
      let retries = 10;
      let success = false;
      let campusUsers: CampusUser[] = [];
      
      while (retries > 0) {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const sleepTime = retryAfter ? parseInt(retryAfter) * 1000 : 2000;
          console.log(`Rate limited on campus_users. Waiting ${sleepTime}ms...`);
          await new Promise((r) => setTimeout(r, sleepTime));
          retries--;
          continue;
        }
        if (!response.ok) {
          throw new Error(`API ${response.status} when filtering campus_users`);
        }
        
        campusUsers = await response.json();
        success = true;
        break; 
      }

      if (!success) throw new Error("Failed to fetch campus_users after retries");

      if (campusUsers.length === 0) break;
      
      allCampusUsersForChunk.push(...campusUsers);
      
      page++;
      await new Promise((r) => setTimeout(r, 550));
    }
    
    // Group ALL campus_users across all pages for this chunk by user_id
    const userCampuses = new Map<number, CampusUser[]>();
    for (const cu of allCampusUsersForChunk) {
      if (!userCampuses.has(cu.user_id)) {
        userCampuses.set(cu.user_id, []);
      }
      userCampuses.get(cu.user_id)!.push(cu);
    }
    
    for (const [userId, campuses] of Array.from(userCampuses.entries())) {
      // Sort campuses by ID ascending so the timeline is chronological
      campuses.sort((a, b) => a.id - b.id);
      
      // Find all their Moroccan campuses, sorted by creation timeline (id)
      const moroccanCampuses = campuses.filter(c => globalCampusesMap[c.campus_id]?.isMorocco);
      
      if (moroccanCampuses.length === 0) {
        continue;
      }

      // True origin is their most recent Moroccan campus before the transfer
      const originCampusId = moroccanCampuses[moroccanCampuses.length - 1].campus_id;

      // Current / Destination Campus: The campus where is_primary === true (or the most recently updated record).
      const currentCampus = campuses.find(c => c.is_primary) || campuses[campuses.length - 1];
      
      let destinationCampusId = -1;
      let transferStatus = "COMPLETED";

      if (!globalCampusesMap[currentCampus.campus_id]?.isMorocco) {
        destinationCampusId = currentCampus.campus_id;
        transferStatus = "COMPLETED";
      } else {
        // Look for ANY non-moroccan campus in history
        const anyForeignCampus = campuses.find(c => !globalCampusesMap[c.campus_id]?.isMorocco);
        if (anyForeignCampus) {
          destinationCampusId = anyForeignCampus.campus_id;
          transferStatus = "IN_PROCESS";
        }
      }
      
      if (destinationCampusId !== -1) {
        transferMap.set(userId, { 
          originCampusId,
          destCampusId: destinationCampusId, 
          status: transferStatus 
        });
      }
    }
    
    await new Promise((r) => setTimeout(r, 550)); 
  }
    // Guardrail: Verify the student is not staff (handled earlier, but we keep the structure for compatibility).
  const validTransfers = new Map<number, { originCampusId: number; destCampusId: number; status: string }>();
  const candidateIds = Array.from(transferMap.keys());
  for (let i = 0; i < candidateIds.length; i += chunkSize) {
    const chunk = candidateIds.slice(i, i + chunkSize);
    for (const userId of chunk) {
      validTransfers.set(userId, transferMap.get(userId)!);
    }
  }

  return validTransfers;
}

async function upsertHolders(
  holders: Holder42[],
  campusId: number,
  transfers: Map<number, { originCampusId: number; destCampusId: number; status: string }>,
  globalCampusesMap: Record<number, GlobalCampus>,
  token: string
): Promise<{ synced: number; errors: string[] }> {
  const errors: string[] = [];
  let synced = 0;
  let skipped = 0;
  const campusName = CAMPUS_NAMES[campusId] || `Campus ${campusId}`;

  for (const holder of holders) {
    try {
      const transferData = transfers.get(holder.id);
      if (!transferData || transferData.originCampusId !== campusId) {
        skipped++;
        continue;
      }

      const destCampusId = transferData.destCampusId;
      const transferStatus = transferData.status;

      let email = null;
      try {
        const userRes = await fetch(`https://api.intra.42.fr/v2/users/${holder.id}`, { headers: { Authorization: `Bearer ${token}` } });
        if (userRes.ok) {
          const userData = await userRes.json();
          email = userData.email || null;
        }
        await new Promise((r) => setTimeout(r, 550));
      } catch (err) {
        console.error(`Failed to fetch email for ${holder.login}:`, err);
      }

      const promo = extractPromo(holder);
      const destCampus = globalCampusesMap[destCampusId];
      const destCampusName = destCampus ? destCampus.name : `Campus ${destCampusId}`;
      const destCountry = destCampus ? destCampus.country : null;
      const destCity = destCampus ? destCampus.city : null;

      await prisma.transferStudent.upsert({
        where: { intraId: holder.id },
        update: {
          login: holder.login,
          displayName: holder.displayname,
          imageUrl: holder.image?.link || null,
          campusName,
          campusId,
          destinationCampusId: destCampusId,
          destinationCampusName: destCampusName,
          destinationCountry: destCountry,
          destinationCity: destCity,
          transferStatus,
          email,
          promo,
        },
        create: {
          intraId: holder.id,
          login: holder.login,
          displayName: holder.displayname,
          imageUrl: holder.image?.link || null,
          campusName,
          campusId,
          destinationCampusId: destCampusId,
          destinationCampusName: destCampusName,
          destinationCountry: destCountry,
          destinationCity: destCity,
          transferStatus,
          email,
          promo,
        },
      });
      synced++;
    } catch (error) {
      errors.push(`Failed to sync ${holder.login}: ${error}`);
    }
  }

  console.log(`Campus ${campusId}: ${synced} synced, ${skipped} skipped`);
  return { synced, errors };
}

export interface SyncResult {
  campusId: number;
  synced: number;
  errors: string[];
}

export async function runSync(campusIds: number[]): Promise<{
  success: boolean;
  synced: number;
  errors: string[];
  campuses: SyncResult[];
}> {
  const token = await getAccessToken();
  const globalCampusesMap = await fetchAllGlobalCampuses(token);
  
  const campusUsersMap = new Map<number, Holder42[]>();
  const allUserIds: number[] = [];

  // 1. Fetch all users from requested Moroccan campuses
  for (const campusId of campusIds) {
    const maxPages = CAMPUS_MAX_PAGES[campusId] || 10;
    const users = await fetchAllCampusUsers(campusId, token, maxPages);
    campusUsersMap.set(campusId, users);
    users.forEach(u => allUserIds.push(u.id));
    console.log(`Campus ${campusId}: ${users.length} total valid users fetched`);
  }

  // 2. Find globally transferred users
  console.log(`Checking ${allUserIds.length} Moroccan students for global transfers...`);
  const transfers = await findGlobalTransfers(allUserIds, token, globalCampusesMap);
  console.log(`Found ${transfers.size} globally transferred students!`);

  // 3. Upsert transferred users and clean up others
  const allResults: SyncResult[] = [];
  let totalSynced = 0;
  const allErrors: string[] = [];

  for (const campusId of campusIds) {
    const users = campusUsersMap.get(campusId) || [];
    const result = await upsertHolders(users, campusId, transfers, globalCampusesMap, token);
    totalSynced += result.synced;
    allErrors.push(...result.errors);
    allResults.push({ campusId, ...result });
  }

  // 4. Final DB Cleanup: delete any records in DB that are not in the current transfers map
  const validIntraIds = Array.from(transfers.keys());
  try {
    const deleteResult = await prisma.transferStudent.deleteMany({
      where: {
        campusId: { in: campusIds },
        intraId: { notIn: validIntraIds }
      }
    });
    console.log(`Cleaned up ${deleteResult.count} stale records from database.`);
  } catch (error) {
    console.error("Failed to clean up stale records:", error);
    allErrors.push(`Cleanup error: ${error}`);
  }

  return {
    success: allErrors.length === 0 || totalSynced > 0,
    synced: totalSynced,
    errors: allErrors,
    campuses: allResults
  };
}
